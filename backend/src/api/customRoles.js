// Custom roles API.
//
// Workspace-scoped role definitions. Each role carries a list of
// permission strings (drawn from listPermissionCatalog()). Roles can
// be GRANTED to users at either workspace scope or project scope —
// the resolver in auth/permissions.js unions the granted role's
// permissions on top of whatever built-in role the user already
// holds.
//
// Authoring (create/update/delete) is a workspace-admin action — the
// role definition lives at workspace level.
// Granting an EXISTING role to a user can be done by a workspace
// admin OR by a project admin (at their own project's scope).
//
// Endpoints:
//   GET    /custom-roles                              list roles in workspace
//   GET    /custom-roles/catalog                      permission catalog (for the UI picker)
//   POST   /custom-roles                              create
//   GET    /custom-roles/:id                          one
//   PUT    /custom-roles/:id                          update (name / description / permissions)
//   DELETE /custom-roles/:id                          delete (cascades to grants)
//   GET    /custom-roles/:id/grants                   list users this role is granted to
//   POST   /custom-roles/:id/grants                   grant {userId, scopeType, scopeId}
//   DELETE /custom-roles/:id/grants/:grantId          revoke a single grant

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  ValidationError, NotFoundError, ForbiddenError, ConflictError,
} from "../utils/errors.js";
import { requireUser } from "../middleware/auth.js";
import {
  requirePermission, hasPermission, listPermissionCatalog,
} from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);

// Names follow the same convention as project slugs etc.
const NAME_RE = /^[A-Za-z][A-Za-z0-9 _\-.]{0,60}$/;

// Set of every known permission string. Authored roles can only
// reference permissions that actually exist — keeps the data clean.
const KNOWN_PERMS = new Set(listPermissionCatalog().map(p => p.name));

// ────────────────────────────────────────────────────────────────────
// Catalogue endpoint — what permissions can a custom role grant?
// Read-only, exposed to anyone who can read custom roles so the UI
// can build the picker on the same page that lists them.
// ────────────────────────────────────────────────────────────────────
router.get("/catalog",
  requirePermission("custom_role.read"),
  (_req, res) => res.json(listPermissionCatalog()),
);

// ────────────────────────────────────────────────────────────────────
// List + get
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("custom_role.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.description, r.permissions,
                r.created_at, r.updated_at,
                COALESCE(u.display_name, u.email) AS created_by_email,
                (SELECT COUNT(*) FROM role_grants g
                   WHERE g.custom_role_id = r.id)::int AS grant_count
           FROM custom_roles r
           LEFT JOIN users u ON u.id = r.created_by
          WHERE r.workspace_id = $1
          ORDER BY lower(r.name)`,
        [req.user.workspaceId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.get("/:id",
  requirePermission("custom_role.read"),
  async (req, res, next) => {
    try {
      const row = await loadRole(req.params.id, req.user.workspaceId);
      res.json(row);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// Create / update / delete — workspace admin only.
// ────────────────────────────────────────────────────────────────────
router.post("/",
  requirePermission("custom_role.create"),
  async (req, res, next) => {
    try {
      const { name, description, permissions = [] } = req.body || {};
      if (!name || !NAME_RE.test(name)) {
        throw new ValidationError("name is required (start with a letter, ≤60 chars, alphanumeric + . _ - space)");
      }
      const cleanPerms = normalizePermissions(permissions);
      if (cleanPerms.length === 0) {
        throw new ValidationError("at least one permission is required");
      }

      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO custom_roles
             (id, workspace_id, name, description, permissions, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [id, req.user.workspaceId, name, description || null,
           JSON.stringify(cleanPerms), req.user.id],
        );
      } catch (e) {
        if (e.code === "23505") {
          throw new ConflictError(`a custom role named "${name}" already exists in this workspace`);
        }
        throw e;
      }
      await auditLog({
        req, action: "custom_role.create",
        resource: { type: "custom_role", id, name },
        metadata: { permissions: cleanPerms },
      });
      res.status(201).json({ id, name, permissions: cleanPerms });
    } catch (e) { next(e); }
  },
);

router.put("/:id",
  requirePermission("custom_role.update"),
  async (req, res, next) => {
    try {
      const existing = await loadRole(req.params.id, req.user.workspaceId);

      const sets = []; const params = [];
      if (req.body?.name !== undefined) {
        if (!NAME_RE.test(req.body.name)) throw new ValidationError("invalid name");
        params.push(req.body.name); sets.push(`name = $${params.length}`);
      }
      if (req.body?.description !== undefined) {
        params.push(req.body.description || null);
        sets.push(`description = $${params.length}`);
      }
      if (req.body?.permissions !== undefined) {
        const clean = normalizePermissions(req.body.permissions);
        if (clean.length === 0) throw new ValidationError("permissions cannot be empty");
        params.push(JSON.stringify(clean));
        sets.push(`permissions = $${params.length}::jsonb`);
      }
      if (sets.length === 0) return res.json({ id: req.params.id, updated: false });

      sets.push("updated_at = NOW()");
      params.push(req.params.id);
      const idIdx = params.length;
      params.push(req.user.workspaceId);
      const wsIdx = params.length;
      try {
        await pool.query(
          `UPDATE custom_roles SET ${sets.join(", ")}
            WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
          params,
        );
      } catch (e) {
        if (e.code === "23505") throw new ConflictError("name conflict");
        throw e;
      }
      await auditLog({
        req, action: "custom_role.update",
        resource: { type: "custom_role", id: req.params.id, name: req.body?.name || existing.name },
        metadata: { fields: Object.keys(req.body || {}) },
      });
      res.json({ id: req.params.id, updated: true });
    } catch (e) { next(e); }
  },
);

router.delete("/:id",
  requirePermission("custom_role.delete"),
  async (req, res, next) => {
    try {
      const row = await loadRole(req.params.id, req.user.workspaceId);
      // FK on role_grants is ON DELETE CASCADE — grants disappear with
      // the role definition. That's the right semantic: deleting a
      // role revokes every grant of it instantly.
      await pool.query(
        `DELETE FROM custom_roles WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, req.user.workspaceId],
      );
      await auditLog({
        req, action: "custom_role.delete",
        resource: { type: "custom_role", id: req.params.id, name: row.name },
      });
      res.json({ id: req.params.id, deleted: true });
    } catch (e) { next(e); }
  },
);

// ════════════════════════════════════════════════════════════════════
// Role grants — assign / revoke
// ════════════════════════════════════════════════════════════════════
router.get("/:id/grants",
  requirePermission("custom_role.read"),
  async (req, res, next) => {
    try {
      await loadRole(req.params.id, req.user.workspaceId);
      const { rows } = await pool.query(
        `SELECT g.id, g.user_id, g.scope_type, g.scope_id, g.created_at,
                u.email   AS user_email,
                u.display_name AS user_display_name,
                COALESCE(gb.display_name, gb.email) AS granted_by_email,
                CASE
                  WHEN g.scope_type = 'workspace' THEN w.name
                  WHEN g.scope_type = 'project'   THEN p.name
                END AS scope_name
           FROM role_grants g
           JOIN users u ON u.id = g.user_id
           LEFT JOIN users gb       ON gb.id = g.granted_by
           LEFT JOIN workspaces w   ON w.id  = g.scope_id AND g.scope_type = 'workspace'
           LEFT JOIN projects   p   ON p.id  = g.scope_id AND g.scope_type = 'project'
          WHERE g.custom_role_id = $1
          ORDER BY g.created_at DESC`,
        [req.params.id],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post("/:id/grants", async (req, res, next) => {
  try {
    const role = await loadRole(req.params.id, req.user.workspaceId);
    const { userId, scopeType, scopeId } = req.body || {};
    if (!userId) throw new ValidationError("userId is required");
    if (!["workspace", "project"].includes(scopeType)) {
      throw new ValidationError("scopeType must be 'workspace' or 'project'");
    }
    if (!scopeId) throw new ValidationError("scopeId is required");

    // Workspace-scope grants are workspace-admin only.
    // Project-scope grants need either workspace-admin OR
    // project-admin-of-that-project ("custom_role.grant" in resolver).
    if (scopeType === "workspace") {
      if (!await hasPermission(req, "custom_role.create")) {
        throw new ForbiddenError("workspace admin required for workspace-scope grants");
      }
      // Sanity: workspace scope must point at the caller's workspace.
      if (scopeId !== req.user.workspaceId) {
        throw new ForbiddenError("can't grant to a different workspace");
      }
    } else {
      // project scope
      if (!await hasPermission(req, "custom_role.grant", { projectId: scopeId })) {
        throw new ForbiddenError("project admin required for this project");
      }
      // Verify the project actually belongs to this workspace —
      // never let a workspace admin grant their role into another
      // workspace's project even if they fat-finger the id.
      const { rowCount } = await pool.query(
        `SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2`,
        [scopeId, req.user.workspaceId],
      );
      if (rowCount === 0) throw new NotFoundError("project");
    }

    // Verify the target user is actually in this workspace.
    const { rowCount: uExists } = await pool.query(
      `SELECT 1 FROM users
        WHERE id = $1
          AND (workspace_id = $2
               OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id = $2))`,
      [userId, req.user.workspaceId],
    );
    if (!uExists) throw new NotFoundError("user");

    const grantId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO role_grants
           (id, user_id, scope_type, scope_id, custom_role_id, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [grantId, userId, scopeType, scopeId, role.id, req.user.id],
      );
    } catch (e) {
      if (e.code === "23505") {
        throw new ConflictError("this user already holds this role at the given scope");
      }
      throw e;
    }
    await auditLog({
      req, action: "custom_role.grant",
      resource: { type: "custom_role", id: role.id, name: role.name },
      projectId: scopeType === "project" ? scopeId : null,
      metadata: { userId, scopeType, scopeId, grantId },
    });
    res.status(201).json({ grantId, userId, scopeType, scopeId });
  } catch (e) { next(e); }
});

router.delete("/:id/grants/:grantId", async (req, res, next) => {
  try {
    const role = await loadRole(req.params.id, req.user.workspaceId);
    // Look up the grant so we know the scope it lives at — same
    // gate as POST, just inverted.
    const { rows: g } = await pool.query(
      `SELECT user_id, scope_type, scope_id
         FROM role_grants
        WHERE id = $1 AND custom_role_id = $2`,
      [req.params.grantId, role.id],
    );
    if (g.length === 0) throw new NotFoundError("grant");
    const grant = g[0];

    const perm = "custom_role.grant";
    const opts = grant.scope_type === "project" ? { projectId: grant.scope_id } : {};
    if (!await hasPermission(req, perm, opts)
        && !await hasPermission(req, "custom_role.create")) {
      throw new ForbiddenError("not allowed to revoke this grant");
    }

    await pool.query(
      `DELETE FROM role_grants WHERE id = $1 AND custom_role_id = $2`,
      [req.params.grantId, role.id],
    );
    await auditLog({
      req, action: "custom_role.revoke",
      resource: { type: "custom_role", id: role.id, name: role.name },
      projectId: grant.scope_type === "project" ? grant.scope_id : null,
      metadata: { grantId: req.params.grantId, userId: grant.user_id },
    });
    res.json({ grantId: req.params.grantId, revoked: true });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════
async function loadRole(id, workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, name, description, permissions, created_at, updated_at
       FROM custom_roles
      WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  if (rows.length === 0) throw new NotFoundError("custom role");
  return rows[0];
}

function normalizePermissions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== "string") continue;
    if (!KNOWN_PERMS.has(p)) {
      throw new ValidationError(`unknown permission: "${p}"`);
    }
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

export default router;
