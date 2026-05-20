// Loads typed configs from Postgres, decrypts their secrets, and shapes
// them for the engine + the trigger manager.
//
// Two outputs are exposed:
//
//   • loadConfigsMap()  → { <name>: { <key>: <plainValue> } }
//
//     This goes into ctx.config so DSL expressions like
//     `${config.prodDb.host}` resolve via the existing path walker.
//
//   • buildConfigEnv(map) → { CONFIG_<NAME>_<KEY>: <stringValue> }
//
//     Flat env-var-style projection that goes into ctx.env so script-style
//     plugins can read configs the way they'd read process.env.
//     Object-typed values are JSON-stringified; everything else is coerced
//     via String(). Names containing characters that are illegal in env
//     identifiers are upper-snake-cased on the way through.

import { pool } from "../db/pool.js";
import { decryptSecrets } from "./registry.js";
import { log } from "../utils/logger.js";

/**
 * Load configs scoped to a workspace + project, decrypt secret fields,
 * and return as a map keyed by config `name`. Errors on individual
 * rows are logged and that row is skipped — one broken config
 * shouldn't stop the run.
 *
 * RBAC v2 resolution:
 *   • Project-private configs (project_id = $2) take precedence on a
 *     name collision. Lets a project override a shared default.
 *   • Workspace-shared configs (project_id IS NULL AND
 *     shared_at_workspace = true) fill in the gaps. The org's SSO
 *     credentials, company-wide SMTP relay, etc. live here.
 *
 * `workspaceId` is required. `projectId` is optional — callers that
 * don't have a project context (e.g. the workspace-level config-list
 * API used by the admin UI before a project is picked) get the
 * project-private layer skipped and ALL workspace-shared rows.
 */
export async function loadConfigsMap(workspaceId, projectId = null) {
  const out = {};
  if (!workspaceId) {
    log.warn("loadConfigsMap called without workspaceId — returning empty map");
    return out;
  }
  try {
    // DISTINCT ON (name) + ORDER BY project-private DESC ⇒ when the
    // same name exists in both layers, the project-private row wins.
    // When only one layer has it, we get that one.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (name) name, type, data
         FROM configs
        WHERE workspace_id = $1
          AND (
                (project_id = $2)
             OR (project_id IS NULL AND shared_at_workspace = true)
          )
        ORDER BY name, (project_id = $2) DESC NULLS LAST`,
      [workspaceId, projectId],
    );
    // Decrypt all rows in parallel — each KMS call is ~10ms, and we
    // do this once per execution so even at 50 configs the wall-clock
    // cost is dominated by the slowest single call. With the default
    // local provider every call is sync-fast.
    await Promise.all(rows.map(async (row) => {
      try {
        const plain = await decryptSecrets(row.type, row.data || {});
        // Drop the editor-only marker — engine consumers shouldn't see it.
        if (plain.__secret) delete plain.__secret;
        out[row.name] = plain;
      } catch (e) {
        log.warn("config decrypt failed", { name: row.name, error: e.message });
      }
    }));
  } catch (e) {
    // Configs table missing (fresh DB before migrations) → return empty.
    if (e.code === "42P01") return out;
    throw e;
  }
  return out;
}

/** Convert a configs map into env-var-style flat keys. */
export function buildConfigEnv(map) {
  const env = {};
  for (const [name, fields] of Object.entries(map || {})) {
    const NAME = toEnvSegment(name);
    for (const [k, v] of Object.entries(fields || {})) {
      const KEY = toEnvSegment(k);
      env[`CONFIG_${NAME}_${KEY}`] = stringify(v);
    }
  }
  return env;
}

function toEnvSegment(s) {
  return String(s)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string")  return v;
  if (typeof v === "number")  return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  try { return JSON.stringify(v); } catch { return String(v); }
}
