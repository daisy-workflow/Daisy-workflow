// Retention policies — individual SQL pruners.
//
// Each policy is a small async function that takes an options bag
// (windows + caps), runs ONE bounded DELETE, and returns the number
// of rows it removed. The runner (runner.js) calls these on a
// schedule and aggregates the counts into a structured log line.
//
// Bounded-DELETE pattern:
//   Every policy carries a `limit` (default 50,000) so a single
//   pass can't lock the table for minutes when there's a year of
//   bloat to chew through. The runner re-fires policies that hit
//   the limit until they drain.
//
// CASCADE awareness:
//   • executions.id ← node_states.execution_id   ON DELETE CASCADE
//     (migration 010) — deleting an execution drops its node_states
//     in the same transaction, so we don't have to.
//   • refresh_tokens.rotated_to ← refresh_tokens.id ON DELETE SET NULL
//     (migration 014) — deleting an older row in a rotation chain
//     just nulls out the pointer on its successor, no orphans.

import { pool } from "../db/pool.js";

/**
 * Delete old `executions` rows (and, via FK CASCADE, their node_states).
 *
 *   pruneExecutions({ successDays, failedDays, limit })
 *
 * Success runs are kept for `successDays`; everything terminal that
 * isn't success (failed / cancelled / etc.) is kept for the longer
 * `failedDays` window — that's the data operators actually go back
 * to look at when investigating "what blew up two months ago".
 *
 * Returns { successDeleted, failedDeleted, total }.
 */
export async function pruneExecutions({
  successDays = 90,
  failedDays  = 180,
  limit       = 50_000,
} = {}) {
  // Two separate DELETEs with two separate windows. We don't use a
  // single CASE WHEN status='success' THEN '90' ELSE '180' END
  // formulation because the planner is happier with two narrow
  // statements + the limit can be enforced per slice.
  const successDeleted = await deleteWithLimit(
    `DELETE FROM executions
       WHERE id IN (
         SELECT id FROM executions
          WHERE status = 'success'
            AND created_at < NOW() - $1::interval
          ORDER BY created_at
          LIMIT $2
       )`,
    [`${successDays} days`, limit],
  );
  const failedDeleted = await deleteWithLimit(
    `DELETE FROM executions
       WHERE id IN (
         SELECT id FROM executions
          WHERE status <> 'success'
            AND status IN ('failed', 'cancelled', 'partial')
            AND created_at < NOW() - $1::interval
          ORDER BY created_at
          LIMIT $2
       )`,
    [`${failedDays} days`, limit],
  );
  return {
    successDeleted,
    failedDeleted,
    total: successDeleted + failedDeleted,
  };
}

/**
 * Delete `refresh_tokens` rows that are either revoked or expired,
 * AND were last touched more than `days` ago. Revoked tokens that
 * are newer than the window stay around so the audit trail is
 * useful — "this user logged out last week" is sometimes relevant.
 */
export async function pruneRefreshTokens({
  days  = 30,
  limit = 50_000,
} = {}) {
  return await deleteWithLimit(
    `DELETE FROM refresh_tokens
       WHERE id IN (
         SELECT id FROM refresh_tokens
          WHERE (revoked_at IS NOT NULL OR expires_at < NOW())
            AND COALESCE(revoked_at, expires_at) < NOW() - $1::interval
          ORDER BY COALESCE(revoked_at, expires_at)
          LIMIT $2
       )`,
    [`${days} days`, limit],
  );
}

/**
 * Delete `audit_logs` older than `days`. Audit retention windows
 * tend to be longer than execution retention because compliance
 * regimes ask for "at least 12 months of access logs." Default
 * 365 days; bump for HIPAA / SOC2 / regulated industries.
 *
 * The bounded LIMIT keeps the DELETE chunked the same way other
 * retention policies do.
 */
export async function pruneAuditLogs({
  days  = 365,
  limit = 50_000,
} = {}) {
  return await deleteWithLimit(
    `DELETE FROM audit_logs
       WHERE id IN (
         SELECT id FROM audit_logs
          WHERE created_at < NOW() - $1::interval
          ORDER BY created_at
          LIMIT $2
       )`,
    [`${days} days`, limit],
  );
}

/**
 * Trim conversation history to the most-recent N turns per
 * conversation. KV memory (`namespace = 'kv'`) is intentional user
 * data and is never touched.
 *
 * One conversation = one (workspace_id, scope, scope_id, key) tuple
 * with namespace = 'history'. We rank rows by `seq` DESC and delete
 * everything past `keepTurns`. Even very long conversations get
 * compressed in a single statement.
 */
export async function pruneConversationHistory({
  keepTurns = 100,
  limit     = 50_000,
} = {}) {
  return await deleteWithLimit(
    `DELETE FROM memories
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY workspace_id, scope,
                                 COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                 key
                    ORDER BY seq DESC
                  ) AS rn
             FROM memories
            WHERE namespace = 'history'
              AND seq IS NOT NULL
         ) ranked
         WHERE rn > $1
         LIMIT $2
       )`,
    [keepTurns, limit],
  );
}

/**
 * Hard-delete soft-deleted projects whose 30-day restore window has
 * elapsed. The Projects API soft-deletes by setting `deleted_at` +
 * `purge_at = NOW() + 30 days`; this policy is the runner that
 * actually removes the rows once that deadline passes.
 *
 * On hard delete, every owned resource cascades:
 *   • graphs, triggers, configs, agents, executions, memories,
 *     service_accounts, api_keys, project_quotas, quota_usage,
 *     project_plugin_grants, cross_project_call_grants
 *
 * That's all wired by the FK constraints in migrations 021 + 022 with
 * ON DELETE CASCADE. We just remove the project row and Postgres
 * handles the rest.
 *
 * Also expires JIT grants whose project disappears — those rows have
 * scope_id pointing at the project, no FK, so we sweep them in the
 * same statement.
 */
export async function purgeDeletedProjects({
  limit = 1_000,
} = {}) {
  // Two-step: find the candidate ids first so we can also clean up the
  // unconstrained jit_grants references. A LEFT-JOIN delete would be
  // less explicit and Postgres' DELETE FROM ... USING ... doesn't
  // play nicely with chained cleanups.
  const { rows: targets } = await pool.query(
    `SELECT id FROM projects
      WHERE deleted_at IS NOT NULL
        AND purge_at   IS NOT NULL
        AND purge_at   < NOW()
      ORDER BY purge_at
      LIMIT $1`,
    [limit],
  );
  if (targets.length === 0) return 0;
  const ids = targets.map(r => r.id);

  // Drop jit_grants where the scope was project-level — these don't
  // have an FK to projects.id, so a plain CASCADE on projects misses
  // them. Cheap unconditional sweep keyed on the id list.
  await pool.query(
    `DELETE FROM jit_grants
      WHERE scope_type = 'project' AND scope_id = ANY($1::uuid[])`,
    [ids],
  );

  // Hard-delete the projects. FK cascades wipe every owned resource.
  const r = await pool.query(
    `DELETE FROM projects WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return r.rowCount || 0;
}

// ────────────────────────────────────────────────────────────────────
// Internal — run a DELETE and return rowCount.
//
// Centralised so the LIMIT-bounded DELETE pattern lives in one place;
// every policy uses it. If the result.rowCount is undefined (some
// drivers in some scenarios), we coerce to 0 so the aggregator's
// `total` arithmetic stays valid.
// ────────────────────────────────────────────────────────────────────

async function deleteWithLimit(sql, params) {
  const r = await pool.query(sql, params);
  return r.rowCount || 0;
}
