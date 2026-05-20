// Projects API — RBAC v2 Phase 1.
//
// Scope:
//   • GET /projects               — list projects the caller can see in
//                                   their active workspace.
//   • GET /projects/:id           — detail (membership-gated).
//   • POST /projects              — create new project (workspace admin).
//   • PUT /projects/:id           — update (project admin).
//   • DELETE /projects/:id        — soft-delete (workspace admin).
//   • POST /projects/:id/restore  — undo soft-delete within the
//                                   restore window (workspace admin).
//   • POST /projects/:id/switch   — issue a new JWT with the chosen
//                                   project as the active context.
//
// Membership:
//   • GET /projects/:id/members         — list members + roles.
//   • POST /projects/:id/members        — add a member (project admin).
//   • PUT /projects/:id/members/:user   — change role (project admin).
//   • DELETE /projects/:id/members/:user — remove (project admin).
//
// Visibility rules:
//   - Workspace admin sees every project in their workspace, soft-
//     deleted included.
//   - Non-workspace-admin users see only projects where they have a
//     project_members row.
//
// Soft delete:
//   - DELETE sets deleted_at = NOW(), purge_at = NOW() + 30 days,
//     status = 'deleted'. The retention runner (Phase 5) hard-deletes
//     after purge_at. Resources inside the project are cascaded only
//     at hard-delete time — operators can recover a project for 30
//     days without losing any workflows.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../utils/errors.js";
import { requireUser } from "../middleware/auth.js";
import { signAccessToken } from "../auth/tokens.js";
import { auditLog } from "../audit/log.js";
import { hasPermission } from "../auth/permissions.js";

const router = Router();
router.use(requireUser);

const RESTORE_WINDOW_DAYS = 30;

// ────────────────────────────────────────────────────────────────────
// GET /projects — list visible projects in the active workspace
// ────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const isWsAdmin = await callerIsWorkspaceAdmin(req.user.id, req.user.workspaceId);
    const includeDeleted = req.query.includeDeleted === "true" && isWsAdmin;

    let sql, params;
    if (isWsAdmin) {
      sql = `
        SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.status,
               p.metadata, p.deleted_at, p.purge_at, p.created_at, p.updated_at,
               NULL::text AS member_role
          FROM projects p
         WHERE p.workspace_id = $1
           ${includeDeleted ? "" : "AND p.deleted_at IS NULL"}
         ORDER BY p.deleted_at NULLS FIRST, lower(p.name)`;
      params = [req.user.workspaceId];
    } else {
      sql = `
        SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.status,
               p.metadata, p.deleted_at, p.purge_at, p.created_at, p.updated_at,
               pm.role AS member_role
          FROM projects p
          JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
         WHERE p.workspace_id = $1
           AND p.deleted_at IS NULL
         ORDER BY lower(p.name)`;
      params = [req.user.workspaceId, req.user.id];
    }
    const { rows } = await pool.query(sql, params);
    res.json({ active: req.user.projectId, projects: rows, isWorkspaceAdmin: isWsAdmin });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// GET /projects/:id — single project (visibility-gated)
// ────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const p = await loadVisibleProject(req, req.params.id);
    res.json(p);
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /projects — create. Workspace admin only.
// ────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    if (!await callerIsWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace admin required to create projects");
    }
    const { name, slug, description, metadata } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      throw new ValidationError("name is required");
    }
    const safeSlug = slugify(slug || name);
    if (!safeSlug) throw new ValidationError("slug must contain at least one alphanumeric character");

    // Uniqueness within workspace
    const { rowCount: dup } = await pool.query(
      `SELECT 1 FROM projects WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
      [req.user.workspaceId, safeSlug],
    );
    if (dup) throw new ConflictError(`project slug "${safeSlug}" already exists in this workspace`);

    const id = randomUUID();
    const meta = (metadata && typeof metadata === "object") ? metadata : {};
    await pool.query(
      `INSERT INTO projects
         (id, workspace_id, name, slug, description, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, req.user.workspaceId, name.trim(), safeSlug, description || null, JSON.stringify(meta), req.user.id],
    );

    // The creating admin doesn't need a project_members row — they
    // inherit. But it's polite to seed one so admins listed in the
    // project's members include them visibly. Skip for now; UI shows
    // workspace admins in a separate "inherits admin" badge.

    await auditLog({
      req,
      action:   "project.create",
      resource: { type: "project", id, name: name.trim() },
      // workspace-level event (project creation), no project_id yet.
    });
    res.status(201).json({ id, slug: safeSlug });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// PUT /projects/:id — update name / description / metadata / status.
// Project admin or workspace admin.
// ────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    const p = await loadVisibleProject(req, req.params.id);
    if (!await canAdministerProject(req, p)) {
      throw new ForbiddenError("project admin required");
    }

    const updates = {};
    if (typeof req.body?.name === "string"        && req.body.name.trim()) updates.name = req.body.name.trim();
    if (typeof req.body?.description === "string") updates.description = req.body.description;
    if (req.body?.metadata && typeof req.body.metadata === "object") {
      updates.metadata = JSON.stringify(req.body.metadata);
    }
    if (typeof req.body?.status === "string" && ["active", "archived"].includes(req.body.status)) {
      updates.status = req.body.status;
    }
    if (Object.keys(updates).length === 0) {
      throw new ValidationError("no updatable fields supplied");
    }

    const sets = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(updates)) {
      sets.push(`${k} = $${i}${k === "metadata" ? "::jsonb" : ""}`);
      params.push(v);
      i++;
    }
    params.push(req.params.id);
    await pool.query(
      `UPDATE projects SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${i}`,
      params,
    );
    await auditLog({
      req,
      action:    "project.update",
      resource:  { type: "project", id: req.params.id, name: updates.name || p.name },
      projectId: req.params.id,
      metadata:  { fields: Object.keys(updates) },
    });
    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// DELETE /projects/:id — soft delete. Workspace admin only.
// ────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    if (!await callerIsWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace admin required to delete projects");
    }
    const p = await loadVisibleProject(req, req.params.id);
    if (p.slug === "default") {
      throw new ForbiddenError("the Default project cannot be deleted");
    }

    const purgeAt = new Date(Date.now() + RESTORE_WINDOW_DAYS * 24 * 3600 * 1000);
    await pool.query(
      `UPDATE projects
          SET deleted_at = NOW(),
              purge_at   = $1,
              status     = 'deleted',
              updated_at = NOW()
        WHERE id = $2`,
      [purgeAt, req.params.id],
    );
    await auditLog({
      req,
      action:   "project.delete",
      resource: { type: "project", id: req.params.id, name: p.name },
      metadata: { purgeAt: purgeAt.toISOString(), restoreWindowDays: RESTORE_WINDOW_DAYS },
    });
    res.json({ id: req.params.id, deleted: true, purgeAt });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /projects/:id/restore — undo soft-delete inside the window.
// Workspace admin only.
// ────────────────────────────────────────────────────────────────────
router.post("/:id/restore", async (req, res, next) => {
  try {
    if (!await callerIsWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace admin required to restore projects");
    }
    const { rows } = await pool.query(
      `SELECT id, name, deleted_at, purge_at FROM projects
        WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("project");
    const p = rows[0];
    if (!p.deleted_at) {
      throw new ValidationError("project is not deleted");
    }
    if (p.purge_at && new Date(p.purge_at) < new Date()) {
      throw new ForbiddenError("restore window has expired");
    }
    await pool.query(
      `UPDATE projects
          SET deleted_at = NULL,
              purge_at   = NULL,
              status     = 'active',
              updated_at = NOW()
        WHERE id = $1`,
      [req.params.id],
    );
    await auditLog({
      req,
      action:   "project.restore",
      resource: { type: "project", id: req.params.id, name: p.name },
    });
    res.json({ id: req.params.id, restored: true });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /projects/:id/switch — issue a JWT scoped to this project.
// Any visible-member or workspace-admin can call.
// ────────────────────────────────────────────────────────────────────
router.post("/:id/switch", async (req, res, next) => {
  try {
    const p = await loadVisibleProject(req, req.params.id);
    const accessToken = signAccessToken({
      userId:      req.user.id,
      email:       req.user.email,
      role:        req.user.role,
      workspaceId: req.user.workspaceId,
      projectId:   p.id,
    });
    await auditLog({
      req,
      action:    "project.switch",
      resource:  { type: "project", id: p.id, name: p.name },
      projectId: p.id,
      metadata:  { fromProjectId: req.user.projectId },
    });
    res.json({
      accessToken,
      project: { id: p.id, name: p.name, slug: p.slug },
    });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// Members
// ────────────────────────────────────────────────────────────────────
router.get("/:id/members", async (req, res, next) => {
  try {
    await loadVisibleProject(req, req.params.id);   // gates visibility
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.status,
              pm.role,
              pm.created_at AS joined_at
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1
        ORDER BY lower(u.email)`,
      [req.params.id],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/:id/members", async (req, res, next) => {
  try {
    const p = await loadVisibleProject(req, req.params.id);
    if (!await canAdministerProject(req, p)) {
      throw new ForbiddenError("project admin required");
    }
    const { userId, role } = req.body || {};
    if (!userId) throw new ValidationError("userId is required");
    if (!["admin", "editor", "viewer"].includes(role)) {
      throw new ValidationError("role must be admin, editor, or viewer");
    }
    // Target user must belong to the same workspace.
    const { rows: u } = await pool.query(
      `SELECT id, email FROM users
        WHERE id = $1
          AND (workspace_id = $2
               OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id = $2))
        LIMIT 1`,
      [userId, p.workspace_id],
    );
    if (!u.length) throw new NotFoundError("user");

    await pool.query(
      `INSERT INTO project_members (user_id, project_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [userId, p.id, role],
    );
    await auditLog({
      req,
      action:    "project.member.add",
      resource:  { type: "project", id: p.id, name: p.name },
      projectId: p.id,
      metadata:  { userId, userEmail: u[0].email, role },
    });
    res.status(201).json({ userId, projectId: p.id, role });
  } catch (e) { next(e); }
});

router.put("/:id/members/:user", async (req, res, next) => {
  try {
    const p = await loadVisibleProject(req, req.params.id);
    if (!await canAdministerProject(req, p)) {
      throw new ForbiddenError("project admin required");
    }
    const role = req.body?.role;
    if (!["admin", "editor", "viewer"].includes(role)) {
      throw new ValidationError("role must be admin, editor, or viewer");
    }
    const { rowCount } = await pool.query(
      `UPDATE project_members
          SET role = $1, updated_at = NOW()
        WHERE user_id = $2 AND project_id = $3`,
      [role, req.params.user, p.id],
    );
    if (rowCount === 0) throw new NotFoundError("project membership");
    await auditLog({
      req,
      action:    "project.member.update",
      resource:  { type: "project", id: p.id, name: p.name },
      projectId: p.id,
      metadata:  { userId: req.params.user, role },
    });
    res.json({ userId: req.params.user, projectId: p.id, role });
  } catch (e) { next(e); }
});

router.delete("/:id/members/:user", async (req, res, next) => {
  try {
    const p = await loadVisibleProject(req, req.params.id);
    if (!await canAdministerProject(req, p)) {
      throw new ForbiddenError("project admin required");
    }
    if (req.params.user === req.user.id) {
      // Leaving your own project is fine, but block the last-admin
      // case. If you're the only admin and not a workspace admin
      // overall, refuse to leave (otherwise the project becomes
      // un-administrable except via workspace admin promotion).
      const { rows: admins } = await pool.query(
        `SELECT user_id FROM project_members
          WHERE project_id = $1 AND role = 'admin'`,
        [p.id],
      );
      const wsAdmin = await callerIsWorkspaceAdmin(req.user.id, p.workspace_id);
      if (!wsAdmin && admins.length === 1 && admins[0].user_id === req.user.id) {
        throw new ForbiddenError("you are the only project admin — promote another member first");
      }
    }
    await pool.query(
      `DELETE FROM project_members WHERE user_id = $1 AND project_id = $2`,
      [req.params.user, p.id],
    );
    await auditLog({
      req,
      action:    "project.member.remove",
      resource:  { type: "project", id: p.id, name: p.name },
      projectId: p.id,
      metadata:  { userId: req.params.user },
    });
    res.json({ userId: req.params.user, projectId: p.id, removed: true });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

/**
 * Workspace admin? Reads from workspace_members first, falls back to
 * users.role for pre-RBAC-v2 admins whose membership row was never
 * populated. Single source of truth used everywhere project access is
 * being evaluated, so keep this small and fast.
 */
async function callerIsWorkspaceAdmin(userId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT role FROM workspace_members
      WHERE user_id = $1 AND workspace_id = $2
      LIMIT 1`,
    [userId, workspaceId],
  );
  if (rows.length && rows[0].role === "admin") return true;
  const { rows: u } = await pool.query(
    `SELECT 1 FROM users
      WHERE id = $1 AND workspace_id = $2 AND role = 'admin'
      LIMIT 1`,
    [userId, workspaceId],
  );
  return u.length > 0;
}

async function loadVisibleProject(req, projectId) {
  if (!projectId) throw new ValidationError("project id required");
  // Workspace admin can see any project (including deleted, so they
  // can restore). Non-admins must be project members AND the project
  // must be active.
  const isWsAdmin = await callerIsWorkspaceAdmin(req.user.id, req.user.workspaceId);
  let row;
  if (isWsAdmin) {
    const { rows } = await pool.query(
      `SELECT id, workspace_id, name, slug, description, status, metadata,
              deleted_at, purge_at, created_at, updated_at
         FROM projects
        WHERE id = $1 AND workspace_id = $2`,
      [projectId, req.user.workspaceId],
    );
    row = rows[0];
  } else {
    const { rows } = await pool.query(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.status, p.metadata,
              p.deleted_at, p.purge_at, p.created_at, p.updated_at, pm.role AS member_role
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
        WHERE p.id = $1 AND p.workspace_id = $3 AND p.deleted_at IS NULL`,
      [projectId, req.user.id, req.user.workspaceId],
    );
    row = rows[0];
  }
  if (!row) throw new NotFoundError("project");
  row.isWorkspaceAdmin = isWsAdmin;
  return row;
}

async function canAdministerProject(req, project) {
  if (project.isWorkspaceAdmin) return true;
  return hasPermission(req, "project.update", { projectId: project.id });
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export default router;
