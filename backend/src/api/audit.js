// Audit log read API — admin only, workspace-scoped.
//
//   GET /audit?action=auth.login&actor=user-id&from=ISO&to=ISO&limit=100
//
// Filters are all optional + combine with AND. The endpoint returns
// newest-first up to `limit` rows (capped at 500 to bound response
// size). Pagination is offset-based via `before=<id>` — pass the
// last row's id to fetch the next page.
//
// No write endpoints. Audit rows are insert-only by convention; the
// retention runner is the only thing that ever DELETEs from this
// table.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireUser, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireUser);
router.use(requireRole("admin"));

router.get("/", async (req, res, next) => {
  try {
    const params = [req.user.workspaceId];
    const where  = ["(workspace_id = $1 OR workspace_id IS NULL)"];

    if (req.query.action) {
      params.push(req.query.action);
      where.push(`action = $${params.length}`);
    }
    if (req.query.actor) {
      params.push(req.query.actor);
      where.push(`(actor_id::text = $${params.length} OR actor_email = $${params.length})`);
    }
    if (req.query.resourceType) {
      params.push(req.query.resourceType);
      where.push(`resource_type = $${params.length}`);
    }
    if (req.query.resourceId) {
      params.push(req.query.resourceId);
      where.push(`resource_id = $${params.length}`);
    }
    if (req.query.outcome) {
      params.push(req.query.outcome);
      where.push(`outcome = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      where.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      where.push(`created_at <= $${params.length}::timestamptz`);
    }
    if (req.query.before) {
      // Cursor pagination on (created_at, id). Caller passes the
      // last row's id from the previous page; we look it up and
      // fetch everything strictly older.
      params.push(req.query.before);
      where.push(`(created_at, id) < (
        SELECT created_at, id FROM audit_logs WHERE id = $${params.length}::uuid
      )`);
    }

    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
    params.push(limit);

    // actor_kind + project_id are projected so workflow-emitted rows
    // (actor_kind = 'workflow', written by the audit.record plugin) are
    // distinguishable from human + service-account ones. Without the
    // column on the response the admin UI couldn't render that filter,
    // and the e2e suite couldn't assert on the kind.
    const { rows } = await pool.query(
      `SELECT id, workspace_id, project_id, actor_id, actor_email, actor_role, actor_kind,
              action, resource_type, resource_id, resource_name,
              outcome, metadata, ip::text AS ip, user_agent, trace_id,
              created_at
         FROM audit_logs
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({
      rows,
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  } catch (e) { next(e); }
});

export default router;
