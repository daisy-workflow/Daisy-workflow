// Per-project plugin enablement.
//
// Policy:
//   • Built-in plugins (`source = 'core'`) are always available in
//     every project. They're part of the engine — there's no
//     scenario where a project wants log/delay/transform unavailable.
//
//   • Any other plugin (`source = 'local'` or `source LIKE
//     'marketplace:%'`) requires an explicit row in
//     project_plugin_grants for the active project. Without it,
//     workflows that reference the plugin are rejected at save time
//     and at execute time.
//
//   • Workspace admins can grant/revoke; project admins can too for
//     their own project. Enforcement of WHO can mutate the grants
//     happens at the API layer; this module only resolves them.

import { pool } from "../db/pool.js";

/**
 * Resolve the set of plugin names callable inside the given project.
 *
 * Returns a Set of plugin names. Always includes every `source='core'`
 * plugin in the workspace + every project-granted plugin with enabled
 * = true.
 *
 * @param {string} projectId
 * @returns {Promise<Set<string>>}
 */
export async function getEnabledPluginsForProject(projectId) {
  if (!projectId) {
    // Defensive: no project = nothing granted. The middleware should
    // have refused the request long before we get here.
    return new Set();
  }
  const out = new Set();

  // Core plugins — always allowed. We pull names from the plugins
  // table rather than hardcoding so newly-added builtins are picked
  // up without code changes.
  const coreRes = await pool.query(
    `SELECT name FROM plugins WHERE source = 'core' AND enabled = true`,
  );
  for (const r of coreRes.rows) out.add(r.name);

  // Project-granted non-core plugins.
  const grantRes = await pool.query(
    `SELECT plugin_name
       FROM project_plugin_grants
      WHERE project_id = $1 AND enabled = true`,
    [projectId],
  );
  for (const r of grantRes.rows) out.add(r.plugin_name);

  return out;
}

/**
 * Validate that every action referenced by `parsed.nodes` is allowed
 * to run in the given project. Throws a ValidationError-shaped object
 * with the offending plugin + the project id when the check fails.
 *
 * Centralising this here means there's exactly one rule. Save-time
 * (POST/PUT /graphs), enqueue-time (POST /graphs/:id/execute), and
 * runtime (worker before dispatch) all call this with the model and
 * the project id; the answer is identical at every layer.
 */
export async function validatePluginGrants(parsed, projectId) {
  if (!parsed || !Array.isArray(parsed.nodes)) return;
  if (!projectId) return;     // unreachable in production; permissive in tests

  const allowed = await getEnabledPluginsForProject(projectId);
  const referenced = new Set();
  for (const n of parsed.nodes) {
    if (n && typeof n.action === "string") referenced.add(n.action);
  }
  const missing = [...referenced].filter(a => !allowed.has(a));
  if (missing.length === 0) return;

  // One error per validation pass even when several plugins are
  // missing — the UI surfaces the full list so the project admin can
  // enable them all in one go.
  const err = new Error(
    `plugins not enabled in this project: ${missing.join(", ")}. ` +
    `Ask a project admin to enable them at /project-plugins.`,
  );
  err.code = "PLUGINS_NOT_GRANTED";
  err.statusCode = 403;
  err.missing = missing;
  throw err;
}

/**
 * Upsert / remove a project_plugin_grants row. `enabled = null`
 * removes the grant entirely (useful when an admin wants the project
 * to fall back to the default-no-access state for that plugin); any
 * other boolean writes / updates the row.
 */
export async function setProjectPluginEnabled({
  projectId, pluginName, enabled, grantedBy,
}) {
  if (!projectId || !pluginName) {
    throw new Error("projectId and pluginName are required");
  }
  if (enabled === null) {
    await pool.query(
      `DELETE FROM project_plugin_grants WHERE project_id = $1 AND plugin_name = $2`,
      [projectId, pluginName],
    );
    return { removed: true };
  }
  await pool.query(
    `INSERT INTO project_plugin_grants (project_id, plugin_name, enabled, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, plugin_name) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            granted_by = EXCLUDED.granted_by`,
    [projectId, pluginName, !!enabled, grantedBy || null],
  );
  return { enabled: !!enabled };
}
