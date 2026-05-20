// Retention scheduler + aggregator.
//
// What it does:
//   • Reads env-driven windows (RETENTION_*).
//   • Exposes runAll() that calls every policy in turn, with a
//     stable result shape suitable for one log line.
//   • start() registers a croner schedule and runs the daily pass.
//   • stop() cancels the schedule on worker shutdown.
//
// Operating model:
//   The retention pass is "best-effort daily." If RETENTION_ENABLED
//   is false (the dev default), start() is a no-op — engineers don't
//   want their local executions vanishing while they're debugging.
//   Production deployments flip it on.
//
// Drain semantics:
//   Each policy is bounded by RETENTION_BATCH_LIMIT (default 50k).
//   When a policy returns "I deleted exactly the limit", runAll
//   re-fires the same policy up to RETENTION_MAX_PASSES times so a
//   freshly-enabled retention on a year-old DB drains within one
//   nightly window. If it's STILL not done after the cap, the next
//   day's run picks up. No data is "stuck" — just slower to clean.

import { Cron } from "croner";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { log } from "../utils/logger.js";
import {
  pruneExecutions,
  pruneRefreshTokens,
  pruneConversationHistory,
  pruneAuditLogs,
  purgeDeletedProjects,
} from "./policies.js";

const tracer = trace.getTracer("daisy-dag.retention");

// ────────────────────────────────────────────────────────────────────
// Env-driven config — read once at module load.
// ────────────────────────────────────────────────────────────────────

function intEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function boolEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

const CONFIG = Object.freeze({
  enabled:    boolEnv("RETENTION_ENABLED", false),       // safety: opt-in
  schedule:   process.env.RETENTION_SCHEDULE   || "0 3 * * *",   // daily 03:00
  timezone:   process.env.RETENTION_TIMEZONE   || undefined,
  successDays: intEnv("RETENTION_EXECUTIONS_SUCCESS_DAYS", 90),
  failedDays:  intEnv("RETENTION_EXECUTIONS_FAILED_DAYS",  180),
  refreshTokenDays: intEnv("RETENTION_REFRESH_TOKENS_DAYS", 30),
  historyTurns: intEnv("RETENTION_HISTORY_TURNS_PER_CONVERSATION", 100),
  // Audit logs are kept longer by default — typical compliance
  // ask is "at least 12 months of access logs." Bump higher for
  // SOC2 / HIPAA / regulated industries.
  auditLogDays: intEnv("RETENTION_AUDIT_LOG_DAYS", 365),
  batchLimit:   intEnv("RETENTION_BATCH_LIMIT", 50_000),
  maxPasses:    intEnv("RETENTION_MAX_PASSES",  20),    // ~1M rows per nightly run at default
});

export function getConfig() { return CONFIG; }

// ────────────────────────────────────────────────────────────────────
// runAll — invoke every policy. Returns the aggregated counts.
//
// Each policy is wrapped in a try/catch so one broken statement
// (e.g. a missing column on a partially-migrated DB) doesn't stop
// the others from running.
// ────────────────────────────────────────────────────────────────────

export async function runAll() {
  const started = Date.now();
  return await tracer.startActiveSpan("retention.run", async (span) => {
    const result = {
      executions:    { successDeleted: 0, failedDeleted: 0, total: 0, passes: 0 },
      refreshTokens: { deleted: 0,  passes: 0 },
      history:       { deleted: 0,  passes: 0 },
      auditLogs:     { deleted: 0,  passes: 0 },
      projects:      { purged: 0,   passes: 0 },
      errors:        [],
    };
    try {
      // 1. Executions — drain in passes until the bounded DELETE
      //    returns less than the limit.
      await drainPass(async () => {
        const r = await pruneExecutions({
          successDays: CONFIG.successDays,
          failedDays:  CONFIG.failedDays,
          limit:       CONFIG.batchLimit,
        });
        result.executions.successDeleted += r.successDeleted;
        result.executions.failedDeleted  += r.failedDeleted;
        result.executions.total          += r.total;
        result.executions.passes++;
        return r.total >= CONFIG.batchLimit;          // still draining
      }, CONFIG.maxPasses, "pruneExecutions", result);

      // 2. Refresh tokens.
      await drainPass(async () => {
        const n = await pruneRefreshTokens({
          days:  CONFIG.refreshTokenDays,
          limit: CONFIG.batchLimit,
        });
        result.refreshTokens.deleted += n;
        result.refreshTokens.passes++;
        return n >= CONFIG.batchLimit;
      }, CONFIG.maxPasses, "pruneRefreshTokens", result);

      // 3. Conversation history — single pass usually enough
      //    (each row is small). Bounded the same way for safety.
      await drainPass(async () => {
        const n = await pruneConversationHistory({
          keepTurns: CONFIG.historyTurns,
          limit:     CONFIG.batchLimit,
        });
        result.history.deleted += n;
        result.history.passes++;
        return n >= CONFIG.batchLimit;
      }, CONFIG.maxPasses, "pruneConversationHistory", result);

      // 4. Audit logs — longer window, bounded passes.
      await drainPass(async () => {
        const n = await pruneAuditLogs({
          days:  CONFIG.auditLogDays,
          limit: CONFIG.batchLimit,
        });
        result.auditLogs.deleted += n;
        result.auditLogs.passes++;
        return n >= CONFIG.batchLimit;
      }, CONFIG.maxPasses, "pruneAuditLogs", result);

      // 5. Soft-deleted projects past their restore window — hard
      //    delete (CASCADE wipes every owned resource). Lower per-pass
      //    cap because each project deletion fans out across many
      //    tables; we'd rather chunk this finely than have one
      //    monstrous transaction.
      await drainPass(async () => {
        const n = await purgeDeletedProjects({ limit: 100 });
        result.projects.purged += n;
        result.projects.passes++;
        return n >= 100;
      }, CONFIG.maxPasses, "purgeDeletedProjects", result);

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (e) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      result.errors.push({ where: "runAll", message: e.message });
    } finally {
      span.end();
    }

    const durationMs = Date.now() - started;
    log.info("retention pass complete", {
      durationMs,
      executions:    result.executions,
      refreshTokens: result.refreshTokens,
      history:       result.history,
      auditLogs:     result.auditLogs,
      projects:      result.projects,
      errors:        result.errors.length,
    });
    return result;
  });
}

/** Helper: keep calling `step` until it returns false ("nothing
 *  more to do") or `maxPasses` is hit. Errors per-step are captured
 *  in `result.errors` rather than abandoning the whole pass. */
async function drainPass(step, maxPasses, label, result) {
  for (let i = 0; i < maxPasses; i++) {
    try {
      const more = await step();
      if (!more) return;
    } catch (e) {
      result.errors.push({ where: label, message: e.message });
      log.warn(`retention ${label} failed`, { error: e.message });
      return;     // give up this policy for the run; try again next time
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Schedule lifecycle
// ────────────────────────────────────────────────────────────────────

let _job = null;

/** Start the daily schedule. Idempotent — calling twice is a no-op.
 *  No-op when RETENTION_ENABLED is false. */
export function start() {
  if (_job) return _job;
  if (!CONFIG.enabled) {
    log.info("retention disabled (set RETENTION_ENABLED=true to opt in)");
    return null;
  }
  _job = new Cron(CONFIG.schedule, { timezone: CONFIG.timezone }, () => {
    runAll().catch((e) => log.error("retention pass crashed", { error: e.message }));
  });
  log.info("retention scheduled", {
    schedule: CONFIG.schedule,
    timezone: CONFIG.timezone || "local",
    nextRun:  _job.nextRun()?.toISOString?.() || null,
  });
  return _job;
}

/** Stop the schedule (SIGTERM handler in worker.js). */
export function stop() {
  if (_job) {
    try { _job.stop(); } catch { /* ignore */ }
    _job = null;
  }
}
