// image.generate — text-to-image plugin.
//
// Two providers in Phase E:
//   • openai  — DALL-E 3 / DALL-E 2 via /images/generations
//   • gemini  — Imagen via :predict on the generativelanguage REST API
//
// The plugin reads credentials from a stored ai.provider config
// (referenced by `configName`), so the same key the agent plugin
// uses powers image generation too. No new config type required.
//
// Output is uniform regardless of provider:
//   { images: [{ url?, b64?, mimeType }], usage: { provider, model, n } }
//
// Cost rollup: a row goes into agent_token_events per call. Token
// counts are 0 (image APIs don't report tokens); cost_micros is
// resolved from the pricing table.

import { randomUUID } from "node:crypto";
import { recordAgentTokenEvent } from "../agent/usage.js";
import { costMicros } from "../agent/pricing.js";

export default {
  name: "image.generate",
  description:
    "Generate an image from a text prompt. Backed by OpenAI DALL-E or " +
    "Google Imagen — both reuse a stored ai.provider config for the api key.",

  inputSchema: {
    type: "object",
    required: ["configName", "prompt"],
    properties: {
      configName: {
        type: "string",
        title: "Provider config",
        description:
          "Name of an ai.provider config (Home → Configurations). Its " +
          "`provider` field selects the backend — openai or gemini.",
      },
      prompt: {
        type: "string",
        title: "Prompt",
        format: "textarea",
      },
      model: {
        type: "string",
        title: "Model override",
        description:
          "Defaults to the config's model. Examples: dall-e-3, dall-e-2, " +
          "imagen-3.0-generate-001, imagen-3.0-fast-generate-001.",
      },
      size: {
        type: "string",
        title: "Image size",
        description: "OpenAI: 1024x1024 / 1024x1792 / 1792x1024. Imagen: ignored — Imagen sizes by aspect.",
        default: "1024x1024",
      },
      n: {
        type: "integer",
        title: "Count",
        minimum: 1, maximum: 8, default: 1,
        description: "Images to generate.",
      },
      quality: {
        type: "string",
        title: "Quality",
        description: "OpenAI only. 'standard' or 'hd' (DALL-E 3). Ignored elsewhere.",
        default: "standard",
      },
      responseFormat: {
        type: "string",
        title: "Response format",
        description:
          "OpenAI only. 'url' returns a temporary URL (~60 min expiry); " +
          "'b64_json' returns the bytes inline. Imagen always returns base64.",
        enum: ["url", "b64_json"],
        default: "url",
      },
    },
  },

  primaryOutput: "images",

  outputSchema: {
    type: "object",
    required: ["images", "usage"],
    properties: {
      images: {
        type: "array",
        description: "Generated images. Each item has `url` OR `b64` (one of them is populated).",
        items: {
          type: "object",
          properties: {
            url:      { type: ["string", "null"] },
            b64:      { type: ["string", "null"] },
            mimeType: { type: "string" },
          },
        },
      },
      usage: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model:    { type: "string" },
          n:        { type: "integer" },
        },
      },
    },
  },

  async execute(input, ctx, hooks) {
    const cfg = ctx?.config?.[input.configName];
    if (!cfg || typeof cfg !== "object") {
      throw new Error(`image.generate: config "${input.configName}" not found`);
    }
    if (!cfg.apiKey && cfg.provider !== "ollama") {
      throw new Error(`image.generate: config "${input.configName}" has no apiKey`);
    }
    const provider = cfg.provider;
    const model = input.model || cfg.model || (provider === "openai" ? "dall-e-3" : "imagen-3.0-fast-generate-001");
    const n     = Math.min(Math.max(Number(input.n) || 1, 1), 8);

    if (hooks?.stream?.log) {
      hooks.stream.log("info", `image.generate ${provider}/${model} n=${n}`);
    }

    const startedAt = Date.now();
    let result;
    if (provider === "openai" || provider === "azure-openai") {
      result = await callOpenAI({ cfg, model, prompt: input.prompt, size: input.size, n, quality: input.quality, responseFormat: input.responseFormat });
    } else if (provider === "gemini") {
      result = await callGemini({ cfg, model, prompt: input.prompt, n });
    } else {
      throw new Error(`image.generate: provider "${provider}" not supported (use openai, azure-openai, or gemini)`);
    }
    const latencyMs = Date.now() - startedAt;

    // Cost rollup. Image APIs don't expose tokens; we map (provider,
    // model) to a per-image cost via the pricing table's hooks.
    // Falls back to 0 when the model isn't in the table — that's
    // acceptable for a not-yet-priced model, just under-counts.
    const cost = costMicros({
      provider,
      model,
      inputTokens:  0,
      outputTokens: 0,
      images: n,
    });

    if (ctx?.execution?.projectId) {
      recordAgentTokenEvent({
        workspaceId: ctx.execution.workspaceId,
        projectId:   ctx.execution.projectId,
        executionId: ctx.execution.id || null,
        agentId:     null,
        agentTitle:  `[image] ${input.configName}`,
        provider,
        model,
        inputTokens:  0,
        outputTokens: 0,
        cacheHit:     false,
        latencyMs,
      }).catch(() => {});
    }

    return {
      images: result.images,
      usage:  { provider, model, n, costMicros: cost },
    };
  },
};

// ─── OpenAI / Azure OpenAI ──────────────────────────────────────

async function callOpenAI({ cfg, model, prompt, size, n, quality, responseFormat }) {
  const isAzure = cfg.provider === "azure-openai";
  const url = isAzure
    ? `${cfg.baseUrl.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(cfg.azureDeployment)}/images/generations?api-version=${encodeURIComponent(cfg.azureApiVersion || "2024-08-01-preview")}`
    : `${(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/images/generations`;

  const body = {
    model,
    prompt,
    n,
    size:            size || "1024x1024",
    response_format: responseFormat || "url",
  };
  if (model === "dall-e-3" || model.startsWith("gpt-image-")) {
    body.quality = quality || "standard";
  }

  const r = await fetch(url, {
    method:  "POST",
    headers: {
      "content-type": "application/json",
      ...(isAzure
        ? { "api-key": cfg.apiKey }
        : { "authorization": `Bearer ${cfg.apiKey}` }),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`image.generate (${cfg.provider}): HTTP ${r.status} ${t.slice(0, 400)}`);
  }
  const json = await r.json();
  const images = (json.data || []).map(d => ({
    url:      d.url      || null,
    b64:      d.b64_json || null,
    mimeType: "image/png",
  }));
  return { images };
}

// ─── Gemini (Imagen) ────────────────────────────────────────────

async function callGemini({ cfg, model, prompt, n }) {
  const base = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${base}/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: n },
  };
  const r = await fetch(url, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`image.generate (gemini): HTTP ${r.status} ${t.slice(0, 400)}`);
  }
  const json = await r.json();
  const preds = json.predictions || [];
  const images = preds.map(p => ({
    url:      null,
    b64:      p.bytesBase64Encoded || null,
    mimeType: p.mimeType || "image/png",
  }));
  return { images };
}
