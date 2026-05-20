// Compliance policy registry.
//
// Single source of truth for what each mode enforces. The REST API
// reads these definitions; enforce.js reads these definitions; the
// frontend's "what's enforced" panel reads these definitions. All
// behaviour follows from this file — `compliance_mode` rows in the
// workspaces table just pick a key here.
//
// Adding a new mode = drop an entry in MODES + describe its rules.
// Adding a new rule = a new key on the policy object + a check in
// enforce.js. Keep the policy object flat: shipping subtleties via
// a typed config blob is what got us into the RBAC v2 redesign last
// quarter.

// ─── PROVIDERS ─────────────────────────────────────────────────
//
// `allowedProviders` per mode is intentionally conservative — it
// lists only providers operating with publicly documented BAA
// availability. Operators with bespoke BAAs (e.g., direct OpenAI on
// Enterprise tier) can override via COMPLIANCE_PROVIDER_OVERRIDES
// env var (parsed in policies.js#providerOverrides).
//
// Sources:
//   • https://aws.amazon.com/compliance/hipaa-eligible-services-reference/
//     (Bedrock is HIPAA-eligible in covered regions)
//   • https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-hipaa-hitech
//     (Azure OpenAI is BAA-eligible)

const HIPAA_PROVIDERS = ["bedrock", "azure-openai", "ollama"];
// GDPR doesn't restrict providers per se — every cloud provider has
// a DPA / SCCs. The mode focuses on data subject rights instead.
const GDPR_PROVIDERS  = ["anthropic", "openai", "azure-openai", "gemini", "bedrock", "ollama", "voyage"];

const NO_RESTRICTIONS = {
  allowedProviders:    null,         // null = any
  requiredGuardrails:  null,         // null = no minimum
  auditRetentionDays:  90,
  features: {
    "url.fetch":           true,     // KB extractFromUrl allowed
    "memory.export":       true,     // raw conversation export allowed
  },
  // Data-subject endpoints (GDPR Articles 17 + 20).
  endpoints: {
    "export":  false,
    "erasure": false,
  },
};

export const MODES = Object.freeze({
  none: {
    label: "None",
    description: "No restrictions. Default for new workspaces.",
    ...NO_RESTRICTIONS,
  },

  hipaa: {
    label: "HIPAA",
    description:
      "Restricts providers to BAA-eligible only (Bedrock, Azure OpenAI, " +
      "Ollama). Forces PII redact ON. Audit retention ≥ 6 years. " +
      "Blocks arbitrary URL fetches in workflows.",
    allowedProviders:    HIPAA_PROVIDERS,
    requiredGuardrails: {
      pii: { enabled: true, mode: "redact" },
    },
    auditRetentionDays:  2190,   // 6 years
    features: {
      "url.fetch":     false,     // KB extractFromUrl refuses in HIPAA
      "memory.export": false,
    },
    endpoints: {
      "export":  false,
      "erasure": false,
    },
  },

  gdpr: {
    label: "GDPR",
    description:
      "Adds data-subject endpoints (Article 17 erasure + Article 20 " +
      "export). Forces PII redact ON. Audit retention ≥ 5 years " +
      "(EU member-state typical default).",
    allowedProviders:    GDPR_PROVIDERS,
    requiredGuardrails: {
      pii: { enabled: true, mode: "redact" },
    },
    auditRetentionDays:  1825,   // 5 years
    features: {
      "url.fetch":     true,
      "memory.export": true,
    },
    endpoints: {
      "export":  true,            // GET /compliance/users/:id/export
      "erasure": true,            // DELETE /compliance/users/:id
    },
  },
});


// ─── REGIONS ───────────────────────────────────────────────────
//
// A baseUrl matches a region when it contains the listed substrings.
// Direct openai.com / anthropic.com endpoints don't expose a region
// in the URL — we treat them as "us" (their data centers are
// US-based per their public docs). Operators who need stricter
// guarantees should switch to Azure OpenAI or Bedrock + a regional
// deployment, which carry the region in the URL.

const REGION_PATTERNS = {
  us:   [/\.us[.-]/i, /\bus-(east|west|central)\b/i, /\.amazonaws\.com$/i, /api\.openai\.com/i, /api\.anthropic\.com/i, /us\.api\./i],
  eu:   [/\.eu[.-]/i, /\beu-(west|central|north|south)\b/i, /europe-/i, /eu\.api\./i],
  apac: [/\.ap[.-]/i, /\bap-(southeast|northeast|south|east)\b/i, /asia-/i, /apac\.api\./i],
};

const REGION_LABELS = {
  global: "Global (no restriction)",
  us:     "US",
  eu:     "EU",
  apac:   "Asia-Pacific",
};

export function listModes() {
  return Object.entries(MODES).map(([key, m]) => ({
    key,
    label:       m.label,
    description: m.description,
    allowedProviders:   m.allowedProviders,
    requiredGuardrails: m.requiredGuardrails,
    auditRetentionDays: m.auditRetentionDays,
    features:    m.features,
    endpoints:   m.endpoints,
  }));
}

export function listRegions() {
  return Object.keys(REGION_LABELS).map(key => ({ key, label: REGION_LABELS[key] }));
}

/**
 * Look up a mode by key. Falls back to 'none' for unknown values so
 * a corrupted workspaces row doesn't take the whole API down.
 */
export function getMode(key) {
  return MODES[key] || MODES.none;
}

/**
 * Best-effort region match. Returns true when:
 *   • residency == "global" (always allowed)
 *   • the baseUrl contains a pattern for the residency
 *   • no baseUrl was supplied (we can't reject — provider defaults
 *     are checked at config-save time, not at every runtime call)
 *
 * Per-provider quirks:
 *   • For Azure OpenAI the residency comes from the resource name's
 *     region (which is embedded in the hostname). The patterns above
 *     are sufficient.
 *   • For Bedrock the awsRegion field is the source of truth — we
 *     also check that explicitly in enforce.js.
 */
export function regionMatches({ residency, baseUrl }) {
  if (!residency || residency === "global") return true;
  if (!baseUrl) return true;
  const patterns = REGION_PATTERNS[residency] || [];
  return patterns.some(p => p.test(baseUrl));
}

/** Provider-override env hook — operators with bespoke BAAs can add
 *  providers to the HIPAA allow-list without code changes:
 *
 *    COMPLIANCE_HIPAA_PROVIDERS=anthropic,openai
 *
 *  parsed as a comma-separated list and UNIONed with the built-in
 *  allow-list. Empty / unset = use the built-in only.
 */
export function effectiveAllowedProviders(modeKey) {
  const mode = getMode(modeKey);
  if (!mode.allowedProviders) return null;
  const overrideRaw = process.env[`COMPLIANCE_${modeKey.toUpperCase()}_PROVIDERS`];
  if (!overrideRaw) return mode.allowedProviders;
  const extras = overrideRaw.split(",").map(s => s.trim()).filter(Boolean);
  return Array.from(new Set([...mode.allowedProviders, ...extras]));
}
