// RBAC v2 — permission resolution.
//
// Every API operation maps to a permission string ("<resource>.<action>").
// `resolveEffectivePermissions(ctx)` computes the set of permissions a
// principal holds for a given (workspace, project) scope; the
// `requirePermission(...)` middleware uses that to gate routes.
//
// Resolution algorithm (see wiki/RBAC v2 Design.md):
//
//   1. If the principal is a service_account: union its built-in role
//      permissions (project-scoped) with any custom role grants and
//      resource grants targeting it.
//   2. If the principal is a user:
//      a. If workspace_members.role = 'admin' for this workspace,
//         return the universal "all" set (workspace admin inherits
//         everything inside the workspace, including all projects).
//      b. Built-in project role from project_members.role for the
//         target project.
//      c. Custom roles from role_grants (workspace OR project scope).
//      d. Active JIT grants (revoked_at IS NULL AND expires_at > NOW()).
//      e. Resource-level grants targeting the specific resource
//         (only relevant when the request carries a resource id).
//
// All grant kinds are ADDITIVE. There are no deny rules — that keeps
// the model simple. If a tighter policy is needed later, deny rules
// can be added without restructuring resolution.
//
// What's hot-path vs cold-path:
//   • The built-in role lookups are indexed PK reads.
//   • Custom roles + JIT grants are small per-user; expect <10 rows.
//   • Resource grants are looked up ONLY when the route declares a
//     specific resource id. Lists never carry resource-level grants.

import { pool } from "../db/pool.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

// ────────────────────────────────────────────────────────────────────
// Built-in role → permission set.
//
// "*" is the universal wildcard — convenient for admin role and for
// matching during the membership check.
// ────────────────────────────────────────────────────────────────────

const ALL = "*";

const READ_PERMS = [
  "workflow.read",
  "trigger.read",
  "config.read",          // sees names + types only when role is viewer; secrets gated separately
  "agent.read",
  "execution.read",
  "memory.read",
  "plugin.list",
  "project.read",
  "project.member.read",
];

const WRITE_PERMS = [
  // Workflows
  "workflow.create",
  "workflow.update",
  "workflow.delete",
  "workflow.run",
  // Triggers
  "trigger.create",
  "trigger.update",
  "trigger.delete",
  "trigger.fire",
  // Configs
  "config.create",
  "config.update",
  "config.delete",
  // Agents
  "agent.create",
  "agent.update",
  "agent.delete",
  // Executions
  "execution.cancel",
  "execution.resume",
  "execution.delete",
  // Memory
  "memory.write",
  "memory.delete",
  // Plugin invocation (call from workflows)
  "plugin.invoke",
];

const ADMIN_PERMS = [
  // Anything an editor can do …
  ...READ_PERMS,
  ...WRITE_PERMS,
  // … plus project administration.
  "project.update",
  "project.delete",
  "project.member.write",
  "config.reveal_secret",
  "audit.read.project",
  "service_account.read",
  "service_account.create",
  "service_account.delete",
  "quota.read",
  // Resource-level grants — anyone who admins the project can share
  // its workflows / configs / agents with specific users.
  "resource_grant.read",
  "resource_grant.write",
  // Project admins can grant existing workspace-scoped custom roles
  // to users at PROJECT scope. Authoring the role itself requires
  // workspace admin (in WORKSPACE_ADMIN_EXTRA_PERMS).
  "custom_role.grant",
];

// Viewer permissions don't include config.read by default — secrets
// are sensitive even just-the-keys. Project admins / editors see them;
// viewers see only executions.
const VIEWER_PERMS = [
  "workflow.read",
  "trigger.read",
  "execution.read",
  "agent.read",
  "memory.read",
  "plugin.list",
  "project.read",
];

const BUILTIN_ROLE_PERMS = {
  admin:  new Set(ADMIN_PERMS),
  editor: new Set([...READ_PERMS, ...WRITE_PERMS]),
  viewer: new Set(VIEWER_PERMS),
};

// Workspace-level admin permissions on top of project admin.
const WORKSPACE_ADMIN_EXTRA_PERMS = new Set([
  "workspace.read",
  "workspace.update",
  "project.create",
  "project.delete",
  "user.read",
  "user.write",
  "plugin.install",
  "plugin.uninstall",
  "audit.read.workspace",
  "quota.write",
  "config.share_workspace",          // create/edit workspace-shared configs
  "agent.share_workspace",
  "cross_project.grant",             // grant workflow.fire across projects
  "jit.grant",                       // issue JIT elevations
  // Custom-role authoring lives at workspace level — defining a new
  // role applies across every project in the workspace.
  "custom_role.read",
  "custom_role.create",
  "custom_role.update",
  "custom_role.delete",
]);

/**
 * Compute the effective permission set for a request.
 *
 * @param {object} req  Express request, post-requireUser.
 * @param {object} opts Optional resource hints:
 *   - resourceType: "workflow" | "config" | ... (for resource-grant lookup)
 *   - resourceId:   UUID
 *   - projectId:    UUID of the project the request is scoped to. Falls
 *                   back to req.user.projectId when omitted.
 *
 * @returns {Promise<Set<string>>} effective permission strings. The
 * special "*" wildcard means "all permissions" (workspace admin).
 */
export async function resolveEffectivePermissions(req, opts = {}) {
  const perms = new Set();
  const principal = req.user;
  if (!principal) return perms;

  const workspaceId = principal.workspaceId;
  const projectId   = opts.projectId || principal.projectId || null;

  // ── 1. Service account (Phase 4) ──
  if (principal.kind === "service_account") {
    const role = principal.role || "editor";
    for (const p of BUILTIN_ROLE_PERMS[role] || []) perms.add(p);
    await mergeResourceGrants(perms, "service_account", principal.id, opts);
    return perms;
  }

  // ── 2. Workspace-level admin (inherits everything in the workspace) ──
  const wsMembership = await getWorkspaceMembership(principal.id, workspaceId);
  if (wsMembership?.role === "admin") {
    perms.add(ALL);
    for (const p of BUILTIN_ROLE_PERMS.admin) perms.add(p);
    for (const p of WORKSPACE_ADMIN_EXTRA_PERMS) perms.add(p);
    return perms;
  }

  // ── 3. Project-level built-in role ──
  if (projectId) {
    const projMembership = await getProjectMembership(principal.id, projectId);
    if (projMembership?.role) {
      for (const p of BUILTIN_ROLE_PERMS[projMembership.role] || []) {
        perms.add(p);
      }
    }
  }

  // ── 4. Custom role grants (workspace OR project scope) ──
  await mergeCustomRoleGrants(perms, principal.id, workspaceId, projectId);

  // ── 5. Active JIT grants ──
  await mergeJitGrants(perms, principal.id, workspaceId, projectId);

  // ── 6. Resource-level grants ──
  if (opts.resourceType && opts.resourceId) {
    await mergeResourceGrants(perms, "user", principal.id, opts);
  }

  return perms;
}

/**
 * Express middleware factory.
 *
 *   requirePermission("workflow.update")
 *
 * Optionally derives the resource id from req.params / req.body for
 * resource-level grant resolution.
 */
export function requirePermission(permission, opts = {}) {
  return async (req, _res, next) => {
    try {
      if (!req.user) throw new UnauthorizedError("authentication required");

      const resolveCtx = {
        projectId: req.user.projectId,
        ...(opts.resourceType ? { resourceType: opts.resourceType } : {}),
        ...(opts.resourceIdFrom
          ? { resourceId: pluck(req, opts.resourceIdFrom) }
          : {}),
      };
      const effective = await resolveEffectivePermissions(req, resolveCtx);
      if (effective.has(ALL) || effective.has(permission)) {
        req.permissions = effective;
        return next();
      }
      throw new ForbiddenError(
        `permission denied: ${permission}`,
        { need: permission },
      );
    } catch (e) { next(e); }
  };
}

/**
 * Helper for routes that want to make their own decision: pass the
 * request + the permission, get back a boolean.
 */
export async function hasPermission(req, permission, opts = {}) {
  const eff = await resolveEffectivePermissions(req, opts);
  return eff.has(ALL) || eff.has(permission);
}

// ════════════════════════════════════════════════════════════════════
// Internals — DB lookups
// ════════════════════════════════════════════════════════════════════

async function getWorkspaceMembership(userId, workspaceId) {
  if (!userId || !workspaceId) return null;
  const { rows } = await pool.query(
    `SELECT role FROM workspace_members
      WHERE user_id = $1 AND workspace_id = $2
      LIMIT 1`,
    [userId, workspaceId],
  );
  if (rows.length) return rows[0];
  // Fall back to users.role + users.workspace_id — pre-RBAC-v2 rows
  // didn't always populate workspace_members, especially for the
  // bootstrap admin.
  const { rows: u } = await pool.query(
    `SELECT role FROM users
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [userId, workspaceId],
  );
  return u[0] || null;
}

async function getProjectMembership(userId, projectId) {
  const { rows } = await pool.query(
    `SELECT role FROM project_members
      WHERE user_id = $1 AND project_id = $2
      LIMIT 1`,
    [userId, projectId],
  );
  return rows[0] || null;
}

async function mergeCustomRoleGrants(perms, userId, workspaceId, projectId) {
  // Two-step: find grants for this user in any matching scope, then
  // fetch the custom roles. Two queries are cheaper than a join when
  // the per-user grant count is small.
  const { rows: grants } = await pool.query(
    `SELECT custom_role_id
       FROM role_grants
      WHERE user_id = $1
        AND (
          (scope_type = 'workspace' AND scope_id = $2)
          OR (scope_type = 'project' AND scope_id = $3)
        )
        AND custom_role_id IS NOT NULL`,
    [userId, workspaceId, projectId || "00000000-0000-0000-0000-000000000000"],
  );
  if (!grants.length) return;

  const ids = grants.map(g => g.custom_role_id);
  const { rows: roles } = await pool.query(
    `SELECT permissions FROM custom_roles WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of roles) {
    const list = Array.isArray(r.permissions) ? r.permissions : [];
    for (const p of list) perms.add(p);
  }
}

async function mergeJitGrants(perms, userId, workspaceId, projectId) {
  const { rows } = await pool.query(
    `SELECT role
       FROM jit_grants
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND (
          (scope_type = 'workspace' AND scope_id = $2)
          OR (scope_type = 'project' AND scope_id = $3)
        )`,
    [userId, workspaceId, projectId || "00000000-0000-0000-0000-000000000000"],
  );
  for (const g of rows) {
    const set = BUILTIN_ROLE_PERMS[g.role];
    if (set) for (const p of set) perms.add(p);
  }
}

async function mergeResourceGrants(perms, principalType, principalId, opts) {
  if (!opts?.resourceType || !opts?.resourceId) return;
  const { rows } = await pool.query(
    `SELECT permissions FROM resource_grants
      WHERE resource_type  = $1
        AND resource_id    = $2
        AND principal_type = $3
        AND principal_id   = $4`,
    [opts.resourceType, opts.resourceId, principalType, principalId],
  );
  for (const r of rows) {
    const list = Array.isArray(r.permissions) ? r.permissions : [];
    for (const p of list) perms.add(p);
  }
}

/** Extract a value from req via dotted path, e.g. "params.id". */
function pluck(req, path) {
  const parts = path.split(".");
  let cur = req;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ────────────────────────────────────────────────────────────────────
// Catalogue — exposed so the custom-roles admin UI can render a
// picker. Returns the canonical list of permission strings plus a
// human-friendly description for each, grouped by resource family.
//
// This is the only place that knows the full universe of permission
// names — every API endpoint registers its `requirePermission(...)`
// against one of these strings. If you add a new permission, add it
// here so admins can find it when authoring a custom role.
// ────────────────────────────────────────────────────────────────────
const PERMISSION_CATALOG = [
  // Workflows
  { name: "workflow.read",    group: "Workflows", description: "View workflow definitions and history" },
  { name: "workflow.create",  group: "Workflows", description: "Create new workflows" },
  { name: "workflow.update",  group: "Workflows", description: "Edit existing workflows" },
  { name: "workflow.delete",  group: "Workflows", description: "Delete workflows" },
  { name: "workflow.run",     group: "Workflows", description: "Run / execute workflows" },

  // Triggers
  { name: "trigger.read",     group: "Triggers",  description: "View triggers" },
  { name: "trigger.create",   group: "Triggers",  description: "Create new triggers" },
  { name: "trigger.update",   group: "Triggers",  description: "Edit triggers" },
  { name: "trigger.delete",   group: "Triggers",  description: "Delete triggers" },
  { name: "trigger.fire",     group: "Triggers",  description: "Manually fire a trigger" },

  // Configs (credentials)
  { name: "config.read",            group: "Configs", description: "View credential metadata (not the secret values)" },
  { name: "config.create",          group: "Configs", description: "Create credentials" },
  { name: "config.update",          group: "Configs", description: "Edit credentials" },
  { name: "config.delete",          group: "Configs", description: "Delete credentials" },
  { name: "config.reveal_secret",   group: "Configs", description: "See decrypted secret values" },
  { name: "config.share_workspace", group: "Configs", description: "Promote a config to workspace-shared (workspace admin only)" },

  // Agents (LLM personas)
  { name: "agent.read",            group: "Agents", description: "View agents" },
  { name: "agent.create",          group: "Agents", description: "Create agents" },
  { name: "agent.update",          group: "Agents", description: "Edit agents" },
  { name: "agent.delete",          group: "Agents", description: "Delete agents" },
  { name: "agent.share_workspace", group: "Agents", description: "Promote an agent to workspace-shared (workspace admin only)" },

  // Executions
  { name: "execution.read",   group: "Executions", description: "View execution history + logs" },
  { name: "execution.cancel", group: "Executions", description: "Cancel a running execution" },
  { name: "execution.resume", group: "Executions", description: "Resume / skip / edit a failed execution" },
  { name: "execution.delete", group: "Executions", description: "Delete execution history rows" },

  // Memory
  { name: "memory.read",   group: "Memory", description: "Read memory store entries" },
  { name: "memory.write",  group: "Memory", description: "Set or append memory entries" },
  { name: "memory.delete", group: "Memory", description: "Clear memory entries" },

  // Plugins
  { name: "plugin.list",       group: "Plugins", description: "List installed plugins" },
  { name: "plugin.invoke",     group: "Plugins", description: "Toggle plugin enablement in projects" },
  { name: "plugin.install",    group: "Plugins", description: "Install a plugin at workspace level (workspace admin)" },
  { name: "plugin.uninstall",  group: "Plugins", description: "Uninstall a plugin from the workspace (workspace admin)" },

  // Projects
  { name: "project.read",         group: "Projects", description: "List visible projects" },
  { name: "project.update",       group: "Projects", description: "Edit a project's name / metadata" },
  { name: "project.delete",       group: "Projects", description: "Soft-delete a project" },
  { name: "project.create",       group: "Projects", description: "Create new projects (workspace admin)" },
  { name: "project.member.read",  group: "Projects", description: "List project members + their roles" },
  { name: "project.member.write", group: "Projects", description: "Add / remove / change role of project members" },

  // Service accounts
  { name: "service_account.read",   group: "Service accounts", description: "List service accounts + their keys" },
  { name: "service_account.create", group: "Service accounts", description: "Create SAs and issue API keys" },
  { name: "service_account.delete", group: "Service accounts", description: "Disable SAs and revoke keys" },

  // Cross-project + JIT
  { name: "cross_project.grant", group: "Cross-project", description: "Grant `workflow.fire` from one project into another (workspace admin)" },
  { name: "jit.grant",           group: "Just-in-time",  description: "Issue time-bound role elevations (workspace admin)" },

  // Audit
  { name: "audit.read.project",   group: "Audit", description: "Read audit log for your project" },
  { name: "audit.read.workspace", group: "Audit", description: "Read audit log for the whole workspace (workspace admin)" },

  // Quotas
  { name: "quota.read",  group: "Quotas", description: "View token / execution quotas + usage" },
  { name: "quota.write", group: "Quotas", description: "Set or change quotas (workspace admin)" },

  // Workspace
  { name: "workspace.read",   group: "Workspace", description: "Read workspace metadata" },
  { name: "workspace.update", group: "Workspace", description: "Rename the workspace (workspace admin)" },
  { name: "user.read",        group: "Workspace", description: "List workspace members + roles (workspace admin)" },
  { name: "user.write",       group: "Workspace", description: "Add / disable / change users' roles (workspace admin)" },

  // Custom roles + resource grants — meta-permissions for authoring
  // the RBAC system itself. Workspace admins can author roles;
  // project admins can grant existing roles to their team.
  { name: "custom_role.read",   group: "RBAC", description: "View workspace's custom roles" },
  { name: "custom_role.create", group: "RBAC", description: "Define new custom roles (workspace admin)" },
  { name: "custom_role.update", group: "RBAC", description: "Edit custom roles (workspace admin)" },
  { name: "custom_role.delete", group: "RBAC", description: "Delete custom roles (workspace admin)" },
  { name: "custom_role.grant",  group: "RBAC", description: "Assign a custom role to a user (workspace OR project admin)" },
  { name: "resource_grant.read",  group: "RBAC", description: "See who has resource-level access to a specific workflow / config / agent" },
  { name: "resource_grant.write", group: "RBAC", description: "Share a specific workflow / config / agent with a user or service account" },
];

export function listPermissionCatalog() {
  // Return a copy so admins can't mutate the source.
  return PERMISSION_CATALOG.map(p => ({ ...p }));
}

// ────────────────────────────────────────────────────────────────────
// Convenience exports for tests + admin tooling
// ────────────────────────────────────────────────────────────────────
export const __internals = {
  BUILTIN_ROLE_PERMS,
  WORKSPACE_ADMIN_EXTRA_PERMS,
  ALL,
};
