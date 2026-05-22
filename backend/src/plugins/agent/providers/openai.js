// OpenAI Chat Completions provider. Also the right handler for
// anything OpenAI-compatible: Together, Groq, OpenRouter, vLLM, TGI,
// LM Studio — just point `baseUrl` at the proxy. The Ollama provider
// is a separate module only because the default base URL and the
// "you don't need an API key" expectation differ.

import { parseSse, sliceLast } from "../util.js";
import { toDataUrl } from "../imageInput.js";

/**
 * Promote the last user message to OpenAI's content-parts form when
 * the call includes images. Earlier messages (history) stay plain
 * text — they came from prior text-only turns.
 *
 * OpenAI content-parts shape:
 *   { role: "user", content: [
 *       { type: "text",      text: "..."      },
 *       { type: "image_url", image_url: { url: "<https or data URL>" } },
 *   ]}
 */
function buildMessages(system, messages, images) {
  const head = [{ role: "system", content: system }];
  if (!images?.length) return [...head, ...messages];

  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLastUser = i === messages.length - 1 && m.role === "user";
    if (!isLastUser) { out.push(m); continue; }
    out.push({
      role:    "user",
      content: [
        { type: "text", text: String(m.content ?? "") },
        ...images.map(img => ({
          type: "image_url",
          image_url: { url: toDataUrl(img) },
        })),
      ],
    });
  }
  return [...head, ...out];
}

export async function call({ cfg, system, messages, maxTokens, images }) {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model:       cfg.model,
      max_tokens:  maxTokens,
      messages:    buildMessages(system, messages, images),
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (openai): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const inputTokens  = data?.usage?.prompt_tokens     ?? 0;
  const outputTokens = data?.usage?.completion_tokens ?? 0;
  // When the response looks empty (no text + no tokens) we log what
  // came back so a misconfigured baseUrl / proxy / mock mismatch
  // can be diagnosed from worker logs in one read. Only fires on the
  // suspicious case; the common happy path stays silent.
  if (!text && inputTokens === 0 && outputTokens === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[openai-provider] empty response from ${url} — ` +
      `status=${res.status}, body=${sliceLast(JSON.stringify(data), 400)}`,
    );
  }
  return {
    text,
    usage: { inputTokens, outputTokens },
  };
}

export async function callStreaming({ cfg, system, messages, maxTokens, images, onText }) {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model:        cfg.model,
      max_tokens:   maxTokens,
      stream:       true,
      stream_options: { include_usage: true }, // → final chunk carries usage
      messages:     buildMessages(system, messages, images),
      temperature:  0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (openai): ${res.status} ${sliceLast(txt, 500)}`);
  }

  let acc = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const evt of parseSse(res.body)) {
    if (evt.data === "[DONE]") break;
    let parsed;
    try { parsed = JSON.parse(evt.data); } catch { continue; }
    const delta = parsed?.choices?.[0]?.delta?.content || "";
    if (delta) {
      acc += delta;
      try { onText(delta); } catch { /* listener errors don't kill the stream */ }
    }
    // Final chunk under stream_options.include_usage carries totals.
    if (parsed?.usage) {
      usage.inputTokens  = parsed.usage.prompt_tokens     ?? usage.inputTokens;
      usage.outputTokens = parsed.usage.completion_tokens ?? usage.outputTokens;
    }
  }
  return { text: acc, usage };
}
