// Project quotas — enforcement helpers.
//
// Three quota kinds in v1 (matches the CHECK constraint on
// project_quotas.kind):
//
//   • tokens_per_month   — period='month'.  Bumped post-agent-call.
//                          Pre-call check refuses new agent invocations
//                          once the running total >= limit.
//   • executions_per_day — period='day'.    Bumped at execution-enqueue
//                          time (graphs API + triggers + workflow.fire).
//   • storage_bytes      — period='none'.   Schema-only in v1. The API
//                          accepts the limit + lets the UI display
//                          measured usage, but nothing enforces a hard
//                          cap (computing exact bytes consumed across
//                          executions / node_states / memories is
//                          expensive enough we want a separate
//                          periodic sweep, not a per-write check).
//
// Period bucketing:
//   month → period_start = date_trunc('month', NOW())::date
//   day   → period_start = current_date
//   none  → period_start = '1970-01-01'  (a single bucket that
//                                          accumulates forever)
//
// Concurrency:
//   The check-then-increment pattern has a tiny race window where two
//   concurrent operations can both pass the check and then push the
//   total slightly past the limit. For token quotas this is fine — the
//   next call will fail. For executions_per_day we accept the same
//   slack (the alternative is a SELECT … FOR UPDATE on every enqueue,
//   which adds latency to a hot path).

import { pool } from "../db/pool.js";

// ────────────────────────────────────────────────────────────────────
// SQL period helpers — expressed as `period_start` values so the
// UPSERT below can plumb them through a single parameter.
// ────────────────────────────────────────────────────────────────────

function periodStartForKind(kind) {
  if (kind === "tokens_per_month")   return "month";
  if (kind === "executions_per_day") return "day";
  if (kind === "storage_bytes")      return "none";
  throw new Error(`unknown quota kind: ${kind}`);
}

function periodStartLiteral(period) {
  // Return SQL expression text (not a parameter) — `date_trunc` and
  // `CURRENT_DATE` can't be parameterised when used in a CTE that
  // also writes a literal. Keep the trio of options small and
  // hardcoded; no user input flows in here.
  if (period === "month") return `date_trunc('month', NOW())::date`;
  if (period === "day")   return `CURRENT_DATE`;
  if (period === "none")  return `DATE '1970-01-01'`;
  throw new Error(`unknown period: ${period}`);
}

// ────────────────────────────────────────────────────────────────────
// Reads — used by the UI + by the pre-call gate.
// ────────────────────────────────────────────────────────────────────

/** Look up a project's configured limit for one kind. Returns null
 *  when no quota is set (= unlimited). */
export async function getQuota(projectId, kind) {
  if (!projectId) return null;
  const { rows } = await pool.query(
    `SELECT kind, limit_value, period
       FROM project_quotas
      WHERE project_id = $1 AND kind = $2`,
    [projectId, kind],
  );
  return rows[0] || null;
}

/** Current period's usage for one kind. Returns 0 if there's no row
 *  yet for this period — the period-start key on quota_usage rolls
 *  over implicitly. */
export async function getCurrentUsage(projectId, kind) {
  if (!projectId) return 0;
  const period = periodStartForKind(kind);
  const psql = periodStartLiteral(period);
  const { rows } = await pool.query(
    `SELECT usage_value
       FROM quota_usage
      WHERE project_id = $1 AND kind = $2 AND period_start = ${psql}`,
    [projectId, kind],
  );
  return Number(rows[0]?.usage_value || 0);
}

/** One-call snapshot — used by the UI to render the limit + usage
 *  side by side. Returns { kind, limit, usage, period_start, remaining }.
 *  Limit can be null (no quota set ⇒ unlimited). */
export async function getQuotaSnapshot(projectId, kind) {
  const [q, used] = await Promise.all([
    getQuota(projectId, kind),
    getCurrentUsage(projectId, kind),
  ]);
  return {
    kind,
    limit: q ? Number(q.limit_value) : null,
    usage: used,
    period: q?.period || periodStartForKind(kind),
    remaining: q ? Math.max(0, Number(q.limit_value) - used) : null,
  };
}

// ────────────────────────────────────────────────────────────────────
// Increments — fire-and-forget for usage tracking.
// ────────────────────────────────────────────────────────────────────

/** Add `delta` to the current period's usage. Creates the row if it's
 *  the first event in this period. delta=0 is a no-op (saves a write).
 *  Errors are swallowed + logged — usage tracking failing should
 *  never break the user's workflow. */
export async function incrementUsage(projectId, kind, delta) {
  if (!projectId || !delta) return;
  const period = periodStartForKind(kind);
  const psql = periodStartLiteral(period);
  try {
    await pool.query(
      `INSERT INTO quota_usage (project_id, kind, period_start, usage_value)
       VALUES ($1, $2, ${psql}, $3)
       ON CONFLICT (project_id, kind, period_start)
       DO UPDATE SET usage_value = quota_usage.usage_value + EXCLUDED.usage_value,
                     updated_at  = NOW()`,
      [projectId, kind, delta],
    );
  } catch (e) {
    // Don't propagate. Metering data loss is acceptable; failing the
    // user's run because the usage table is unreachable is not.
    // The operator sees this in the API logs.
    // eslint-disable-next-line no-console
    console.warn("quotas.incrementUsage failed", { kind, error: e.message });
  }
}

// ────────────────────────────────────────────────────────────────────
// Enforcement — pre-action gate.
// ────────────────────────────────────────────────────────────────────

/**
 * Refuse the next action if the project's quota for `kind` is
 * exhausted. Pure read — does NOT increment. Callers should:
 *
 *   1. await assertQuota(projectId, "executions_per_day");
 *   2. // do the action
 *   3. await incrementUsage(projectId, "executions_per_day", 1);
 *
 * Throws a QuotaExceededError-shaped object (statusCode 429, code
 * QUOTA_EXCEEDED) when the running total meets or exceeds the limit.
 * Returns the snapshot for callers that want to surface "you have 10%
 * left" warnings.
 *
 * No-op when no quota is configured.
 */
export async function assertQuota(projectId, kind) {
  if (!projectId) return null;
  const snap = await getQuotaSnapshot(projectId, kind);
  if (snap.limit === null) return snap;
  if (snap.usage >= snap.limit) {
    const err = new Error(
      `quota exceeded for "${kind}" in this project: ` +
      `${snap.usage} / ${snap.limit} this ${snap.period}. ` +
      `Ask a workspace admin to raise the limit at /quotas.`,
    );
    err.code       = "QUOTA_EXCEEDED";
    err.statusCode = 429;
    err.kind       = kind;
    err.snapshot   = snap;
    throw err;
  }
  return snap;
}

/**
 * Convenience: check + increment in one call. Use only when the
 * "action" is just an arithmetic event (e.g. counting tokens after a
 * model returned them) — i.e. the increment is what makes the
 * usage real, not the action.
 */
export async function checkAndIncrement(projectId, kind, delta) {
  await assertQuota(projectId, kind);
  await incrementUsage(projectId, kind, delta);
}

// ────────────────────────────────────────────────────────────────────
// All-snapshot fetch — drives the UI list. Returns one entry per
// known kind even when no quota is configured (limit=null) so the
// admin can see "Tokens: 0 / unlimited" rather than nothing.
// ────────────────────────────────────────────────────────────────────
export const KNOWN_KINDS = ["tokens_per_month", "executions_per_day", "storage_bytes"];

export async function listSnapshots(projectId) {
  return Promise.all(KNOWN_KINDS.map(k => getQuotaSnapshot(projectId, k)));
}
