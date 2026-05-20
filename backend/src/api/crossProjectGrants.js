// Cross-project workflow.fire grants — workspace-admin only.
//
// Each row is a directed "project A may workflow.fire into project B"
// permission. Same-project calls don't need a row (skipped at the
// workflow.fire plugin's gate). There's no symmetric implication —
// granting A→B does NOT grant B→A.
//
// Endpoints:
//   GET    /cross-project-grants           list all grants in the workspace
//   POST   /cross-project-grants           body: { callerProjectId, calleeProjectId }
//   DELETE /cross-project-grants           body: { callerProjectId, calleeProjectId }
//                                          (composite PK — no single-id form)
//
// All gated on `cross_project.grant` (workspace admin).

import { Router } from "express";
import { pool } from "../db/pool.js";
import {
  ValidationError, NotFoundError, ConflictError,
} from "../utils/errors.js";
import { requireUser } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);

// ────────────────────────────────────────────────────────────────────
// GET / — list every grant whose caller AND callee live in this
// workspace. Cross-workspace grants don't exist by schema (the FK
// chain to projects → workspaces guarantees both ends are in some
// workspace; we filter to the caller's).
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("cross_project.grant"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT g.caller_project_id,
                g.callee_project_id,
                g.created_at,
                pc.name AS caller_name,
                pe.name AS callee_name,
                COALESCE(u.display_name, u.email) AS granted_by_email
           FROM cross_project_call_grants g
           JOIN projects pc ON pc.id = g.caller_project_id
           JOIN projects pe ON pe.id = g.callee_project_id
           LEFT JOIN users u ON u.id = g.granted_by
          WHERE pc.workspace_id = $1
            AND pe.workspace_id = $1
            AND pc.deleted_at IS NULL
            AND pe.deleted_at IS NULL
          ORDER BY pc.name, pe.name`,
        [req.user.workspaceId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// POST / — grant caller → callee. Both must be projects in the
// caller's workspace. Self-grants are rejected by the table's CHECK
// constraint (caller_project_id <> callee_project_id), but we
// pre-check here for a friendlier 400 message.
// ────────────────────────────────────────────────────────────────────
router.post("/",
  requirePermission("cross_project.grant"),
  async (req, res, next) => {
    try {
      const { callerProjectId, calleeProjectId } = req.body || {};
      if (!callerProjectId || !calleeProjectId) {
        throw new ValidationError("callerProjectId and calleeProjectId are required");
      }
      if (callerProjectId === calleeProjectId) {
        throw new ValidationError("a project can already call its own workflows — no grant needed");
      }

      // Both ends must live in the caller's workspace. One round trip
      // for both checks keeps the API responsive.
      const { rows: ps } = await pool.query(
        `SELECT id FROM projects
          WHERE id IN ($1, $2)
            AND workspace_id = $3
            AND deleted_at IS NULL`,
        [callerProjectId, calleeProjectId, req.user.workspaceId],
      );
      if (ps.length !== 2) {
        throw new NotFoundError("one or both projects (not found in this workspace)");
      }

      try {
        await pool.query(
          `INSERT INTO cross_project_call_grants
             (caller_project_id, callee_project_id, granted_by)
           VALUES ($1, $2, $3)`,
          [callerProjectId, calleeProjectId, req.user.id],
        );
      } catch (e) {
        if (e.code === "23505") throw new ConflictError("this grant already exists");
        throw e;
      }
      await auditLog({
        req, action: "cross_project.grant",
        resource: { type: "cross_project_grant", id: `${callerProjectId}->${calleeProjectId}` },
        metadata: { callerProjectId, calleeProjectId },
      });
      res.status(201).json({ callerProjectId, calleeProjectId });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// DELETE / — revoke. The composite PK makes a single-id DELETE
// route awkward; we accept both ids in the body and the URL stays
// stable. Returns 200 even when the row is already absent — revoke
// is idempotent (no benefit to surfacing "you tried to revoke
// something that wasn't granted").
// ────────────────────────────────────────────────────────────────────
router.delete("/",
  requirePermission("cross_project.grant"),
  async (req, res, next) => {
    try {
      const { callerProjectId, calleeProjectId } = req.body || {};
      if (!callerProjectId || !calleeProjectId) {
        throw new ValidationError("callerProjectId and calleeProjectId are required");
      }
      // Belt-and-braces: refuse the cross-workspace shenanigan even
      // though the row wouldn't be returned by the list. Without the
      // check a workspace admin could trigger an audit row referencing
      // a grant in a workspace they don't own.
      const { rowCount: present } = await pool.query(
        `SELECT 1
           FROM cross_project_call_grants g
           JOIN projects pc ON pc.id = g.caller_project_id
          WHERE g.caller_project_id = $1
            AND g.callee_project_id = $2
            AND pc.workspace_id = $3`,
        [callerProjectId, calleeProjectId, req.user.workspaceId],
      );
      if (!present) {
        return res.json({ revoked: false, reason: "not granted" });
      }
      await pool.query(
        `DELETE FROM cross_project_call_grants
          WHERE caller_project_id = $1 AND callee_project_id = $2`,
        [callerProjectId, calleeProjectId],
      );
      await auditLog({
        req, action: "cross_project.revoke",
        resource: { type: "cross_project_grant", id: `${callerProjectId}->${calleeProjectId}` },
        metadata: { callerProjectId, calleeProjectId },
      });
      res.json({ callerProjectId, calleeProjectId, revoked: true });
    } catch (e) { next(e); }
  },
);

export default router;
