// Memory store — backs both the KV plugins and the agent's conversation
// history. One Postgres table (`memories`), two namespaces ('kv' and
// 'history'), discriminated by a nullable `seq` column.
//
// Workspace scoping (PR 2):
//   Every helper now requires a `workspaceId`. Reads filter by it;
//   writes set it. The unique index from migration 012 still uses
//   (scope, scope_id, namespace, key) — workspace_id doesn't need to
//   participate in the uniqueness constraint because in practice
//   scope_id (a graph UUID or similar) is globally unique. The
//   workspace_id column gives us the additional safety net of "this
//   tenant can never see another tenant's memory" without changing
//   the conflict semantics.

import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";

function requireWs(workspaceId) {
  if (!workspaceId) {
    throw new Error("memoryStore: workspaceId is required");
  }
  return workspaceId;
}

/**
 * RBAC v2 — every memory row carries project_id NOT NULL. When the
 * caller has a project context, they pass it through. When they don't
 * (engine paths that haven't been threaded yet), we resolve to the
 * workspace's Default project as a safe fallback. The lookup is cached
 * in-process since default-project lookups are read-heavy and the
 * mapping is effectively static.
 */
const defaultProjectCache = new Map();    // workspaceId → projectId
async function resolveProjectId(workspaceId, projectId) {
  if (projectId) return projectId;
  if (defaultProjectCache.has(workspaceId)) {
    return defaultProjectCache.get(workspaceId);
  }
  const { rows } = await pool.query(
    `SELECT id FROM projects
      WHERE workspace_id = $1 AND slug = 'default' AND deleted_at IS NULL
      LIMIT 1`,
    [workspaceId],
  );
  if (rows.length === 0) {
    throw new Error(`memoryStore: workspace ${workspaceId} has no default project`);
  }
  defaultProjectCache.set(workspaceId, rows[0].id);
  return rows[0].id;
}

// ──────────────────────────────────────────────────────────────────────
// KV (Layer 1)
// ──────────────────────────────────────────────────────────────────────

/** Read a single KV value. Returns null if the row doesn't exist. */
export async function getKv({
  workspaceId, scope = "workflow", scopeId, namespace = "kv", key,
}) {
  requireWs(workspaceId);
  const { rows } = await pool.query(
    `SELECT value FROM memories
       WHERE workspace_id=$5
         AND scope=$1
         AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         AND namespace=$3 AND key=$4 AND seq IS NULL`,
    [scope, scopeId || null, namespace, key, workspaceId],
  );
  return rows[0]?.value ?? null;
}

/**
 * Upsert a KV row. Always sets seq=NULL.
 *
 * The ON CONFLICT target uses index-expression inference against the
 * partial unique index from migration 012 (which COALESCEs scope_id
 * with a sentinel UUID so 'global'-scope rows can also be unique by
 * key). Postgres requires index_expression entries to be wrapped in
 * an extra set of parentheses.
 */
export async function setKv({
  workspaceId, projectId, scope = "workflow", scopeId, namespace = "kv", key, value,
}) {
  requireWs(workspaceId);
  const proj = await resolveProjectId(workspaceId, projectId);
  await pool.query(
    `INSERT INTO memories (id, scope, scope_id, namespace, key, seq, value, workspace_id, project_id)
       VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7, $8)
     ON CONFLICT (
       scope,
       (COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)),
       namespace,
       key
     ) WHERE seq IS NULL
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [uuid(), scope, scopeId || null, namespace, key, JSON.stringify(value), workspaceId, proj],
  );
}

/**
 * Append an item to an array stored under a single KV row. If the row
 * doesn't exist we create it with `[item]`; if it does and the existing
 * value is an array, we push; otherwise we replace with `[item]` (the
 * caller signalled "I want this to be a list" by calling append).
 */
export async function appendKv({
  workspaceId, scope = "workflow", scopeId, namespace = "kv", key, item,
}) {
  const cur = await getKv({ workspaceId, scope, scopeId, namespace, key });
  const next = Array.isArray(cur) ? [...cur, item] : [item];
  await setKv({ workspaceId, scope, scopeId, namespace, key, value: next });
  return next.length;
}

/** Delete a single KV row. Returns true if a row was removed. */
export async function deleteKv({
  workspaceId, scope = "workflow", scopeId, namespace = "kv", key,
}) {
  requireWs(workspaceId);
  const { rowCount } = await pool.query(
    `DELETE FROM memories
       WHERE workspace_id=$5
         AND scope=$1
         AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         AND namespace=$3 AND key=$4 AND seq IS NULL`,
    [scope, scopeId || null, namespace, key, workspaceId],
  );
  return rowCount > 0;
}

/**
 * Bulk-load every KV row for a scope. Used by the worker to preload
 * `ctx.memory` at execution start, so plugins / expressions can read
 * stored values via ${memory.<key>} without a per-call DB round-trip.
 *
 * Returns a flat object { <key>: <value> }.
 */
export async function loadKvForScope({
  workspaceId, scope = "workflow", scopeId, namespace = "kv",
}) {
  requireWs(workspaceId);
  const { rows } = await pool.query(
    `SELECT key, value FROM memories
       WHERE workspace_id=$4
         AND scope=$1
         AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         AND namespace=$3 AND seq IS NULL`,
    [scope, scopeId || null, namespace, workspaceId],
  );
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Conversation history (Layer 2)
// ──────────────────────────────────────────────────────────────────────

/**
 * Append a single turn to a conversation. Each conversation lives under
 * key=<conversationId>, and turns are numbered with a monotonic `seq`.
 *
 * Atomicity: we compute MAX(seq)+1 inside a single SQL statement using
 * a sub-select, so two turns submitted in parallel against the same
 * conversation can't pick the same seq under typical pg isolation. If
 * a UNIQUE-violation does happen (two transactions racing for the same
 * seq), we retry once with a re-read — that handles the rare collision
 * without an explicit lock.
 */
export async function appendHistory({
  workspaceId, projectId, scope = "workflow", scopeId, conversationId, role, content,
}) {
  requireWs(workspaceId);
  const proj = await resolveProjectId(workspaceId, projectId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await pool.query(
        `INSERT INTO memories (id, scope, scope_id, namespace, key, seq, value, workspace_id, project_id)
         SELECT $1, $2, $3, 'history', $4,
                COALESCE(MAX(seq), 0) + 1,
                $5::jsonb,
                $6,
                $7
           FROM memories
          WHERE workspace_id=$6
            AND scope=$2
            AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
            AND namespace='history' AND key=$4`,
        [uuid(), scope, scopeId || null, conversationId,
         JSON.stringify({ role, content }), workspaceId, proj],
      );
      return;
    } catch (e) {
      if (e.code !== "23505") throw e;            // not a uniqueness collision
      if (attempt >= 1) throw e;                   // give up after one retry
    }
  }
}

/**
 * Load the most-recent N turns of a conversation, oldest first (so the
 * caller can pass the array straight to the LLM as `messages`).
 */
export async function loadHistory({
  workspaceId, scope = "workflow", scopeId, conversationId, limit = 20,
}) {
  requireWs(workspaceId);
  const safeLimit = Math.max(0, Math.min(parseInt(limit, 10) || 0, 200));
  if (!safeLimit) return [];
  const { rows } = await pool.query(
    `WITH recent AS (
        SELECT seq, value
          FROM memories
         WHERE workspace_id=$5
           AND scope=$1
           AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
               = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
           AND namespace='history' AND key=$3
         ORDER BY seq DESC
         LIMIT $4
     )
     SELECT value FROM recent ORDER BY seq ASC`,
    [scope, scopeId || null, conversationId, safeLimit, workspaceId],
  );
  return rows.map(r => r.value);
}

/** Delete every turn of a conversation. Returns the number of rows removed. */
export async function clearHistory({
  workspaceId, scope = "workflow", scopeId, conversationId,
}) {
  requireWs(workspaceId);
  const { rowCount } = await pool.query(
    `DELETE FROM memories
       WHERE workspace_id=$4
         AND scope=$1
         AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         AND namespace='history' AND key=$3`,
    [scope, scopeId || null, conversationId, workspaceId],
  );
  return rowCount;
}

// ──────────────────────────────────────────────────────────────────────
// Generic listing — used by the REST endpoint.
// ──────────────────────────────────────────────────────────────────────

export async function listMemories({
  workspaceId, scope, scopeId, namespace, prefix, limit = 200,
}) {
  requireWs(workspaceId);
  const params = [workspaceId];
  const where = [`workspace_id = $1`];
  if (scope)    { params.push(scope);            where.push(`scope = $${params.length}`); }
  if (scopeId)  { params.push(scopeId);          where.push(`scope_id = $${params.length}::uuid`); }
  if (namespace){ params.push(namespace);        where.push(`namespace = $${params.length}`); }
  if (prefix)   { params.push(prefix + "%");     where.push(`key LIKE $${params.length}`); }
  params.push(Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000)));
  const sql = `
    SELECT id, scope, scope_id, namespace, key, seq, value, created_at, updated_at
      FROM memories
      WHERE ${where.join(" AND ")}
      ORDER BY scope, namespace, key, seq NULLS FIRST
      LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}
