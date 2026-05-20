// Resource-level grants API.
//
// Per-resource ACL overlay — "give Mary read on this one workflow,
// even though she's not in the project at all." Sits ON TOP of the
// role-based permission set computed by auth/permissions.js. There
// are no deny rules; this only adds permissions.
//
// Resource types supported in this phase:
//   * workflow  → graphs.id
//   * config    → configs.id
//   * agent     → agents.id
//
// Principal types:
//   * user             → users.id
//   * service_account  → service_accounts.id
//
// Permissions:
//   The grant carries a JSONB array of permission strings from the
//   listPermissionCatalog() output. The resolver unions them in
//   when the route under guard calls requirePermission(..., {
//     resourceType, resourceIdFrom }).
//
// Endpoints:
//   GET    /resource-grants?type=<t>&id=<uuid>     list grants on one resource
//   POST   /resource-grants                        create grant
//   PUT    /resource-grants/:id                    update permissions
//   DELETE /resource-grants/:id                    revoke

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  ValidationError, NotFoundError, ForbiddenError, ConflictError,
} from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import {
  requirePermission, hasPermission, listPermissionCatalog,
} from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

// Same permission catalogue the custom-roles API uses, intersected
// with the subset that's meaningful at resource scope. Workspace-level
// perms (workspace.update, plugin.install, etc.) don't apply to a
// single resource — they'd be a no-op if granted here.
const RESOURCE_GRANTABLE_PERMS = new Set([
  // Workflow grants
  "workflow.read", "workflow.update", "workflow.delete", "workflow.run",
  // Config grants
  "config.read", "config.update", "config.delete", "config.reveal_secret",
  // Agent grants
  "agent.read", "agent.update", "agent.delete",
  // Execution viewing for a specific workflow's runs
  "execution.read",
]);

const RESOURCE_TYPES = ["workflow", "config", "agent"];
const PRINCIPAL_TYPES = ["user", "service_account"];

// Map each resource_type to the table + column we look up to prove
// existence and ownership. Resource grants don't have an FK to the
// resource itself (resource_id is opaque in the schema) so we do the
// scope check in code.
const RESOURCE_OWNERSHIP = {
  workflow: { table: "graphs",  scopeCol: "project_id" },
  config:   { table: "configs", scopeCol: "project_id" },
  agent:    { table: "agents",  scopeCol: "project_id" },
};

// ────────────────────────────────────────────────────────────────────
// GET /resource-grants?type=workflow&id=<uuid>
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("resource_grant.read"),
  async (req, res, next) => {
    try {
      const { type, id } = req.query;
      validateType(type);
      if (!id) throw new ValidationError("query.id is required");
      await assertResourceInProject(type, id, req.user.projectId);

      const { rows } = await pool.query(
        `SELECT g.id,
                g.principal_type,
                g.principal_id,
                g.permissions,
                g.created_at,
                COALESCE(gb.display_name, gb.email) AS granted_by_email,
                CASE
                  WHEN g.principal_type = 'user'
                    THEN COALESCE(up.display_name, up.email)
                  WHEN g.principal_type = 'service_account'
                    THEN sa.name
                END AS principal_label,
                CASE
                  WHEN g.principal_type = 'user' THEN up.email
                  ELSE NULL
                END AS principal_email
           FROM resource_grants g
           LEFT JOIN users gb ON gb.id = g.granted_by
           LEFT JOIN users up
                  ON up.id = g.principal_id AND g.principal_type = 'user'
           LEFT JOIN service_accounts sa
                  ON sa.id = g.principal_id AND g.principal_type = 'service_account'
          WHERE g.resource_type = $1 AND g.resource_id = $2
          ORDER BY g.created_at DESC`,
        [type, id],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// POST /resource-grants
//
// Body:
//   { resourceType, resourceId, principalType, principalId, permissions: [] }
// ────────────────────────────────────────────────────────────────────
router.post("/",
  requirePermission("resource_grant.write"),
  async (req, res, next) => {
    try {
      const { resourceType, resourceId, principalType, principalId, permissions = [] } = req.body || {};
      validateType(resourceType);
      validatePrincipal(principalType);
      if (!resourceId)  throw new ValidationError("resourceId is required");
      if (!principalId) throw new ValidationError("principalId is required");

      const clean = normalizePermissions(permissions, resourceType);
      if (clean.length === 0) {
        throw new ValidationError("at least one permission is required");
      }

      await assertResourceInProject(resourceType, resourceId, req.user.projectId);
      await assertPrincipalReachable(principalType, principalId, req.user.workspaceId);

      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO resource_grants
             (id, resource_type, resource_id, principal_type, principal_id,
              permissions, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [id, resourceType, resourceId, principalType, principalId,
           JSON.stringify(clean), req.user.id],
        );
      } catch (e) {
        if (e.code === "23505") {
          throw new ConflictError("a grant for this principal already exists on this resource — use PUT to update its permissions");
        }
        throw e;
      }
      await auditLog({
        req, action: "resource_grant.create",
        resource: { type: resourceType, id: resourceId },
        projectId: req.user.projectId,
        metadata: { principalType, principalId, permissions: clean },
      });
      res.status(201).json({ id, permissions: clean });
    } catch (e) { next(e); }
  },
);

router.put("/:id",
  requirePermission("resource_grant.write"),
  async (req, res, next) => {
    try {
      const existing = await loadGrant(req.params.id);
      // Ownership: the resource must be in the caller's active project.
      await assertResourceInProject(existing.resource_type, existing.resource_id, req.user.projectId);

      const clean = normalizePermissions(req.body?.permissions, existing.resource_type);
      if (clean.length === 0) {
        throw new ValidationError("permissions cannot be empty (use DELETE to revoke entirely)");
      }
      await pool.query(
        `UPDATE resource_grants SET permissions = $1::jsonb WHERE id = $2`,
        [JSON.stringify(clean), req.params.id],
      );
      await auditLog({
        req, action: "resource_grant.update",
        resource: { type: existing.resource_type, id: existing.resource_id },
        projectId: req.user.projectId,
        metadata: { grantId: req.params.id, permissions: clean },
      });
      res.json({ id: req.params.id, permissions: clean });
    } catch (e) { next(e); }
  },
);

router.delete("/:id",
  requirePermission("resource_grant.write"),
  async (req, res, next) => {
    try {
      const existing = await loadGrant(req.params.id);
      await assertResourceInProject(existing.resource_type, existing.resource_id, req.user.projectId);
      await pool.query(`DELETE FROM resource_grants WHERE id = $1`, [req.params.id]);
      await auditLog({
        req, action: "resource_grant.delete",
        resource: { type: existing.resource_type, id: existing.resource_id },
        projectId: req.user.projectId,
        metadata: { grantId: req.params.id },
      });
      res.json({ id: req.params.id, revoked: true });
    } catch (e) { next(e); }
  },
);

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════
function validateType(t) {
  if (!RESOURCE_TYPES.includes(t)) {
    throw new ValidationError(`resourceType must be one of: ${RESOURCE_TYPES.join(", ")}`);
  }
}

function validatePrincipal(t) {
  if (!PRINCIPAL_TYPES.includes(t)) {
    throw new ValidationError(`principalType must be one of: ${PRINCIPAL_TYPES.join(", ")}`);
  }
}

function normalizePermissions(list, resourceType) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== "string") continue;
    if (!RESOURCE_GRANTABLE_PERMS.has(p)) {
      throw new ValidationError(`permission "${p}" cannot be granted at resource scope`);
    }
    // Cross-check the permission's family matches the resource type
    // so an "agent.update" grant on a workflow row is caught early.
    const family = p.split(".")[0];
    if (family !== resourceType && family !== "execution") {
      throw new ValidationError(`permission "${p}" doesn't apply to ${resourceType}`);
    }
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

/**
 * Make sure the resource lives in the caller's active project (i.e.
 * the caller has authority to share it). Workspace-shared configs and
 * agents are accepted too, but only if the caller is a workspace
 * admin — otherwise a project editor could share workspace-shared
 * credentials with random users.
 */
async function assertResourceInProject(type, id, projectId) {
  const meta = RESOURCE_OWNERSHIP[type];
  if (!meta) throw new ValidationError("unsupported resource type");
  const { rows } = await pool.query(
    `SELECT ${meta.scopeCol} AS project_id
       FROM ${meta.table}
      WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw new NotFoundError(type);
  const ownerProj = rows[0].project_id;
  // project-private rows: caller's active project must match.
  // workspace-shared rows (project_id NULL): caller is implicitly
  // working with a workspace-shared resource — block unless they
  // are a workspace admin (sharing-of-shared is a workspace-level act).
  if (ownerProj === null) {
    // We can't check the workspace-admin perm without the req — keep
    // this conservative and refuse. The UI can route sharing of
    // workspace-shared configs through a workspace-admin-only flow.
    throw new ForbiddenError("workspace-shared resources can't be granted at resource scope; promote permissions via a workspace-shared config / agent instead");
  }
  if (ownerProj !== projectId) {
    throw new NotFoundError(type);
  }
}

/**
 * Verify the target principal exists in the caller's workspace.
 * Users live at workspace level; service accounts live at project
 * level — for SAs we additionally check the SA is in the caller's
 * workspace (via its project).
 */
async function assertPrincipalReachable(type, id, workspaceId) {
  if (type === "user") {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM users
        WHERE id = $1
          AND (workspace_id = $2
               OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id = $2))`,
      [id, workspaceId],
    );
    if (!rowCount) throw new NotFoundError("user");
  } else if (type === "service_account") {
    const { rowCount } = await pool.query(
      `SELECT 1
         FROM service_accounts sa
         JOIN projects p ON p.id = sa.project_id
        WHERE sa.id = $1 AND p.workspace_id = $2 AND sa.deleted_at IS NULL`,
      [id, workspaceId],
    );
    if (!rowCount) throw new NotFoundError("service account");
  }
}

async function loadGrant(id) {
  const { rows } = await pool.query(
    `SELECT id, resource_type, resource_id, principal_type, principal_id, permissions
       FROM resource_grants WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw new NotFoundError("resource grant");
  return rows[0];
}

export default router;
