// Azure OpenAI provider.
//
// Azure ships the same API shape as OpenAI but with three twists:
//   1. The URL hostname is per-tenant: <resource>.openai.azure.com
//   2. The "model" in the URL path is a DEPLOYMENT NAME, not the
//      model id. Azure admins create deployments that pin a model
//      version; you reference the deployment name when calling.
//   3. Auth uses `api-key` header (not Bearer) and an `api-version`
//      query param.
//
// Config maps:
//   cfg.baseUrl           https://<resource>.openai.azure.com   (no trailing slash)
//   cfg.azureDeployment   the deployment name from the Azure portal
//   cfg.azureApiVersion   e.g. 2024-08-01-preview (default below)
//   cfg.apiKey            the key from "Keys and Endpoint" in Azure
//   cfg.model             ignored at request time — the deployment
//                         pins the model — but we keep it on the
//                         config row for cost-lookup + UI display

import { parseSse, sliceLast } from "../util.js";
import { toDataUrl } from "../imageInput.js";

const DEFAULT_API_VERSION = "2024-08-01-preview";

// Same content-parts transform as the OpenAI provider — vision-
// capable Azure deployments accept identical shape, just routed
// through the deployment URL.
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
        ...images.map(img => ({ type: "image_url", image_url: { url: toDataUrl(img) } })),
      ],
    });
  }
  return [...head, ...out];
}

function urlFor(cfg, path) {
  if (!cfg.baseUrl)           throw new Error("agent (azure-openai): baseUrl required (https://<resource>.openai.azure.com)");
  if (!cfg.azureDeployment)   throw new Error("agent (azure-openai): azureDeployment required");
  const base = cfg.baseUrl.replace(/\/$/, "");
  const ver  = cfg.azureApiVersion || DEFAULT_API_VERSION;
  return `${base}/openai/deployments/${encodeURIComponent(cfg.azureDeployment)}/${path}?api-version=${encodeURIComponent(ver)}`;
}

export async function call({ cfg, system, messages, maxTokens, images }) {
  const res = await fetch(urlFor(cfg, "chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key":      cfg.apiKey,
    },
    body: JSON.stringify({
      max_tokens:  maxTokens,
      messages:    buildMessages(system, messages, images),
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (azure-openai): ${res.status} ${sliceLast(txt, 500)}`);
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

export async function callStreaming({ cfg, system, messages, maxTokens, images, onText }) {
  const res = await fetch(urlFor(cfg, "chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key":      cfg.apiKey,
    },
    body: JSON.stringify({
      max_tokens:     maxTokens,
      stream:         true,
      stream_options: { include_usage: true },
      messages:       buildMessages(system, messages, images),
      temperature:    0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (azure-openai): ${res.status} ${sliceLast(txt, 500)}`);
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
