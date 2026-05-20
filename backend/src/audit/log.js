// Single-purpose helper for writing audit log rows.
//
// Design contract:
//
//   await auditLog({
//     req,                              // express request — auto-fills actor + ip + ua
//     action: "graph.update",           // dotted-string action name
//     resource: { type: "graph", id, name },   // optional
//     outcome: "success",               // success | failed | denied (default success)
//     metadata: { … },                  // free-form JSONB
//   });
//
// Calling conventions:
//   • Call AFTER the action succeeds (or in the catch on a known
//     failure mode you want recorded, e.g. login failure).
//   • Always `await`. Audit log writes are part of the operation's
//     security guarantee, not a fire-and-forget side effect.
//   • Failures here log a warning but never throw — an offline
//     audit table can't break user actions. (Compliance regimes
//     that require fail-closed audit should swap this to throw.)
//
// What this module deliberately doesn't do:
//   • No batching. The volume is low enough (one row per
//     user-initiated state change) that a per-event INSERT is
//     cheaper than the bookkeeping for buffering.
//   • No transactional coupling to the audited action. A handler
//     that succeeds then crashes before this fn runs leaves the
//     state change un-audited. The alternative is a CTE-with-
//     audit-insert pattern on every site, which is a much bigger
//     surface area for not-much-more-reliability.

import crypto from "node:crypto";
import { trace } from "@opentelemetry/api";
import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

/**
 * Insert an audit log row.
 *
 * @param {object} args
 * @param {object} [args.req]         Express request (or anything with
 *                                    .user / .ip / .headers).
 * @param {string} args.action        Dotted-string action name.
 * @param {object} [args.resource]    { type, id, name }
 * @param {string} [args.outcome]     success | failed | denied
 * @param {object} [args.metadata]    JSONB payload
 * @param {string} [args.workspaceId] override; defaults to req.user.workspaceId
 * @param {object} [args.actor]       override { id, email, role } —
 *                                    used by login-success (req.user
 *                                    isn't set yet) and login-failed
 *                                    (no user matched at all).
 */
export async function auditLog({
  req,
  action,
  resource = null,
  outcome  = "success",
  metadata = {},
  workspaceId,
  projectId,
  actor,
} = {}) {
  if (!action) {
    log.warn("auditLog called without action; dropping");
    return;
  }
  try {
    const id          = crypto.randomUUID();
    const u           = actor || req?.user || {};
    const traceId     = trace.getActiveSpan()?.spanContext?.()?.traceId || null;
    const ip          = req?.ip || null;
    const userAgent   = (req?.headers?.["user-agent"] || "").slice(0, 500) || null;
    const ws          = workspaceId ?? u.workspaceId ?? null;
    // Project scope is OPTIONAL — workspace-level events (project
    // create/delete, role grants, plugin install) carry NULL on
    // purpose so a "show me workspace-level changes" filter can pick
    // them out. Callers that have a project context should pass it
    // explicitly; we don't auto-fill from req.user.projectId because
    // that's the UI's *active* project, not necessarily the *target*.
    const proj        = projectId ?? null;

    // Actor kind — defaults to 'user' for any caller that doesn't set
    // it, so pre-RBAC-v2 audit sites stay correct. Service-account-
    // initiated rows carry 'service_account', surfaced verbatim from
    // req.user.kind populated by the auth middleware.
    const actorKind = u.kind || "user";

    await pool.query(
      `INSERT INTO audit_logs (
         id, workspace_id, project_id, actor_id, actor_email, actor_role, actor_kind,
         action, resource_type, resource_id, resource_name,
         outcome, metadata, ip, user_agent, trace_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        ws,
        proj,
        u.id    || null,
        u.email || null,
        u.role  || null,
        actorKind,
        action,
        resource?.type || null,
        resource?.id   || null,
        // resource_name is bounded so a giant title doesn't bloat the row.
        (resource?.name ? String(resource.name).slice(0, 250) : null),
        outcome,
        JSON.stringify(metadata || {}),
        ip,
        userAgent,
        traceId,
      ],
    );
  } catch (e) {
    // Don't let an audit write blow up a real action. Surface to
    // stderr so an operator can see a chronic audit-write failure
    // (e.g. DB pool exhausted, table missing).
    log.warn("audit write failed", { action, error: e.message });
  }
}

/**
 * Diff two objects and return only the changed keys. Used by the
 * users API to record what actually changed in a role/status update
 * without dumping the entire row into metadata.
 *
 *   diff({ role: "editor" }, { role: "admin" })
 *     → { role: { from: "editor", to: "admin" } }
 */
export function diff(before = {}, after = {}) {
  const out = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (before[k] !== after[k]) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}
