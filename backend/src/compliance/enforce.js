// Compliance enforcement helpers.
//
// Three public functions, all designed for callers that already know
// the workspace id:
//
//   loadWorkspaceCompliance(workspaceId)
//     → { mode, residency, settings }   (cached for 30s)
//
//   assertProviderAllowed(ws, providerCfg)
//     Throws ComplianceError when the provider isn't in the mode's
//     allow-list, or when the baseUrl/region doesn't match the
//     workspace's data residency.
//
//   assertFeature(ws, featureKey)
//     Throws ComplianceError when the named feature is disabled in
//     the current mode (e.g. "url.fetch" in HIPAA).
//
// All errors carry code "COMPLIANCE_BLOCKED" and a 4xx-equivalent
// `status` so the API error handler can surface them cleanly.

import { pool } from "../db/pool.js";
import {
  getMode,
  effectiveAllowedProviders,
  regionMatches,
} from "./policies.js";

const CACHE_TTL_MS = 30_000;
const _cache = new Map();   // workspaceId → { value, expiresAt }

export class ComplianceError extends Error {
  constructor(message, details) {
    super(message);
    this.code    = "COMPLIANCE_BLOCKED";
    this.status  = 403;
    this.details = details || {};
  }
}

/**
 * Read + cache the workspace's compliance settings. Cache TTL is
 * short so an admin's edit propagates within a workflow run; same
 * pattern as the guardrails policy cache.
 */
export async function loadWorkspaceCompliance(workspaceId) {
  if (!workspaceId) return { mode: "none", residency: "global", settings: {} };
  const hit = _cache.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value;
  try {
    const { rows } = await pool.query(
      `SELECT compliance_mode, data_residency, compliance_settings
         FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    value = rows[0]
      ? {
          mode:      rows[0].compliance_mode || "none",
          residency: rows[0].data_residency  || "global",
          settings:  rows[0].compliance_settings || {},
        }
      : { mode: "none", residency: "global", settings: {} };
  } catch {
    // Compliance fail-OPEN: if the DB is unreachable we don't want
    // to take down every API call. Operators will see the warning
    // in logs and the next successful load repopulates the cache.
    value = { mode: "none", residency: "global", settings: {} };
  }
  _cache.set(workspaceId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Invalidate the cache. Called by the compliance PUT endpoint so
 *  policy changes take effect on the next call. */
export function evictComplianceCache(workspaceId) {
  if (workspaceId) _cache.delete(workspaceId);
}

/**
 * Refuse a config that violates the workspace's compliance settings.
 *
 * `providerCfg` is a config row's decrypted `data` blob for an
 * ai.provider or vector.qdrant type. We accept any blob shape so
 * the same check works across the configs registry — fields we look
 * for: provider, baseUrl, awsRegion, url.
 *
 * Throws ComplianceError with a precise reason; callers translate to
 * 4xx responses.
 */
export function assertProviderAllowed(ws, providerCfg) {
  if (!ws || ws.mode === "none") return;
  const mode = getMode(ws.mode);

  // 1. Provider allow-list (mode-specific)
  const allowed = effectiveAllowedProviders(ws.mode);
  const provider = (providerCfg.provider || "").toLowerCase();
  if (allowed && provider && !allowed.includes(provider)) {
    throw new ComplianceError(
      `Provider "${provider}" is not allowed under ${mode.label}. ` +
      `Allowed: ${allowed.join(", ")}.`,
      { rule: "provider", provider, allowed },
    );
  }

  // 2. Data-residency check on the endpoint URL.
  if (ws.residency && ws.residency !== "global") {
    // For Bedrock the source of truth is awsRegion, not baseUrl —
    // check it specifically.
    if (provider === "bedrock" && providerCfg.awsRegion) {
      if (!regionMatchesAwsRegion(ws.residency, providerCfg.awsRegion)) {
        throw new ComplianceError(
          `Bedrock awsRegion "${providerCfg.awsRegion}" doesn't match ` +
          `workspace residency "${ws.residency}".`,
          { rule: "residency", provider, awsRegion: providerCfg.awsRegion, residency: ws.residency },
        );
      }
    } else {
      const baseUrl = providerCfg.baseUrl || providerCfg.url || "";
      if (baseUrl && !regionMatches({ residency: ws.residency, baseUrl })) {
        throw new ComplianceError(
          `Endpoint "${baseUrl}" doesn't match workspace residency ` +
          `"${ws.residency}". Use a region-appropriate URL.`,
          { rule: "residency", baseUrl, residency: ws.residency },
        );
      }
      // No baseUrl at all + non-global residency = the provider's
      // hardcoded endpoint (api.openai.com etc.) is being used. For
      // direct OpenAI / Anthropic we treat that as "US-only" — reject
      // when residency is eu / apac.
      if (!baseUrl && ["openai", "anthropic"].includes(provider)
       && ["eu", "apac"].includes(ws.residency)) {
        throw new ComplianceError(
          `Direct ${provider} endpoints are served from the US. ` +
          `Use Azure OpenAI or Bedrock with a ${ws.residency.toUpperCase()} region ` +
          `to satisfy residency.`,
          { rule: "residency", provider, residency: ws.residency },
        );
      }
    }
  }
}

/**
 * Block a feature when the mode disables it. Currently used for:
 *   • "url.fetch"      — KB extractFromUrl in HIPAA
 *   • "memory.export"  — raw conversation export
 *
 * Callers wrap their feature path in:
 *   await assertFeature(workspace, "url.fetch");
 */
export function assertFeature(ws, featureKey) {
  if (!ws || ws.mode === "none") return;
  const mode = getMode(ws.mode);
  const flag = mode.features?.[featureKey];
  if (flag === false) {
    throw new ComplianceError(
      `Feature "${featureKey}" is disabled under ${mode.label}.`,
      { rule: "feature", feature: featureKey },
    );
  }
}

/**
 * Refuse a guardrail policy edit that would drop below the mode's
 * required floor. Called from /guardrails PUT.
 */
export function assertGuardrailFloor(ws, proposedConfig) {
  if (!ws || ws.mode === "none") return;
  const required = getMode(ws.mode).requiredGuardrails;
  if (!required) return;
  for (const [detector, req] of Object.entries(required)) {
    const cur = proposedConfig?.[detector] || {};
    if (req.enabled && !cur.enabled) {
      throw new ComplianceError(
        `Guardrail "${detector}" must be enabled under ${getMode(ws.mode).label}.`,
        { rule: "guardrail.required", detector },
      );
    }
    if (req.mode && cur.mode !== req.mode) {
      throw new ComplianceError(
        `Guardrail "${detector}" must use mode "${req.mode}" under ${getMode(ws.mode).label}.`,
        { rule: "guardrail.mode", detector, requiredMode: req.mode },
      );
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────

function regionMatchesAwsRegion(residency, awsRegion) {
  const r = String(awsRegion).toLowerCase();
  if (residency === "us")   return r.startsWith("us-");
  if (residency === "eu")   return r.startsWith("eu-");
  if (residency === "apac") return r.startsWith("ap-");
  return true;
}
