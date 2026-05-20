// workflow.fire — spawn another workflow execution and return immediately.
//
// Fire-and-forget semantics: the caller does NOT wait for, or see, the
// child's outcome. Use it for side-effect flows (audit logs, notifications,
// re-indexing, telemetry pipelines) where the parent shouldn't be blocked
// on a child it doesn't need a result from.
//
// To get results back, you'd need a synchronous workflow.run primitive
// (BullMQ FlowProducer with parent-child dependencies) — deliberately
// not built here; this fire-only variant is the cheap, safe entry point.
//
// Cycle / depth protection:
//   • Each spawn carries an _ancestors list on the queue payload tracking
//     graph_ids in the current chain.
//   • The plugin refuses to spawn into a graph_id already in the chain
//     (catches A → B → A loops).
//   • Hard cap at 10 levels of nesting catches non-cyclic chains that
//     are still pathological (e.g. a linear A → B → C → … → K).
//
// The worker's processExecution forwards _ancestors from job.data into
// ctx so nested fires can see it.

import { v4 as uuid } from "uuid";
import { pool } from "../../db/pool.js";
import { enqueueExecution } from "../../queue/queue.js";
import { assertIterationCap } from "../../engine/limits.js";
import { normalizeTags } from "../../utils/tags.js";

const MAX_DEPTH = 10;

export default {
  name: "workflow.fire",
  description:
    "Spawn another workflow execution and return its id immediately " +
    "(fire-and-forget). The caller does NOT wait for the spawned flow. " +
    "Use for side-effect flows like audit logs / notifications / " +
    "indexing where you don't need the result back.",

  inputSchema: {
    type: "object",
    required: ["workflowId"],
    properties: {
      workflowId: {
        type: "string",
        title: "Workflow ID",
        minLength: 1,
        description:
          "UUID of the workflow to spawn. Find this in the URL of the " +
          "FlowDesigner page or via GET /graphs.",
      },
      // Type-less so the property panel renders a single-line text input
      // for ${var} references. Resolves to whatever the user supplies.
      input: {
        title: "Input",
        placeholder: "${context}",
        description:
          "Object passed as the child's run input. Becomes the child's " +
          "ctx.data root and is stored on its executions.inputs row.",
      },
      // String list, rendered as a chip-style list editor by the
      // property panel (array<string> → ui_type "list"). Tags are
      // stamped onto the child's executions.tags row so flows that
      // fan out can group their children for later filtering.
      tags: {
        type: "array",
        items: { type: "string" },
        title: "Tags",
        description:
          "Optional tags to stamp on the spawned child execution. " +
          "Useful for grouping fan-out children with a shared marker " +
          "(e.g. [\"run-2026-05-18\", \"reprocess\"]).",
      },
    },
  },

  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "executionId",

  outputSchema: {
    type: "object",
    required: ["executionId", "workflowId"],
    properties: {
      executionId: {
        type: "string",
        description: "Id of the spawned child execution. Use it to navigate " +
          "to /instanceViewer/<id> for status, or poll /executions/<id>.",
      },
      workflowId:  { type: "string" },
    },
  },

  async execute(input, ctx, hooks) {
    const ancestors = Array.isArray(ctx?._ancestors) ? ctx._ancestors : [];

    if (ancestors.length >= MAX_DEPTH) {
      throw new Error(
        `workflow.fire: spawn chain too deep (${ancestors.length} levels). ` +
        `If you need this, raise MAX_DEPTH in workflow.fire — but ` +
        `consider whether the design is right first.`,
      );
    }
    if (ancestors.includes(input.workflowId)) {
      throw new Error(
        `workflow.fire: cycle detected — workflow ${input.workflowId} ` +
        `is already in this spawn chain (${ancestors.join(" → ")}).`,
      );
    }

    // Fan-out cap: a single execution can spawn at most
    // EXECUTION_MAX_ITERATIONS children. Depth cap catches LINEAR
    // chains; this catches WIDE chains — a node that fires 50k
    // times in a loop. The counter lives on ctx (underscore-prefixed
    // so it's redacted from persisted ctx). `null` for parsed means
    // we honor the env default; workflow-level maxIterations applies
    // to batch fan-out (which has direct access to parsed) — wiring
    // it through to plugins would require threading parsed onto ctx
    // and isn't worth the extra surface for this niche case.
    ctx._fireCount = (ctx._fireCount || 0) + 1;
    assertIterationCap(null, ctx._fireCount, "workflow.fire");

    // Verify the target workflow exists, isn't soft-deleted, lives in
    // the same workspace as the parent, AND — per RBAC v2 — either
    // shares the parent's project or has an explicit cross-project
    // grant (cross_project_call_grants). Cross-workspace spawns are
    // always refused; cross-project ones are gated by the grant.
    const parentWorkspaceId = ctx?.execution?.workspaceId || null;
    const parentProjectId   = ctx?.execution?.projectId   || null;
    const { rows } = await pool.query(
      `SELECT id, name, workspace_id, project_id FROM graphs
        WHERE id=$1 AND deleted_at IS NULL`,
      [input.workflowId],
    );
    if (rows.length === 0) {
      throw new Error(`workflow.fire: workflow ${input.workflowId} not found or deleted`);
    }
    const childName        = rows[0].name;
    const childWorkspaceId = rows[0].workspace_id;
    const childProjectId   = rows[0].project_id;
    if (parentWorkspaceId && childWorkspaceId !== parentWorkspaceId) {
      throw new Error(
        `workflow.fire: workflow ${input.workflowId} lives in a different ` +
        `workspace and cannot be spawned from this run.`,
      );
    }
    // Cross-project gate. Same-project calls (the common case) skip
    // the lookup entirely. Calls from a parent with no project context
    // (legacy executions from pre-RBAC-v2 rows) are treated as same-
    // project so they don't break — the migration backfilled their
    // project_id, so this path is only for in-flight execs straddling
    // the upgrade.
    if (parentProjectId && parentProjectId !== childProjectId) {
      const { rowCount: granted } = await pool.query(
        `SELECT 1 FROM cross_project_call_grants
          WHERE caller_project_id = $1 AND callee_project_id = $2`,
        [parentProjectId, childProjectId],
      );
      if (!granted) {
        throw new Error(
          `workflow.fire: workflow "${childName}" lives in a different ` +
          `project and this project hasn't been granted permission to ` +
          `call into it. Ask a workspace admin to add a cross-project ` +
          `grant at /cross-project-grants.`,
        );
      }
    }

    // Allocate the child execution row + enqueue. Same shape that
    // /graphs/:id/execute uses, plus the `_ancestors` list so nested
    // fires from inside the child can keep enforcing depth + cycle limits.
    //
    // RBAC v2: the child execution belongs to the CHILD's project, not
    // the caller's. That matches the principle that "executions live
    // where their workflow lives" — same way quotas, audit, and config
    // resolution will see the run.
    //
    // Quota: refuse the spawn when the CALLEE's project is out of
    // daily budget. Late-import to avoid the engine/auth cycle.
    if (childProjectId) {
      try {
        const { assertQuota } = await import("../../auth/quotas.js");
        await assertQuota(childProjectId, "executions_per_day");
      } catch (e) {
        if (e?.code === "QUOTA_EXCEEDED") throw e;
        // Other failures fall through — metering shouldn't fail runs.
      }
    }

    const childId    = uuid();
    const childInput = (input.input && typeof input.input === "object") ? input.input : {};
    const childTags  = normalizeTags(input.tags);
    await pool.query(
      `INSERT INTO executions (id, graph_id, status, inputs, context,
                                workspace_id, project_id, tags)
       VALUES ($1,$2,'queued',$3,'{}'::jsonb,$4,$5,$6)`,
      [childId, input.workflowId, JSON.stringify(childInput),
       childWorkspaceId, childProjectId, childTags],
    );
    if (childProjectId) {
      import("../../auth/quotas.js")
        .then(({ incrementUsage }) => incrementUsage(childProjectId, "executions_per_day", 1))
        .catch(() => { /* metering best-effort */ });
    }

    // Build the new ancestors list. The current execution's graphId is
    // appended (so a nested fire detects "we already came from there"),
    // not the parent's executionId — the cycle check is on workflow
    // *definitions*, not on individual runs.
    const nextAncestors = [...ancestors];
    if (ctx?.execution?.graphId && !nextAncestors.includes(ctx.execution.graphId)) {
      nextAncestors.push(ctx.execution.graphId);
    }
    await enqueueExecution({
      executionId: childId,
      graphId:     input.workflowId,
      _ancestors:  nextAncestors,
    });

    if (hooks?.stream?.log) {
      hooks.stream.log(
        "info",
        `spawned workflow "${childName}" as execution ${childId.slice(0, 8)}…`,
      );
    }
    return { executionId: childId, workflowId: input.workflowId };
  },
};
