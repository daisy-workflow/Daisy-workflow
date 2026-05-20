// Guardrails orchestrator.
//
// Three responsibilities:
//
//   1. loadProjectPolicy(projectId)
//        — fetch + cache the per-project default policy. Cache TTL
//          is short (30 s) so policy edits propagate without a
//          worker restart but the hot agent path doesn't query the
//          DB on every call.
//
//   2. mergePolicy(projectPolicy, agentOverride)
//        — deep-merge an agent's partial override on top of the
//          project default. Override is JSONB on the agents row.
//
//   3. applyGuardrails({ text, side, policy, ctx })
//        — run the enabled detectors in order, returning a possibly
//          redacted text + the violation list. block mode throws
//          GuardrailBlockedError; warn/redact populate violations
//          without halting.
//
// Violations are recorded async — metering shouldn't slow a
// successful agent response, and a DB hiccup shouldn't fail a
// guardrail check.

import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";
import { getDetector } from "./detectors/index.js";

// Detectors run in this order. PII first so its redactions are what
// downstream toxicity/jailbreak detectors see — masked emails won't
// suddenly look like jailbreak attempts.
const RUN_ORDER = ["pii", "jailbreak", "toxicity"];

// Conservative starting point: every detector enabled=false. Operators
// turn things on via the UI when they're ready. The catalog page also
// shows the defaults so policies start "off but obviously editable".
export const DEFAULT_POLICY = Object.freeze({
  apply_to: "both",
  config: {
    pii:       { enabled: false, mode: "redact", types: ["email", "phone", "ssn", "credit_card", "ipv4", "iban"] },
    toxicity:  { enabled: false, mode: "warn",   threshold: 0.5, categories: [] },
    jailbreak: { enabled: false, mode: "warn",   threshold: 0.5 },
  },
});

/** Surfaced when a detector in block mode fires. The executor's
 *  failure path treats it as a terminal node error. */
export class GuardrailBlockedError extends Error {
  constructor(detector, side, details) {
    super(`Guardrail "${detector}" blocked the ${side}.`);
    this.code     = "GUARDRAIL_BLOCKED";
    this.detector = detector;
    this.side     = side;
    this.details  = details;
  }
}

// ─── policy load + cache ────────────────────────────────────────

const _cache = new Map();    // projectId → { policy, expiresAt }
const CACHE_TTL_MS = 30_000;

export async function loadProjectPolicy(projectId) {
  if (!projectId) return DEFAULT_POLICY;

  const hit = _cache.get(projectId);
  if (hit && hit.expiresAt > Date.now()) return hit.policy;

  let policy;
  try {
    const { rows } = await pool.query(
      `SELECT apply_to, config FROM guardrail_policies WHERE project_id = $1`,
      [projectId],
    );
    policy = rows[0] ? mergeOnDefault(rows[0]) : DEFAULT_POLICY;
  } catch (e) {
    // DB unreachable — treat as no policy so the agent call doesn't
    // fail on a metering issue. Log so it's visible in ops dashboards.
    log.warn("guardrail policy load failed; falling back to defaults", { error: e.message, projectId });
    policy = DEFAULT_POLICY;
  }

  _cache.set(projectId, { policy, expiresAt: Date.now() + CACHE_TTL_MS });
  return policy;
}

/** Invalidate the cache for a project — called from the policy
 *  PUT endpoint so edits take effect on the next call. */
export function evictPolicyCache(projectId) {
  if (projectId) _cache.delete(projectId);
}

function mergeOnDefault(row) {
  return {
    apply_to: row.apply_to || DEFAULT_POLICY.apply_to,
    config: {
      pii:       { ...DEFAULT_POLICY.config.pii,       ...(row.config?.pii       || {}) },
      toxicity:  { ...DEFAULT_POLICY.config.toxicity,  ...(row.config?.toxicity  || {}) },
      jailbreak: { ...DEFAULT_POLICY.config.jailbreak, ...(row.config?.jailbreak || {}) },
    },
  };
}

/**
 * Deep-merge an agent's partial override on top of the project policy.
 * The override is JSONB; we accept it being either the full policy
 * shape or a flat per-detector object. Missing fields fall through.
 */
export function mergePolicy(projectPolicy, agentOverride) {
  if (!agentOverride || typeof agentOverride !== "object") return projectPolicy;
  return {
    apply_to: agentOverride.apply_to || projectPolicy.apply_to,
    config: {
      pii:       { ...projectPolicy.config.pii,       ...(agentOverride.config?.pii       || agentOverride.pii       || {}) },
      toxicity:  { ...projectPolicy.config.toxicity,  ...(agentOverride.config?.toxicity  || agentOverride.toxicity  || {}) },
      jailbreak: { ...projectPolicy.config.jailbreak, ...(agentOverride.config?.jailbreak || agentOverride.jailbreak || {}) },
    },
  };
}

// ─── apply ──────────────────────────────────────────────────────

/**
 * Run guardrails on a single string.
 *
 * @param {object} args
 * @param {string} args.text      Text to scan.
 * @param {"input"|"output"} args.side
 * @param {object} args.policy    Resolved policy (post-merge).
 * @param {object} [args.ctx]     { workspaceId, projectId, executionId, node, agentId, agentTitle }
 *                                  Used only for violation logging.
 *
 * @returns {{ text: string, violations: object[] }}
 *
 * Throws GuardrailBlockedError when a detector in `block` mode fires.
 */
export async function applyGuardrails({ text, side, policy, ctx = {} }) {
  if (!text) return { text, violations: [] };
  if (!policy || policy.apply_to === "none") return { text, violations: [] };
  if (policy.apply_to !== "both" && policy.apply_to !== side) {
    return { text, violations: [] };
  }

  let current = text;
  const violations = [];

  for (const name of RUN_ORDER) {
    const cfg = policy.config?.[name];
    if (!cfg?.enabled) continue;

    let result;
    try {
      const detector = getDetector(name);
      result = await detector.detect(current, cfg);
    } catch (e) {
      // Detector errors are logged but don't fail the user's call —
      // a misbehaving guardrail is strictly less bad than blocking
      // every agent invocation.
      log.warn(`guardrail "${name}" failed`, { error: e.message });
      continue;
    }
    if (!result?.flagged) continue;

    // Translate mode → concrete action. Redact gracefully degrades to
    // warn for detectors that don't expose a redacted form.
    let actionTaken;
    if (cfg.mode === "block") actionTaken = "blocked";
    else if (cfg.mode === "redact" && result.redacted != null) actionTaken = "redacted";
    else actionTaken = "warned";

    violations.push({
      detector:     name,
      mode:         cfg.mode,
      action_taken: actionTaken,
      details:      summariseDetails(name, result),
    });

    if (actionTaken === "redacted") current = result.redacted;
    if (actionTaken === "blocked") {
      // Persist before throwing so the audit row exists.
      recordViolations(ctx, side, violations).catch(() => {});
      throw new GuardrailBlockedError(name, side, result);
    }
  }

  if (violations.length) {
    recordViolations(ctx, side, violations).catch(() => {});
  }
  return { text: current, violations };
}

/**
 * Per-detector details whitelist. Raw user text never enters the
 * audit log — only the masked previews / category scores.
 */
function summariseDetails(name, result) {
  if (name === "pii") {
    return {
      // Counts per type lets the violations feed show "5 emails, 1 SSN"
      // without ever persisting the values.
      counts: countBy(result.matches, m => m.type),
      samples: result.matches.slice(0, 5).map(m => ({ type: m.type, preview: m.valuePreview })),
    };
  }
  if (name === "toxicity") {
    return { categories: result.categories || [], skipped: result.skipped || false };
  }
  if (name === "jailbreak") {
    return { score: result.score, rules: result.matched?.map(m => m.id) || [] };
  }
  return result;
}

function countBy(arr, fn) {
  const out = {};
  for (const x of (arr || [])) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function recordViolations(ctx, side, violations) {
  if (!ctx?.workspaceId || !ctx?.projectId) return;
  for (const v of violations) {
    try {
      await pool.query(
        `INSERT INTO guardrail_violations
           (id, workspace_id, project_id, execution_id, node,
            agent_id, agent_title, side, detector, mode, action_taken, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          ctx.workspaceId,
          ctx.projectId,
          ctx.executionId || null,
          ctx.node || null,
          ctx.agentId || null,
          ctx.agentTitle || null,
          side,
          v.detector,
          v.mode,
          v.action_taken,
          JSON.stringify(v.details || {}),
        ],
      );
    } catch (e) {
      // Stay quiet — violation logging is best-effort.
      log.warn("guardrail violation insert failed", { error: e.message });
    }
  }
}
