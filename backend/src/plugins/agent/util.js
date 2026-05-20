// Shared helpers for the `agent` action plugin.
//
// Lives outside src/plugins/builtin/ so the plugin auto-loader doesn't
// register it as an action.

import { pool } from "../../db/pool.js";

/**
 * Look up the agent row + its linked ai.provider config from
 * ctx.config[config_name]. The configs map is loaded into ctx.config by
 * the worker at execution start, so the plaintext apiKey is available
 * here without us re-reading the DB.
 */
export async function loadAgent(ctx, title) {
  if (!title || typeof title !== "string") {
    throw new Error("agent: `agent` (title) is required");
  }
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.prompt, a.config_name, a.guardrails_override,
            a.prompt_template_id,
            pt.body AS template_body
       FROM agents a
       LEFT JOIN prompt_templates pt ON pt.id = a.prompt_template_id
      WHERE a.title = $1`,
    [title],
  );
  if (rows.length === 0) {
    throw new Error(
      `agent: no agent titled "${title}". Create one on the Home page → Agents.`,
    );
  }
  const agent = rows[0];
  const cfg = ctx?.config?.[agent.config_name];
  if (!cfg || typeof cfg !== "object") {
    throw new Error(
      `agent "${title}": config "${agent.config_name}" not found. ` +
      `Create a configuration of type ai.provider on the Home page → Configurations.`,
    );
  }
  if (!cfg.apiKey) throw new Error(`agent "${title}": config "${agent.config_name}" has no apiKey set`);
  if (!cfg.model)  throw new Error(`agent "${title}": config "${agent.config_name}" has no model set`);
  if (!cfg.provider) throw new Error(`agent "${title}": config "${agent.config_name}" has no provider set`);
  return { agent, cfg };
}

/**
 * Drive a single LLM turn against the configured provider.
 *
 * Either pass `userText` (single user message — the legacy shape) OR
 * `messages` (full multi-turn array — used when conversation history
 * is being replayed). When both are present, `messages` wins.
 *
 * Returns
 *   { text:   <full response text>,
 *     usage:  { inputTokens, outputTokens } }
 *
 * If `onText` is supplied, text deltas are streamed via SSE.
 */
export async function callProvider({ cfg, system, userText, messages, images, maxTokens = 2048, onText }) {
  const finalMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: String(userText ?? "") }];

  // Normalise images once here so each provider gets a uniform shape.
  // Empty / undefined → empty array (no per-provider conversion path
  // is taken). Vision is attached to the LAST user message — that's
  // the current call's input; history messages stay text-only.
  let normImages = [];
  if (images) {
    const { normaliseImages } = await import("./imageInput.js");
    normImages = normaliseImages(images);
  }

  // Dispatch to the per-provider module. Each module exports `call`
  // (blob response) and `callStreaming` (delta-by-delta via onText).
  // See providers/index.js for the registry.
  const { getProvider } = await import("./providers/index.js");
  const handler = getProvider(cfg.provider);
  const args = { cfg, system, messages: finalMessages, maxTokens, images: normImages };
  return onText
    ? handler.callStreaming({ ...args, onText })
    : handler.call(args);
}

// Trim a string to a maximum length from the right end — used by
// every provider for compact error messages. Lives here so the
// provider modules don't each reinvent it.
export function sliceLast(s, n) {
  return String(s ?? "").slice(0, n);
}

// Per-provider request/response handlers live in ./providers/ — see
// providers/index.js for the registry. The legacy inline
// callAnthropic / callOpenAI / *Streaming functions that used to
// live here have been extracted to providers/anthropic.js and
// providers/openai.js. parseSse stays here so the new modules can
// import it; sliceLast is exported above.

/**
 * Async-iterator over an SSE response body. Yields `{ event, data }`
 * objects, one per `\n\n`-delimited frame. `data` is the raw string
 * (we leave JSON parsing to the caller because Anthropic and OpenAI
 * use different envelope shapes).
 *
 * Tolerates partial frames split across network reads — we accumulate
 * a buffer until we see a `\n\n` terminator, then emit and trim.
 */
export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  // Node's fetch returns a web ReadableStream; for-await iterates Uint8Array chunks.
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) yield ev;
    }
  }
  // Flush any trailing frame (no terminator received).
  buffer += decoder.decode();
  if (buffer.trim()) {
    const ev = parseFrame(buffer);
    if (ev) yield ev;
  }
}

function parseFrame(text) {
  let event = "message";
  let data  = "";
  for (const line of text.split("\n")) {
    if (line.startsWith(":"))            continue;          // SSE comment
    if (line.startsWith("event:"))       event = line.slice(6).trim();
    else if (line.startsWith("data:"))   data += line.slice(5).trim() + "\n";
  }
  data = data.replace(/\n$/, "");
  return data ? { event, data } : null;
}

/**
 * Try to parse the model's text response as JSON. Tolerates a leading /
 * trailing ``` fence (the most common deviation when models add
 * explanatory text). Returns the parsed value on success, or null when
 * nothing valid is found.
 */
export function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Strip a fenced code block if the response is wrapped in one.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;

  // Cheap fast-path: starts with { or [.
  const firstChar = candidate.trim().charAt(0);
  if (firstChar !== "{" && firstChar !== "[") return null;

  try { return JSON.parse(candidate); } catch { /* fall through */ }

  // Last resort: find the first { ... } or [ ... ] span and try to parse it.
  const m = /[\{\[][\s\S]*[\}\]]/.exec(candidate);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * Extract a `confidence` number from a parsed JSON result if the model
 * happened to include one. Accepts values 0–1 or 0–100; normalises both
 * into a 0–1 float. Returns null when absent or non-numeric.
 */
export function extractConfidence(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed.confidence;
  if (typeof c !== "number" || !isFinite(c)) return null;
  if (c >= 0 && c <= 1) return c;
  if (c > 1 && c <= 100) return c / 100;
  return null;
}
