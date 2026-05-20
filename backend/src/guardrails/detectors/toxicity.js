// Toxicity detector — OpenAI Moderation API.
//
// Free, fast (~100 ms), and well-calibrated across the standard
// content categories. Sends the candidate text to OpenAI's
// moderation endpoint, then flags any category whose score exceeds
// the configured threshold.
//
// Requires OPENAI_API_KEY (or AI_API_KEY as fallback). On installs
// without a key the detector silently no-ops — operators get a
// startup log line via the catalog endpoint indicating it's not
// usable, but a misconfigured guardrail never breaks user calls.
//
// Modes:
//   • block — refuse the call (raised as GuardrailBlockedError upstream)
//   • warn  — log only; the upstream agent call proceeds
//   • redact — no-op for toxicity. There's no meaningful redaction
//             for "this whole message is hateful"; we treat redact
//             as warn so policies that flip everything to redact
//             still produce useful audit rows.

const ENDPOINT = "https://api.openai.com/v1/moderations";
const DEFAULT_MODEL = "omni-moderation-latest";
const REQUEST_TIMEOUT_MS = 8_000;

const CATEGORIES = [
  "hate",
  "hate/threatening",
  "harassment",
  "harassment/threatening",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
  "illicit",
  "illicit/violent",
];

export const META = {
  name: "toxicity",
  label: "Toxicity (OpenAI Moderation)",
  description:
    "Sends text to OpenAI's free moderation endpoint and flags categories above the threshold. " +
    "Requires OPENAI_API_KEY. Suitable for hate / self-harm / sexual / violence detection.",
  modes: ["block", "warn"],
  defaultMode: "warn",
  fields: {
    threshold: {
      label: "Score threshold",
      kind: "number",
      min: 0, max: 1, step: 0.05, default: 0.5,
    },
    categories: {
      label: "Categories to flag",
      kind: "multi-select",
      options: CATEGORIES.map(c => ({ value: c, label: c })),
      // Empty default = flag any category. Operators can narrow.
      default: [],
    },
    model: {
      label: "Moderation model",
      kind: "string",
      default: DEFAULT_MODEL,
    },
  },
};

export async function detect(text, cfg = {}) {
  if (!text || !text.trim()) return { flagged: false };

  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    // Skip silently — better than blocking every agent call when an
    // operator turns guardrails on before wiring the key.
    return { flagged: false, skipped: true, reason: "no OPENAI_API_KEY / AI_API_KEY in env" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: cfg.model || DEFAULT_MODEL,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    return { flagged: false, error: `moderation fetch failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { flagged: false, error: `moderation HTTP ${r.status}: ${t.slice(0, 200)}` };
  }
  const json = await r.json().catch(() => ({}));
  const result = json.results?.[0];
  if (!result) return { flagged: false };

  const threshold = cfg.threshold ?? 0.5;
  const wantedCats = cfg.categories || [];
  const triggered = [];
  for (const [category, score] of Object.entries(result.category_scores || {})) {
    if (score < threshold) continue;
    if (wantedCats.length && !wantedCats.includes(category)) continue;
    triggered.push({ category, score: Number(score.toFixed(4)) });
  }
  if (!triggered.length) return { flagged: false };

  // Sort descending by score so the audit log surfaces the loudest
  // signal first.
  triggered.sort((a, b) => b.score - a.score);
  return {
    flagged: true,
    categories: triggered,
    // Toxicity has no meaningful "redacted" form — return the
    // original. Callers in redact mode fall through to warn semantics.
    redacted: null,
  };
}
