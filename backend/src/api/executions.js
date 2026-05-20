import { Router } from "express";
import { pool } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { enqueueExecution } from "../queue/queue.js";
import { resetNodeForReplay, upsertNodeState } from "../engine/nodeStateStore.js";
import { requireUser, requireRole, requireProject } from "../middleware/auth.js";
import { diagnoseExecution } from "../selfheal/diagnose.js";
import { auditLog } from "../audit/log.js";
import { normalizeTags } from "../utils/tags.js";

const router = Router();

// Auth model:
//   • Reads (list/get)                       — admin, editor, viewer.
//   • Mutations (resume/skip/respond/delete) — admin, editor.
//                                              Viewers can read but not
//                                              steer in-flight runs.
//   • Workspace scoping                      — every query carries
//                                              workspace_id of the
//                                              caller; node_states is
//                                              gated through its
//                                              parent execution.
router.use(requireUser);
router.use(requireProject);

router.get("/", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { graphId, status, tags, limit = 50 } = req.query;
    const params = [req.user.workspaceId, req.user.projectId];  // $1, $2
    const where = ["e.workspace_id = $1", "e.project_id = $2"];
    if (graphId) {
      params.push(graphId);
      where.push(`graph_id=$${params.length}`);
    }
    // Comma-separated list, e.g. ?status=running,queued
    if (status) {
      const wanted = String(status)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      if (wanted.length) {
        params.push(wanted);
        where.push(`status = ANY($${params.length})`);
      }
    }
    // Tag filter — overlap semantics (`tags && ARRAY[...]`) so a row
    // matches when ANY of the requested tags is present. Empty/invalid
    // tag values are dropped by normalizeTags. The query uses the GIN
    // index on executions.tags so it stays sub-millisecond at scale.
    const tagList = normalizeTags(tags);
    if (tagList.length) {
      params.push(tagList);
      where.push(`e.tags && $${params.length}::text[]`);
    }
    params.push(Math.min(parseInt(limit, 10) || 50, 200));
    const whereSql = `WHERE ${where.join(" AND ")}`;
    // graphs lost its `version` column when the schema flipped to single-row
    // workflows (migration 008). The Inspector formats the workflow column
    // from `graph_name` only now; if anything else still expects
    // `graph_version`, it'll just see undefined.
    const { rows } = await pool.query(
      `SELECT e.id, e.graph_id, e.status, e.started_at, e.finished_at, e.created_at, e.error,
              e.tags,
              g.name AS graph_name
       FROM executions e
       LEFT JOIN graphs g ON g.id = e.graph_id
       ${whereSql}
       ORDER BY e.created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { rows: execs } = await pool.query(
      "SELECT * FROM executions WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (execs.length === 0) throw new NotFoundError("execution");

    // Pull the durable per-node state so the InstanceViewer can offer
    // resume/skip/edit on the failed nodes. The engine also writes a
    // post-run summary to executions.context.nodes, but that's only
    // populated at the END of a run — node_states is the live truth.
    //
    // Tolerant of a missing table (42P01): if migration 010 hasn't run
    // yet, fall back to an empty list. The InstanceViewer will then
    // synthesize failed-node entries from the run's context.nodes
    // summary so users with existing runs still see the recovery UI.
    let nodeStates = [];
    try {
      const r = await pool.query(
        `SELECT node_name, status, attempts, resolved_inputs, output, error,
                reason, started_at, finished_at, updated_at
           FROM node_states WHERE execution_id=$1
           ORDER BY started_at NULLS LAST, node_name`,
        [req.params.id],
      );
      nodeStates = r.rows;
    } catch (e) {
      if (e.code !== "42P01") throw e;
      // Table missing — soft-fail, see comment above.
    }

    // Fold in a cached self-heal diagnosis if one exists, so the
    // InstanceViewer can render it without a second round-trip.
    // Migration 017 created this table; tolerate its absence so
    // pre-017 deployments still serve executions.
    let diagnosis = null;
    try {
      const r = await pool.query(
        `SELECT execution_id, confidence, category, root_cause,
                recommended_actions, evidence, model, input_tokens,
                output_tokens, status, error, created_at
           FROM execution_diagnoses WHERE execution_id = $1`,
        [req.params.id],
      );
      diagnosis = r.rows[0] || null;
    } catch (e) {
      if (e.code !== "42P01") throw e;
    }

    res.json({ ...execs[0], node_states: nodeStates, diagnosis });
  } catch (e) { next(e); }
});

/**
 * POST /executions/:id/resume
 *
 * Re-run a failed execution. Optional body:
 *   {
 *     "node":   "<failed-node-name>",
 *     "inputs": { … }            // overrides for that node only
 *   }
 *
 * Behaviour:
 *   1. The named failed node (or the first failed one if `node` omitted)
 *      and every downstream node currently marked failed/skipped is reset
 *      back to `pending` so the executor's resume path will run them.
 *   2. Already-success nodes upstream are kept as-is (their outputs feed
 *      back into ctx via the executor's rehydration loop).
 *   3. If `inputs` is supplied, they're stashed in node_states.resolved_inputs
 *      AND passed as an inputsOverride on the queue payload so the executor
 *      uses them verbatim instead of re-resolving the original ${...} template.
 *   4. Re-enqueues the same executionId. The worker detects resume mode by
 *      finding existing node_states rows.
 */
router.post("/:id/resume", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, graph_id, status FROM executions WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("execution");
    const exec = rows[0];
    if (exec.status === "running" || exec.status === "queued") {
      throw new ValidationError(`execution is ${exec.status}; cannot resume an in-flight run`);
    }

    const targetNode  = req.body?.node || null;
    const inputs      = req.body?.inputs ?? null;
    const inputsOverride = {};

    // Decide which nodes to reset back to pending. Strategy: pick the
    // failed node the user is replaying (or the only failed one), plus
    // every node currently marked skipped (most likely cascade-skipped
    // dependents of the failure) — those should re-run too once their
    // upstream dependency succeeds.
    let nodeToReset = targetNode;
    if (!nodeToReset) {
      const { rows: f } = await pool.query(
        "SELECT node_name FROM node_states WHERE execution_id=$1 AND status='failed' ORDER BY finished_at ASC LIMIT 1",
        [req.params.id],
      );
      if (f.length === 0) {
        throw new ValidationError("no failed node to resume from");
      }
      nodeToReset = f[0].node_name;
    }
    await resetNodeForReplay(req.params.id, nodeToReset, "pending");
    // Note: we no longer reset every existing `skipped` row. The engine
    // doesn't pre-emptively skip downstream nodes on terminate any more
    // (they stay pending), so the only `skipped` rows remaining are
    // either user-initiated skips or executeIf=false / cascade decisions
    // — both should be preserved across a resume so the user's previous
    // recovery choices stick.

    if (inputs && typeof inputs === "object") {
      inputsOverride[nodeToReset] = inputs;
      await upsertNodeState(req.params.id, nodeToReset, {
        status: "pending",
        resolvedInputs: inputs,
      });
    }

    await pool.query(
      `UPDATE executions
          SET status      = 'queued',
              error       = NULL,
              finished_at = NULL
        WHERE id = $1`,
      [req.params.id],
    );
    await enqueueExecution({
      executionId: req.params.id,
      graphId:     exec.graph_id,
      inputsOverride,
    });
    res.status(202).json({ id: req.params.id, status: "queued", resumedFrom: nodeToReset });
  } catch (e) { next(e); }
});

/**
 * POST /executions/:id/skip
 *
 * Mark a failed node `skipped` (so the engine's skip-cascade marks every
 * descendant skipped on resume) and re-enqueue. Useful when the user
 * decides the failed step isn't required — e.g. a flaky email send that
 * shouldn't block the rest of the workflow.
 */
router.post("/:id/skip", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const node = req.body?.node;
    if (!node) throw new ValidationError("body.node is required");

    const { rows } = await pool.query(
      "SELECT id, graph_id, status FROM executions WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("execution");
    const exec = rows[0];
    if (exec.status === "running" || exec.status === "queued") {
      throw new ValidationError(`execution is ${exec.status}; cannot edit an in-flight run`);
    }
    await resetNodeForReplay(req.params.id, node, "skipped");
    // Descendants are already PENDING (the executor leaves unrun nodes
    // pending on terminate-failure), so we don't need to preemptively
    // touch them here. On resume, the cascade in runOne marks them
    // SKIPPED as their now-skipped parent gets hydrated.
    await pool.query(
      `UPDATE executions SET status='queued', error=NULL, finished_at=NULL WHERE id=$1`,
      [req.params.id],
    );
    await enqueueExecution({ executionId: req.params.id, graphId: exec.graph_id });
    res.status(202).json({ id: req.params.id, status: "queued", skippedNode: node });
  } catch (e) { next(e); }
});

/**
 * POST /executions/:id/nodes/:nodeName/respond
 *
 * Resolve a waiting `user` plugin node. The request body becomes the
 * node's `output.data`; the row's status flips to success and the
 * execution is re-enqueued. The worker's resume path replays the
 * node's outputs (mapping + outputVar) so descendants can read the
 * posted JSON.
 *
 * Body shapes accepted:
 *   • { data: <anything> }   — explicit (recommended)
 *   • <anything-else>        — the whole body becomes `data`
 *
 * The endpoint is idempotent against the same payload but rejects
 * responses to nodes that aren't currently waiting (e.g. already
 * resumed, never waited, or the execution itself was deleted).
 */
router.post("/:id/nodes/:nodeName/respond", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { id, nodeName } = req.params;
    const body = req.body;
    const data = (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "data"))
      ? body.data
      : body;

    const { rows: execs } = await pool.query(
      "SELECT id, graph_id, status FROM executions WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
      [id, req.user.workspaceId, req.user.projectId],
    );
    if (execs.length === 0) throw new NotFoundError("execution");
    const exec = execs[0];

    const { rows: states } = await pool.query(
      "SELECT status FROM node_states WHERE execution_id=$1 AND node_name=$2",
      [id, nodeName],
    );
    if (states.length === 0) throw new NotFoundError(`node ${nodeName}`);
    if (states[0].status !== "waiting") {
      throw new ValidationError(`node "${nodeName}" is not waiting (status=${states[0].status})`);
    }

    // Mark the node success with the posted JSON as its output. The
    // resume path's rehydration loop replays this through outputs:/
    // outputVar so downstream nodes can read it as ${<var>}.
    const respondedAt = new Date().toISOString();
    const output = { data, respondedAt };
    await upsertNodeState(id, nodeName, {
      status:      "success",
      output,
      finishedAt:  respondedAt,
    });

    // Flip the execution row back to queued and re-enqueue. The worker
    // sees existing node_states rows and enters resume mode.
    await pool.query(
      `UPDATE executions SET status='queued', error=NULL, finished_at=NULL WHERE id=$1`,
      [id],
    );
    await enqueueExecution({ executionId: id, graphId: exec.graph_id });

    res.status(202).json({ id, node: nodeName, status: "queued" });
  } catch (e) { next(e); }
});

/**
 * POST /executions/:id/diagnose
 *
 * Self-heal Tier 2 — produce (or fetch cached) LLM analysis of a
 * failed execution. Admin + editor only; workspace-scoped.
 *
 * Query:
 *   ?force=1   re-run the LLM even when a diagnosis is already cached
 *
 * Response shape:
 *   { cached: bool, diagnosis: {
 *       execution_id, workspace_id, confidence, category,
 *       root_cause, recommended_actions, evidence,
 *       model, input_tokens, output_tokens,
 *       status, error, created_at
 *   } }
 */
router.post("/:id/diagnose", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    // Cheap workspace check up-front — bail before calling out to the
    // LLM if the execution isn't ours.
    const { rows } = await pool.query(
      "SELECT id, status FROM executions WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("execution");

    const force = req.query.force === "1" || req.query.force === "true";
    const { cached, diagnosis } = await diagnoseExecution(req.params.id, {
      actor: req.user,
      force,
    });
    // Audit the action so the trail shows who asked the LLM about
    // which failure. Useful when investigating "who triggered the
    // bot-driven explanation that led to that action."
    await auditLog({
      req, action: "selfheal.diagnose",
      resource: { type: "execution", id: req.params.id },
      metadata: { cached, regenerated: force, category: diagnosis?.category },
    });
    res.json({ cached, diagnosis });
  } catch (e) { next(e); }
});

/** DELETE /executions/:id — remove an execution row. */
router.delete("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM executions WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rowCount === 0) throw new NotFoundError("execution");
    res.status(200).json({ ok: true, id: req.params.id, deleted: "execution" });
  } catch (e) { next(e); }
});

export default router;
