// Anthropic Messages provider.

import { parseSse, sliceLast } from "../util.js";

/**
 * Anthropic content-blocks shape for the last user message when
 * images are present:
 *
 *   { role: "user", content: [
 *       { type: "text",  text: "..."                                                },
 *       { type: "image", source: { type: "base64", media_type: "image/png", data: "..." }},
 *       // Anthropic also accepts { type: "url", url: "https://..." } since 2024-09;
 *       // we use it for http(s) inputs.
 *   ]}
 */
function buildMessages(messages, images) {
  if (!images?.length) return messages;
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
          type:   "image",
          source: img.kind === "url"
            ? { type: "url", url: img.url }
            : { type: "base64", media_type: img.mimeType, data: img.data },
        })),
      ],
    });
  }
  return out;
}

export async function call({ cfg, system, messages, maxTokens, images }) {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type":      "application/json",
      "x-api-key":         cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      cfg.model,
      max_tokens: maxTokens,
      system,
      messages:   buildMessages(messages, images),
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (anthropic): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
  return {
    text,
    usage: {
      inputTokens:  data?.usage?.input_tokens  ?? 0,
      outputTokens: data?.usage?.output_tokens ?? 0,
    },
  };
}

export async function callStreaming({ cfg, system, messages, maxTokens, images, onText }) {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type":      "application/json",
      "x-api-key":         cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      cfg.model,
      max_tokens: maxTokens,
      stream:     true,
      system,
      messages:   buildMessages(messages, images),
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (anthropic): ${res.status} ${sliceLast(txt, 500)}`);
  }

  let acc = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const evt of parseSse(res.body)) {
    let parsed;
    try { parsed = JSON.parse(evt.data); } catch { continue; }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      usage.inputTokens  = parsed.message.usage.input_tokens  ?? usage.inputTokens;
      usage.outputTokens = parsed.message.usage.output_tokens ?? usage.outputTokens;
    } else if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
      const delta = parsed.delta.text || "";
      if (delta) {
        acc += delta;
        try { onText(delta); } catch { /* see openai comment */ }
      }
    } else if (parsed.type === "message_delta" && parsed.usage?.output_tokens != null) {
      // message_delta carries the CUMULATIVE output_tokens — overwrite.
      usage.outputTokens = parsed.usage.output_tokens;
    }
  }
  return { text: acc, usage };
}
