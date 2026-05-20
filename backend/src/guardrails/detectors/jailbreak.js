// Jailbreak / prompt-injection heuristic.
//
// Pattern-based — catches the obvious attacks (ignore-prior-prompts,
// role-swap, system-prompt extraction, "DAN" / developer-mode
// framing). Coarse on purpose: this is a tripwire, not a defence-in-
// depth strategy. Teams who need higher recall should chain a
// dedicated model (Lakera Guard, Prompt Guard, etc.) — wireable as a
// fourth detector with the same module shape.
//
// Scoring: each rule carries a weight ∈ (0,1]. The detector's overall
// score is max(weights of matched rules). Flagged when score ≥
// threshold (default 0.5 — catches all "strong" rules without
// firing on the medium ones).
//
// Modes:
//   • block — refuse the call (typical for input-side)
//   • warn  — log only
//   • redact — no-op (no meaningful redaction; behaves like warn)

const RULES = [
  {
    id: "ignore_prior_instructions", weight: 0.9,
    re: /\bignore\s+(?:all|every|the|previous|prior|above)?\s*(?:prior|previous|earlier|above|preceding|prompt|prompts|system|instructions?|rules?|guidelines?)\b/i,
  },
  {
    id: "ignore_safety", weight: 0.95,
    re: /\bignore\s+(?:all\s+)?(?:safety|ethical|moral|content|alignment)\s+(?:rules|guidelines|filters|restrictions|policies|guardrails?)\b/i,
  },
  {
    id: "do_anything_now", weight: 0.95,
    re: /\b(?:DAN(?:\s+mode)?|do\s+anything\s+now)\b/i,
  },
  {
    id: "developer_mode", weight: 0.8,
    re: /\b(?:developer\s+mode|jailbreak(?:\s+mode)?|unfiltered\s+mode|uncensored\s+mode)\b/i,
  },
  {
    id: "system_extract", weight: 0.85,
    re: /\b(?:print|reveal|show|output|repeat|display|tell\s+me|leak)\s+(?:back\s+)?(?:your|the)\s+(?:full\s+)?(?:system\s+prompt|original\s+prompt|initial\s+prompt|instructions|rules|configuration|guidelines)\b/i,
  },
  {
    id: "role_swap_pretend", weight: 0.7,
    re: /\b(?:from\s+now\s+on|starting\s+now|now\s+on|pretend(?:\s+to\s+be)?|act\s+as|role[- ]?play\s+as)\b[^.\n]{0,40}\b(?:you'?re|you\s+are|a\s+\w+\s+who|a\s+system\s+that)\b/i,
  },
  {
    id: "role_injection_prefix", weight: 0.6,
    re: /^(?:system|assistant)\s*:\s/im,
  },
  {
    id: "override_persona", weight: 0.65,
    re: /\b(?:your\s+new\s+(?:role|persona|identity)|forget\s+who\s+you\s+are)\b/i,
  },
];

export const META = {
  name: "jailbreak",
  label: "Jailbreak heuristics",
  description:
    "Pattern matches for prompt-injection attacks (ignore-prior-prompts, role-swap, " +
    "system-prompt extraction, DAN-style framing). Coarse but cheap; recommended as a " +
    "tripwire alongside other defences.",
  modes: ["block", "warn"],
  defaultMode: "warn",
  fields: {
    threshold: {
      label: "Score threshold (0–1)",
      kind: "number",
      min: 0, max: 1, step: 0.05, default: 0.5,
    },
  },
};

export async function detect(text, cfg = {}) {
  if (!text || typeof text !== "string") return { flagged: false, score: 0 };
  const threshold = cfg.threshold ?? 0.5;

  const matched = [];
  let score = 0;
  for (const r of RULES) {
    if (r.re.test(text)) {
      matched.push({ id: r.id, weight: r.weight });
      if (r.weight > score) score = r.weight;
    }
  }
  if (score < threshold) {
    return { flagged: false, score, matched };
  }
  return {
    flagged: true,
    score,
    matched,
    // No redaction — same reasoning as toxicity. The string as a
    // whole carries the attack; partial masking doesn't neutralise it.
    redacted: null,
  };
}
