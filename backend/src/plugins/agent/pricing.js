// Per-model pricing — used to convert token counts into dollar cost
// for the project usage rollups.
//
// Rates are listed in DOLLARS per 1,000,000 tokens, separately for
// input and output. We multiply out at record time into MICRO-DOLLARS
// (one-millionth of a dollar) so the column stays integer-typed and
// avoids float drift across millions of rows. $1 = 1,000,000 micros.
//
// Updating rates:
//   • Providers change pricing every few quarters. Operators wanting
//     custom rates (volume discount, internal chargeback markup) can
//     override at runtime via the AGENT_PRICING_OVERRIDES env var —
//     a JSON object that gets merged on top.
//   • An unknown model (e.g. a fresh release that's not in this
//     table yet) falls back to FALLBACK_RATE — log a warning at
//     record time so operators know to add the row.
//
// Rates current as of May 2026. Always verify against the provider's
// pricing page before relying on these for chargeback.

const RATES = {
  // ── Anthropic ───────────────────────────────────────────────
  "claude-sonnet-4-6":                    { input: 3,    output: 15   },
  "claude-sonnet-4-6-20260507":           { input: 3,    output: 15   },
  "claude-sonnet-4-5":                    { input: 3,    output: 15   },
  "claude-sonnet-4-5-20250929":           { input: 3,    output: 15   },
  "claude-sonnet-4":                      { input: 3,    output: 15   },
  "claude-opus-4-6":                      { input: 15,   output: 75   },
  "claude-opus-4-1":                      { input: 15,   output: 75   },
  "claude-haiku-4-5":                     { input: 1,    output: 5    },
  "claude-haiku-4-5-20251001":            { input: 1,    output: 5    },
  "claude-3-5-sonnet-20241022":           { input: 3,    output: 15   },
  "claude-3-5-sonnet-latest":             { input: 3,    output: 15   },
  "claude-3-5-haiku-20241022":            { input: 0.80, output: 4    },
  "claude-3-opus-20240229":               { input: 15,   output: 75   },

  // ── OpenAI ─────────────────────────────────────────────────
  "gpt-4o":                                { input: 2.50, output: 10   },
  "gpt-4o-2024-11-20":                     { input: 2.50, output: 10   },
  "gpt-4o-mini":                           { input: 0.15, output: 0.60 },
  "gpt-4o-mini-2024-07-18":                { input: 0.15, output: 0.60 },
  "o1":                                    { input: 15,   output: 60   },
  "o1-mini":                               { input: 3,    output: 12   },
  "o1-preview":                            { input: 15,   output: 60   },
  "gpt-4-turbo":                           { input: 10,   output: 30   },
  "gpt-3.5-turbo":                         { input: 0.50, output: 1.50 },

  // ── Gemini ──────────────────────────────────────────────────
  "gemini-2.0-flash":                      { input: 0.075, output: 0.30 },
  "gemini-2.0-flash-001":                  { input: 0.075, output: 0.30 },
  "gemini-1.5-pro":                        { input: 1.25,  output: 5    },
  "gemini-1.5-flash":                      { input: 0.075, output: 0.30 },

  // ── AWS Bedrock — same models, same rates, slight margin baked
  //    in by AWS. We use the underlying Anthropic / Meta rates as a
  //    proxy; operators chargeback-marked differently can override
  //    via the env-var overrides hook below.
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { input: 3,    output: 15   },
  "anthropic.claude-3-5-haiku-20241022-v1:0":  { input: 0.80, output: 4    },
  "anthropic.claude-3-opus-20240229-v1:0":     { input: 15,   output: 75   },
  "meta.llama3-1-70b-instruct-v1:0":           { input: 0.99, output: 0.99 },
  "meta.llama3-1-8b-instruct-v1:0":            { input: 0.22, output: 0.22 },

  // ── Ollama — local; zero marginal cost. Models without per-name
  //    rates fall through to FALLBACK_RATE which is zero by design;
  //    operators paying for hardware or hosted Ollama can override.
};

// What to use when the model name isn't in the table. Logged at
// record time so the operator knows to add a row.
const FALLBACK_RATE = { input: 0, output: 0 };

// Read env override once at module load. Format:
//   AGENT_PRICING_OVERRIDES='{"my-custom-model": {"input": 2, "output": 6}}'
let _envOverrides = null;
function envOverrides() {
  if (_envOverrides !== null) return _envOverrides;
  try {
    _envOverrides = JSON.parse(process.env.AGENT_PRICING_OVERRIDES || "{}");
  } catch {
    _envOverrides = {};
  }
  return _envOverrides;
}

/**
 * Resolve the rate for a model. Ollama is special-cased — the
 * provider runs locally so the dollar cost is zero regardless of
 * what model name was passed. Returns { input, output } in dollars
 * per 1M tokens.
 */
export function getRate(provider, model) {
  if (provider === "ollama") return { input: 0, output: 0 };
  const overrides = envOverrides();
  if (overrides[model]) return overrides[model];
  return RATES[model] || FALLBACK_RATE;
}

// Per-image cost in micro-dollars for the image.generate plugin.
// Defaults cover the common DALL-E + Imagen SKUs at standard quality.
// Use AGENT_PRICING_OVERRIDES (same env var as token rates) for new
// SKUs; the override shape is `{ "model": { "perImage": 80000 } }`.
const IMAGE_RATES = {
  "dall-e-3":                       80_000,   // $0.080 per 1024x1024 standard
  "dall-e-3-hd":                   120_000,   // $0.120 per 1024x1024 hd
  "dall-e-2":                       20_000,   // $0.020 per 1024x1024
  "gpt-image-1":                    40_000,   // placeholder; verify when GA
  "imagen-3.0-generate-001":        40_000,   // Imagen 3
  "imagen-3.0-fast-generate-001":   20_000,   // Imagen 3 fast
};

/**
 * Compute the per-call cost in MICRO-DOLLARS. Integer-typed so the
 * DB column doesn't accumulate float drift. To convert to dollars:
 *   dollars = micros / 1_000_000
 *   cents   = micros / 10_000
 *
 * For text agents pass inputTokens + outputTokens; for image.generate
 * pass `images` (count) and the function looks up a per-image rate.
 */
export function costMicros({ provider, model, inputTokens, outputTokens, images }) {
  const overrides = envOverrides();
  // Image-cost path — short-circuits when the caller passes `images`.
  if (Number(images) > 0) {
    const o = overrides[model];
    const perImage = (o && Number.isFinite(o.perImage))
      ? Number(o.perImage)
      : (IMAGE_RATES[model] ?? 0);
    return Math.round(perImage * Number(images));
  }
  const r = getRate(provider, model);
  // dollars-per-million × tokens-in-millions × 1,000,000 micros = micros
  const inMicros  = (Number(inputTokens)  || 0) * r.input;
  const outMicros = (Number(outputTokens) || 0) * r.output;
  return Math.round(inMicros + outMicros);
}

export function microsToDollars(micros) {
  return (Number(micros) || 0) / 1_000_000;
}

/**
 * Detect "floating" model names — strings that resolve to the
 * provider's most recent version rather than pinning a date. Used at
 * agent save time to warn operators that their workflow might silently
 * change behaviour when the provider rolls a new default.
 *
 * Returns null when the model looks safely pinned; a short warning
 * string otherwise.
 */
const FLOATING_PATTERNS = [
  /-latest$/i,
  /^claude-3-5-sonnet$/i,
  /^claude-3-5-haiku$/i,
  /^claude-sonnet-\d$/i,            // claude-sonnet-4 without -YYYYMMDD
  /^claude-opus-\d$/i,
  /^claude-haiku-\d$/i,
  /^gpt-4o$/i,                      // vs gpt-4o-2024-11-20
  /^gpt-4o-mini$/i,
  /^gpt-4-turbo$/i,
  /^gpt-3.5-turbo$/i,
  /^gemini-\d\.\d-(flash|pro)$/i,   // vs gemini-2.0-flash-001
];

export function pinningWarning(model) {
  if (!model) return null;
  for (const re of FLOATING_PATTERNS) {
    if (re.test(model)) {
      return `model "${model}" is a floating alias — pin a dated version (e.g. "claude-sonnet-4-5-20250929") to keep workflow behaviour stable when the provider rolls a new default.`;
    }
  }
  return null;
}

export { RATES as KNOWN_MODEL_RATES };
