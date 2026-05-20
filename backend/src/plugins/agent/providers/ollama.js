// Ollama provider — local LLMs, OpenAI-compatible API.
//
// Ollama ships an OpenAI-compatible endpoint under /v1 starting with
// version 0.1.14. We could just reuse the openai provider with a
// custom baseUrl, but a dedicated module gives us:
//   • a sane default baseUrl (http://localhost:11434/v1)
//   • no apiKey requirement (Ollama doesn't authenticate by default;
//     operators that proxy it behind nginx + basic-auth can still
//     set apiKey and we'll send it as a bearer)
//   • a clear separate row in pricing/metrics (Ollama runs free —
//     dollar cost = 0)
//
// Config maps:
//   cfg.model   e.g. llama3.1:8b, mistral, qwen2.5-coder:7b
//   cfg.baseUrl optional, defaults to http://localhost:11434/v1
//   cfg.apiKey  optional — only used when set

import { parseSse, sliceLast } from "../util.js";

const DEFAULT_BASE = "http://localhost:11434/v1";

function headers(cfg) {
  const h = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

export async function call({ cfg, system, messages, maxTokens }) {
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      model:       cfg.model,
      max_tokens:  maxTokens,
      messages:    [{ role: "system", content: system }, ...messages],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (ollama): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return {
    text,
    usage: {
      inputTokens:  data?.usage?.prompt_tokens     ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

export async function callStreaming({ cfg, system, messages, maxTokens, onText }) {
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      model:        cfg.model,
      max_tokens:   maxTokens,
      stream:       true,
      messages:     [{ role: "system", content: system }, ...messages],
      temperature:  0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (ollama): ${res.status} ${sliceLast(txt, 500)}`);
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
      try { onText(delta); } catch { /* see openai comment */ }
    }
    if (parsed?.usage) {
      usage.inputTokens  = parsed.usage.prompt_tokens     ?? usage.inputTokens;
      usage.outputTokens = parsed.usage.completion_tokens ?? usage.outputTokens;
    }
  }
  return { text: acc, usage };
}
