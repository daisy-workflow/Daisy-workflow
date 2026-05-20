// Just-in-time elevation grants.
//
// A workspace admin can give a user a higher role at workspace OR
// project scope for a bounded period — common for incident response
// ("Mary needs admin in project Finance for 4 hours to dig into a
// failed batch run"). The grant auto-expires; revoking by hand is
// also fine.
//
// The permission resolver in auth/permissions.js already reads
// jit_grants and unions the granted role's perms when
//   revoked_at IS NULL AND expires_at > NOW()
// is true. So enforcement is "free" — this API only manages the
// rows.
//
// Endpoints:
//   GET    /jit-grants               list active + recently-expired
//                                    grants in the workspace
//                                    (workspace admin via jit.grant)
//   GET    /jit-grants/mine          current user's active grants
//                                    (any signed-in user — so they
//                                     can see they're elevated)
//   POST   /jit-grants               issue a new grant
//                                    body: { userId, scopeType, scopeId,
//                                            role, reason, durationMinutes }
//   POST   /jit-grants/:id/revoke    revoke a still-active grant
//
// Audit:
//   Every grant + revoke writes an audit row. Per the design doc, a
//   future enhancement marks audit rows for privileged actions
//   performed UNDER an active JIT grant with the grant id — that
//   needs resolver-side bookkeeping and lands as a follow-up.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  ValidationError, NotFoundError, ForbiddenError,
} from "../utils/errors.js";
import { requireUser } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);

// Cap the maximum duration of a single grant — anything longer is
// "give them the role permanently" territory, which should go through
// the regular member-role endpoints.
const MAX_DURATION_MINUTES = 24 * 60 * 7;   // 7 days

// ────────────────────────────────────────────────────────────────────
// GET /jit-grants — list active + recently-expired grants in this
// workspace. Workspace-admin only.
//
// "Recently-expired" (expired in the last 30 days) come back too so
// the admin can audit the recent elevation history without bouncing
// to the audit log. revoked_at takes precedence — already-revoked
// rows always show up.
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("jit.grant"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT g.id, g.user_id, g.scope_type, g.scope_id, g.role,
                g.reason, g.expires_at, g.revoked_at, g.created_at,
                u.email          AS user_email,
                u.display_name   AS user_display_name,
                gb.email         AS granted_by_email,
                CASE
                  WHEN g.scope_type = 'workspace' THEN w.name
                  WHEN g.scope_type = 'project'   THEN p.name
                END              AS scope_name,
                CASE
                  WHEN g.revoked_at IS NOT NULL THEN 'revoked'
                  WHEN g.expires_at <= NOW()    THEN 'expired'
                  ELSE 'active'
                END              AS status
           FROM jit_grants g
           JOIN users u  ON u.id  = g.user_id
           LEFT JOIN users gb ON gb.id = g.granted_by
           LEFT JOIN workspaces w ON w.id = g.scope_id AND g.scope_type = 'workspace'
           LEFT JOIN projects   p ON p.id = g.scope_id AND g.scope_type = 'project'
          WHERE (
                  g.scope_type = 'workspace' AND g.scope_id = $1
               OR g.scope_type = 'project'
                  AND g.scope_id IN (SELECT id FROM projects WHERE workspace_id = $1)
                )
            AND (g.expires_at > NOW() - INTERVAL '30 days'
                 OR g.revoked_at > NOW() - INTERVAL '30 days')
          ORDER BY (g.revoked_at IS NULL AND g.expires_at > NOW()) DESC,
                   g.created_at DESC`,
        [req.user.workspaceId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// GET /jit-grants/mine — every signed-in user can see their own active
// grants so the UI can render "you have elevated access" banners.
// ────────────────────────────────────────────────────────────────────
router.get("/mine", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.scope_type, g.scope_id, g.role, g.reason,
              g.expires_at, g.created_at,
              CASE
                WHEN g.scope_type = 'workspace' THEN w.name
                WHEN g.scope_type = 'project'   THEN p.name
              END AS scope_name
         FROM jit_grants g
         LEFT JOIN workspaces w ON w.id = g.scope_id AND g.scope_type = 'workspace'
         LEFT JOIN projects   p ON p.id = g.scope_id AND g.scope_type = 'project'
        WHERE g.user_id = $1
          AND g.revoked_at IS NULL
          AND g.expires_at > NOW()
        ORDER BY g.expires_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /jit-grants — issue.
//
// Body: { userId, scopeType, scopeId, role, reason, durationMinutes }
// ────────────────────────────────────────────────────────────────────
router.post("/",
  requirePermission("jit.grant"),
  async (req, res, next) => {
    try {
      const { userId, scopeType, scopeId, role, reason, durationMinutes } = req.body || {};
      if (!userId) throw new ValidationError("userId is required");
      if (!["workspace", "project"].includes(scopeType)) {
        throw new ValidationError("scopeType must be 'workspace' or 'project'");
      }
      if (!scopeId) throw new ValidationError("scopeId is required");
      if (!["admin", "editor", "viewer"].includes(role)) {
        throw new ValidationError("role must be admin, editor, or viewer");
      }
      if (typeof reason !== "string" || !reason.trim()) {
        throw new ValidationError("reason is required (free-text — typically the incident or task)");
      }
      const dur = Math.floor(Number(durationMinutes));
      if (!Number.isFinite(dur) || dur < 1 || dur > MAX_DURATION_MINUTES) {
        throw new ValidationError(`durationMinutes must be between 1 and ${MAX_DURATION_MINUTES} (= ${MAX_DURATION_MINUTES / 60 / 24} days)`);
      }

      // Scope must live in the caller's workspace.
      if (scopeType === "workspace") {
        if (scopeId !== req.user.workspaceId) {
          throw new ForbiddenError("can't grant to a different workspace");
        }
      } else {
        const { rowCount } = await pool.query(
          `SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2`,
          [scopeId, req.user.workspaceId],
        );
        if (!rowCount) throw new NotFoundError("project");
      }

      // Target user must be in this workspace too.
      const { rowCount: uExists } = await pool.query(
        `SELECT 1 FROM users
          WHERE id = $1
            AND (workspace_id = $2
                 OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id = $2))`,
        [userId, req.user.workspaceId],
      );
      if (!uExists) throw new NotFoundError("user");

      const id = randomUUID();
      const expiresAt = new Date(Date.now() + dur * 60_000);
      await pool.query(
        `INSERT INTO jit_grants
           (id, user_id, scope_type, scope_id, role, reason, granted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, scopeType, scopeId, role, reason.trim(), req.user.id, expiresAt],
      );
      await auditLog({
        req, action: "jit.grant",
        resource: { type: "user", id: userId },
        projectId: scopeType === "project" ? scopeId : null,
        metadata: {
          grantId:           id,
          role,
          scopeType,
          scopeId,
          reason:            reason.trim(),
          durationMinutes:   dur,
          expiresAt:         expiresAt.toISOString(),
        },
      });
      res.status(201).json({
        id, userId, scopeType, scopeId, role,
        reason: reason.trim(),
        expiresAt: expiresAt.toISOString(),
      });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// POST /jit-grants/:id/revoke — explicit revoke before expiry.
//
// A user can self-revoke their own grant (useful when the incident is
// resolved early). Anyone else needs jit.grant. Idempotent — revoking
// an already-revoked or already-expired grant returns ok=false rather
// than failing.
// ────────────────────────────────────────────────────────────────────
router.post("/:id/revoke", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.user_id, g.scope_type, g.scope_id, g.role,
              g.expires_at, g.revoked_at,
              CASE
                WHEN g.scope_type = 'project'   THEN (SELECT workspace_id FROM projects WHERE id = g.scope_id)
                ELSE g.scope_id
              END AS workspace_id
         FROM jit_grants g WHERE g.id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw new NotFoundError("jit grant");
    const g = rows[0];

    // Scope guard: the grant must live in the caller's workspace.
    if (g.workspace_id !== req.user.workspaceId) throw new NotFoundError("jit grant");

    // Self-revoke is OK; otherwise we require jit.grant.
    if (g.user_id !== req.user.id) {
      // Manual check rather than requirePermission so we can run the
      // self-revoke path without a 403.
      const { hasPermission } = await import("../auth/permissions.js");
      const ok = await hasPermission(req, "jit.grant");
      if (!ok) throw new ForbiddenError("only the grant's user or a workspace admin can revoke");
    }

    if (g.revoked_at || new Date(g.expires_at) <= new Date()) {
      return res.json({ id: g.id, revoked: false, reason: "already inactive" });
    }

    await pool.query(
      `UPDATE jit_grants SET revoked_at = NOW() WHERE id = $1`,
      [g.id],
    );
    await auditLog({
      req, action: "jit.revoke",
      resource: { type: "user", id: g.user_id },
      projectId: g.scope_type === "project" ? g.scope_id : null,
      metadata: {
        grantId:    g.id,
        role:       g.role,
        scopeType:  g.scope_type,
        scopeId:    g.scope_id,
        selfRevoke: g.user_id === req.user.id,
      },
    });
    res.json({ id: g.id, revoked: true });
  } catch (e) { next(e); }
});

export default router;
