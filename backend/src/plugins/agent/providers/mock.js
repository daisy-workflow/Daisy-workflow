// In-tree mock provider for the `agent` plugin.
//
// Lets developers build + demo workflows without burning real API
// credits or having an outbound LLM dependency at all. Configure an
// ai.provider row with provider="mock" and a JSON ruleset; every
// agent call against this config returns a deterministic response
// chosen by matching the user's text against the rules.
//
// Config fields used (see backend/src/configs/registry.js):
//
//   mockRules            JSON string. Array of rules, evaluated top
//                        to bottom; first match wins. Each rule:
//                          { match:    "substring" | "/regex/flags",
//                            response: "literal string",
//                            // OR an object that we'll JSON-stringify
//                            // (handy for testing JSON-mode prompts):
//                            responseJson: { ok: true, ... },
//                            // optional: simulate latency
//                            delayMs:  250,
//                            // optional: simulated token usage
//                            inputTokens: 12, outputTokens: 42 }
//
//   mockDefaultResponse  String returned when nothing matched. If
//                        unset, falls back to "[mock] no rule matched".
//
//   model                Echoed back verbatim in the usage record so
//                        the agent's downstream cost calc isn't NaN.
//                        Set to e.g. "mock-gpt" for clarity.
//
// What it intentionally does NOT do:
//   • No tool/function-calling simulation (the agent.tools plugin
//     does its own LLM-roundtrip; that path stays on real providers).
//   • No image-input handling — images on the messages array are
//     ignored, the rule match runs against the last user text only.
//   • No template variables in responses. If you need ${name}-style
//     substitution, bind a prompt template + use a real provider; the
//     point of this provider is determinism, not flexibility.

function lastUserText(messages) {
  // Walk backwards to find the most recent user message — the rule
  // ruleset is meant to match against "what did the human just ask",
  // not the full transcript.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      if (typeof m.content === "string") return m.content;
      // OpenAI content-parts shape: pick out the text segments.
      if (Array.isArray(m.content)) {
        return m.content
          .filter(p => p?.type === "text")
          .map(p => p.text || "")
          .join(" ");
      }
    }
  }
  return "";
}

function parseRules(raw) {
  // mockRules arrives as a JSON STRING in cfg (the config registry
  // stores all fields as strings unless typed otherwise). Allow an
  // already-parsed array too in case a caller bypasses the schema.
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    throw new Error(
      `mock provider: mockRules must be JSON array; got ${typeof raw === "string" ? raw.slice(0, 80) : typeof raw}. Parse error: ${e.message}`,
    );
  }
}

function matches(text, rule) {
  if (rule == null) return false;
  const m = rule.match;
  if (m == null || m === "") return true;       // empty match → catch-all rule
  // /pattern/flags syntax → regex match.
  const re = typeof m === "string" && m.startsWith("/") ? m.match(/^\/(.+)\/([gimsuy]*)$/) : null;
  if (re) {
    try { return new RegExp(re[1], re[2]).test(text); }
    catch { return false; }
  }
  return text.includes(String(m));
}

function pickResponse(rule, cfg) {
  if (rule == null) {
    return cfg.mockDefaultResponse || "[mock] no rule matched";
  }
  if (rule.responseJson !== undefined) {
    return typeof rule.responseJson === "string"
      ? rule.responseJson
      : JSON.stringify(rule.responseJson);
  }
  return String(rule.response ?? "");
}

function buildUsage(rule, text) {
  // Tokens unknown to a mock — provide an approximation so cost
  // dashboards don't see NaN. Real providers report actual tokens;
  // this is just a placeholder that scales with text length.
  const approx = (s) => Math.max(1, Math.ceil(String(s ?? "").length / 4));
  return {
    inputTokens:  Number(rule?.inputTokens)  || approx(text),
    outputTokens: Number(rule?.outputTokens) || approx(text),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function call({ cfg, system, messages /* , maxTokens, images */ }) {
  const rules = parseRules(cfg.mockRules);
  const userText = lastUserText(messages || []);
  const haystack = `${system || ""}\n${userText}`;
  const hit = rules.find(r => matches(haystack, r)) || null;
  if (hit?.delayMs) await sleep(Number(hit.delayMs) || 0);
  const text = pickResponse(hit, cfg);
  return { text, usage: buildUsage(hit, text) };
}

export async function callStreaming({ cfg, system, messages, onText /* , maxTokens, images */ }) {
  // Stream the response in coarse chunks (~16 chars) so the
  // InstanceViewer's Live panel has something to render and
  // downstream stream-aware code paths exercise their callbacks.
  const { text, usage } = await call({ cfg, system, messages });
  const CHUNK = 16;
  for (let i = 0; i < text.length; i += CHUNK) {
    const piece = text.slice(i, i + CHUNK);
    if (typeof onText === "function") {
      try { onText(piece); } catch { /* user callback throw shouldn't kill the stream */ }
    }
    // Tiny pause so the stream is observable rather than synchronous.
    await sleep(2);
  }
  return { text, usage };
}
