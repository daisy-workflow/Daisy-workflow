// Graphs API — single-row workflows + explicit archive.
//
// Versioning was removed in migration 008. The `id` is stable across
// saves, so URLs like /flowDesigner/<id> stay valid forever. Old saves
// don't accumulate as new rows; users keep snapshots by hitting the
// Archive button, which copies the current state into archived_graphs.
//
// Auth model (PR 2):
//   • Every route requires a logged-in caller (requireUser).
//   • Read routes  — admin, editor, viewer.
//   • Write routes (POST/PUT/DELETE/execute/archive) — admin, editor.
//   • Workspace scoping — every query carries
//     `workspace_id = req.user.workspaceId` so a caller can only
//     see / mutate graphs in their active workspace. The DB-level
//     NOT NULL constraint is the fail-safe.
//
// Endpoints:
//   GET    /graphs                              list live workflows
//   GET    /graphs/:id                          full live row
//   POST   /graphs                              create
//   PUT    /graphs/:id                          in-place update
//   DELETE /graphs/:id                          soft delete
//   POST   /graphs/validate                     parse + validate without saving
//   POST   /graphs/:id/execute                  enqueue an execution
//
//   POST   /graphs/:id/archives                 snapshot
//   GET    /graphs/:id/archives                 list snapshots
//   GET    /graphs/:id/archives/:archiveId      one snapshot
//   POST   /graphs/:id/archives/:archiveId/restore

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool, withTx } from "../db/pool.js";
import { parseDag } from "../dsl/parser.js";
import { enqueueExecution } from "../queue/queue.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { limiters } from "../middleware/rateLimit.js";
import { auditLog } from "../audit/log.js";
import { normalizeTags } from "../utils/tags.js";

// `dsl` is the canonical body field. Older clients still posting `yaml`
// keep working — we accept either here and treat the contents as JSON.
function readDsl(body) {
  return body?.dsl ?? body?.yaml ?? null;
}

const router = Router();

// Every route in this file is gated. Auth runs first; per-route
// requireRole(...) below enforces the read/write split.
router.use(requireUser);

// ──────────────────────────────────────────────────────────────────────
// Live workflows
// ──────────────────────────────────────────────────────────────────────

router.get("/", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    // JOIN users so the list response carries who last edited the row.
    // Editor's email is the simplest fallback when display_name is null.
    const { rows } = await pool.query(`
      SELECT g.id, g.name, g.created_at, g.updated_at,
             g.updated_by,
             COALESCE(u.display_name, u.email) AS updated_by_email
        FROM graphs g
        LEFT JOIN users u ON u.id = g.updated_by
       WHERE g.deleted_at IS NULL AND g.workspace_id = $1
       ORDER BY g.name
    `, [req.user.workspaceId]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.*, COALESCE(u.display_name, u.email) AS updated_by_email
         FROM graphs g
         LEFT JOIN users u ON u.id = g.updated_by
        WHERE g.id=$1 AND g.workspace_id=$2 AND g.deleted_at IS NULL`,
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("graph");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post("/validate", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const dsl = readDsl(req.body);
    if (!dsl) throw new ValidationError("dsl field required");
    const parsed = parseDag(dsl);
    res.json({ valid: true, parsed });
  } catch (e) { next(e); }
});

router.post("/", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const dsl = readDsl(req.body);
    if (!dsl) throw new ValidationError("dsl field required");
    const parsed = parseDag(dsl);

    const id = uuid();
    try {
      await pool.query(
        `INSERT INTO graphs (id, name, dsl, parsed, workspace_id, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, parsed.name, dsl, JSON.stringify(parsed), req.user.workspaceId, req.user.id],
      );
    } catch (e) {
      // Unique-name conflict — the partial unique index added by 008
      // covers WHERE deleted_at IS NULL, so old soft-deleted names are fine.
      if (e.code === "23505") {
        throw new ValidationError(`a workflow named "${parsed.name}" already exists`);
      }
      throw e;
    }
    await auditLog({
      req, action: "graph.create",
      resource: { type: "graph", id, name: parsed.name },
    });
    res.status(201).json({ id, name: parsed.name });
  } catch (e) { next(e); }
});

router.put("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const dsl = readDsl(req.body);
    if (!dsl) throw new ValidationError("dsl field required");
    const parsed = parseDag(dsl);

    const { rows: existing } = await pool.query(
      "SELECT name FROM graphs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
      [req.params.id, req.user.workspaceId],
    );
    if (existing.length === 0) throw new NotFoundError("graph");
    if (existing[0].name !== parsed.name) {
      throw new ValidationError(
        `graph name mismatch: existing="${existing[0].name}", dsl="${parsed.name}"`
      );
    }

    await pool.query(
      `UPDATE graphs
          SET dsl = $2,
              parsed = $3,
              updated_at = NOW(),
              updated_by = $5
        WHERE id = $1 AND workspace_id = $4`,
      [req.params.id, dsl, JSON.stringify(parsed), req.user.workspaceId, req.user.id],
    );
    await auditLog({
      req, action: "graph.update",
      resource: { type: "graph", id: req.params.id, name: parsed.name },
    });
    res.json({ id: req.params.id, name: parsed.name });
  } catch (e) { next(e); }
});

router.delete("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE graphs SET deleted_at=NOW()
        WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.user.workspaceId],
    );
    if (rowCount === 0) throw new NotFoundError("graph");
    await auditLog({
      req, action: "graph.delete",
      resource: { type: "graph", id: req.params.id },
    });
    res.status(200).json({ ok: true, id: req.params.id, deleted: "graph" });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// Archives
//
// `archived_graphs` doesn't carry workspace_id directly — every row
// references its source graph via `source_id`. We always check that
// the source graph lives in the caller's workspace before exposing
// or mutating its archive rows. One subquery per call is the cost.
// ──────────────────────────────────────────────────────────────────────

router.get("/:id/archives", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    if (!await graphInWorkspace(req.params.id, req.user.workspaceId)) {
      throw new NotFoundError("graph");
    }
    const { rows } = await pool.query(
      `SELECT id, name, archived_at, reason
         FROM archived_graphs
        WHERE source_id = $1
        ORDER BY archived_at DESC
        LIMIT 200`,
      [req.params.id],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id/archives/:archiveId", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    if (!await graphInWorkspace(req.params.id, req.user.workspaceId)) {
      throw new NotFoundError("graph");
    }
    const { rows } = await pool.query(
      `SELECT *
         FROM archived_graphs
        WHERE id = $1 AND source_id = $2`,
      [req.params.archiveId, req.params.id],
    );
    if (rows.length === 0) throw new NotFoundError("archive");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post("/:id/archives", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const reason = (req.body?.reason ? String(req.body.reason) : "").slice(0, 200) || null;

    const { rows } = await pool.query(
      `SELECT name, dsl, parsed FROM graphs
        WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("graph");
    const g = rows[0];

    const archiveId = uuid();
    await pool.query(
      `INSERT INTO archived_graphs (id, source_id, name, dsl, parsed, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [archiveId, req.params.id, g.name, g.dsl, g.parsed, reason],
    );
    res.status(201).json({ archiveId });
  } catch (e) { next(e); }
});

router.post("/:id/archives/:archiveId/restore", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    await withTx(async (c) => {
      // First — make sure the live graph belongs to the caller. Rest
      // of the work happens inside this same transaction so any
      // failure after the source check rolls back cleanly.
      const { rows: live } = await c.query(
        `SELECT name FROM graphs
          WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
        [req.params.id, req.user.workspaceId],
      );
      if (live.length === 0) throw new NotFoundError("graph");

      const { rows: arch } = await c.query(
        "SELECT name, dsl, parsed FROM archived_graphs WHERE id=$1 AND source_id=$2",
        [req.params.archiveId, req.params.id],
      );
      if (arch.length === 0) throw new NotFoundError("archive");

      if (live[0].name !== arch[0].name) {
        throw new ValidationError("name mismatch between archive and live graph");
      }

      await c.query(
        `UPDATE graphs
            SET dsl = $2,
                parsed = $3,
                updated_at = NOW(),
                updated_by = $5
          WHERE id = $1 AND workspace_id = $4`,
        [req.params.id, arch[0].dsl, arch[0].parsed, req.user.workspaceId, req.user.id],
      );
    });
    res.json({ ok: true, id: req.params.id });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// Execution
// ──────────────────────────────────────────────────────────────────────

router.post("/:id/execute", limiters.execute, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM graphs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("graph");

    const execId = uuid();
    const userInput = req.body?.context || {};
    // Tags arrive on the manual-run path from the Run dialog. Body
    // shape: { context, tags: ["release", "manual"] }. Empty/invalid
    // values are dropped by normalizeTags — the row gets [] either way.
    const tags = normalizeTags(req.body?.tags);
    await pool.query(
      `INSERT INTO executions (id, graph_id, status, inputs, context, workspace_id, tags)
       VALUES ($1,$2,'queued',$3,'{}'::jsonb,$4,$5)`,
      [execId, req.params.id, JSON.stringify(userInput), req.user.workspaceId, tags],
    );
    await enqueueExecution({ executionId: execId, graphId: req.params.id });
    await auditLog({
      req, action: "graph.execute",
      resource: { type: "graph", id: req.params.id },
      metadata: { executionId: execId },
    });
    res.status(202).json({ executionId: execId, status: "queued" });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

/** True if a graph row exists in the given workspace + isn't soft-deleted. */
async function graphInWorkspace(graphId, workspaceId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM graphs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
    [graphId, workspaceId],
  );
  return rows.length > 0;
}

export default router;
