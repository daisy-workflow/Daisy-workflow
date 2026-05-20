// Google Gemini provider.
//
// Uses the REST API at https://generativelanguage.googleapis.com. The
// `system` argument maps onto Gemini's `systemInstruction` field; chat
// `messages` map onto `contents` with roles "user" and "model" (note:
// "model" not "assistant" — Gemini's quirk).
//
// Streaming uses the :streamGenerateContent variant with ?alt=sse so
// the response shape matches the rest of our SSE-parsing path.
//
// Config maps:
//   cfg.apiKey   API key from Google AI Studio (or service account
//                token for Vertex AI — operators can point baseUrl
//                at https://aiplatform.googleapis.com/... for that)
//   cfg.model    e.g. gemini-2.0-flash-001
//   cfg.baseUrl  optional override

import { parseSse, sliceLast } from "../util.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Translate OpenAI-style messages into Gemini's `contents` shape.
// system messages are pulled out into systemInstruction; assistant
// becomes "model"; everything else is "user".
/**
 * Translate OpenAI-style messages + Phase E images into Gemini's
 * `contents` shape. Images attach to the last user message as
 * `inlineData` parts. URL inputs are fetched + base64-encoded inline
 * — Gemini doesn't accept arbitrary HTTPS image URLs in the
 * inlineData field (its Files API would be the alternative, but
 * that's an extra round-trip we skip for Phase E).
 */
async function toGemini(system, messages, images) {
  const imageParts = images?.length ? await Promise.all(images.map(toGeminiImagePart)) : [];

  const contents = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role === "assistant" ? "model" : "user";
    const isLastUser = i === messages.length - 1 && m.role === "user";
    const parts = [{ text: String(m.content ?? "") }];
    if (isLastUser) parts.push(...imageParts);
    contents.push({ role, parts });
  }
  return {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
  };
}

async function toGeminiImagePart(img) {
  if (img.kind === "base64") {
    return { inlineData: { mimeType: img.mimeType, data: img.data } };
  }
  // URL → fetch + inline. Capped at 20 MB to keep memory bounded;
  // Gemini's inlineData limit is also ~20 MB.
  const r = await fetch(img.url);
  if (!r.ok) throw new Error(`agent (gemini): image fetch ${img.url} → HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > 20 * 1024 * 1024) {
    throw new Error(`agent (gemini): image at ${img.url} exceeds 20 MB`);
  }
  const mimeType = r.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  return { inlineData: { mimeType, data: buf.toString("base64") } };
}

function extractText(data) {
  const cands = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = cands[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("");
}

export async function call({ cfg, system, messages, maxTokens, images }) {
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    ...(await toGemini(system, messages, images)),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (gemini): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  return {
    text: extractText(data),
    usage: {
      inputTokens:  data?.usageMetadata?.promptTokenCount     ?? 0,
      outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

export async function callStreaming({ cfg, system, messages, maxTokens, images, onText }) {
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    ...(await toGemini(system, messages, images)),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (gemini): ${res.status} ${sliceLast(txt, 500)}`);
  }

  let acc = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const evt of parseSse(res.body)) {
    let parsed;
    try { parsed = JSON.parse(evt.data); } catch { continue; }
    const delta = extractText(parsed);
    if (delta) {
      acc += delta;
      try { onText(delta); } catch { /* see openai comment */ }
    }
    if (parsed?.usageMetadata) {
      usage.inputTokens  = parsed.usageMetadata.promptTokenCount     ?? usage.inputTokens;
      usage.outputTokens = parsed.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
    }
  }
  return { text: acc, usage };
}
