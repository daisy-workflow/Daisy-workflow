// AWS Bedrock provider.
//
// Uses Bedrock's unified Converse API (introduced 2024) which exposes
// the same chat-style contract across every model in the Bedrock
// catalogue — Claude, Llama, Titan, Mistral, etc. No more per-model
// adapter code; the same request reaches Claude or Llama by changing
// `modelId`.
//
// Auth: AWS SigV4. Config supplies awsRegion + optional explicit
// awsAccessKeyId / awsSecretAccessKey; when blank we fall back to the
// standard AWS credential chain (env, IAM role on EC2/ECS/EKS,
// shared credentials file).
//
// Config maps:
//   cfg.awsRegion           e.g. us-east-1            (required)
//   cfg.model               e.g. anthropic.claude-3-5-sonnet-20241022-v2:0
//   cfg.awsAccessKeyId      optional override
//   cfg.awsSecretAccessKey  optional override
//   cfg.baseUrl             optional override; defaults to
//                           https://bedrock-runtime.<region>.amazonaws.com

import { parseSse, sliceLast } from "../util.js";

function buildClient(cfg) {
  if (!cfg.awsRegion) throw new Error("agent (bedrock): awsRegion required");
  if (!cfg.model)     throw new Error("agent (bedrock): model (Bedrock modelId) required");
  return { region: cfg.awsRegion, modelId: cfg.model };
}

// Lazy import of the AWS SDK + SigV4 signer — keep them out of the
// dev install. Cached at module scope so we don't re-resolve on every
// call.
let _bedrockSdk = null;
async function loadBedrockSdk() {
  if (_bedrockSdk) return _bedrockSdk;
  try {
    const mod = await import("@aws-sdk/client-bedrock-runtime");
    _bedrockSdk = mod;
    return mod;
  } catch (e) {
    throw new Error(
      "Bedrock provider requires @aws-sdk/client-bedrock-runtime. " +
      "Install with `npm install @aws-sdk/client-bedrock-runtime`. " +
      "Original: " + e.message,
    );
  }
}

function buildRuntimeClient(cfg, mod) {
  const { BedrockRuntimeClient } = mod;
  const opts = { region: cfg.awsRegion };
  if (cfg.awsAccessKeyId && cfg.awsSecretAccessKey) {
    opts.credentials = {
      accessKeyId:     cfg.awsAccessKeyId,
      secretAccessKey: cfg.awsSecretAccessKey,
    };
  }
  if (cfg.baseUrl) opts.endpoint = cfg.baseUrl;
  return new BedrockRuntimeClient(opts);
}

// Bedrock Converse expects a slightly different message shape:
//   role: "user" | "assistant"
//   content: [{ text: "…" } | { image: { format, source: { bytes } } }]
//
// Image blocks for Converse:
//   format = "png" | "jpeg" | "gif" | "webp"
//   source.bytes = Uint8Array (the SDK serialises it to base64 for us)
//
// Vision is attached to the last user message only — same rule as
// the OpenAI/Anthropic providers.
async function toConverseMessages(messages, images) {
  const imageBlocks = images?.length ? await Promise.all(images.map(toConverseImage)) : [];
  return messages.map((m, i) => {
    const isLastUser = i === messages.length - 1 && m.role !== "assistant";
    const content = [{ text: String(m.content ?? "") }];
    if (isLastUser && imageBlocks.length) content.push(...imageBlocks);
    return {
      role:    m.role === "assistant" ? "assistant" : "user",
      content,
    };
  });
}

async function toConverseImage(img) {
  let bytes, mimeType;
  if (img.kind === "url") {
    const r = await fetch(img.url);
    if (!r.ok) throw new Error(`agent (bedrock): image fetch ${img.url} → HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
    mimeType = r.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  } else {
    bytes = Buffer.from(img.data, "base64");
    mimeType = img.mimeType;
  }
  // Map mime → Converse format enum.
  const format = ({
    "image/png":  "png",
    "image/jpeg": "jpeg",
    "image/jpg":  "jpeg",
    "image/gif":  "gif",
    "image/webp": "webp",
  })[mimeType] || "png";
  return { image: { format, source: { bytes } } };
}

export async function call({ cfg, system, messages, maxTokens, images }) {
  buildClient(cfg);
  const mod = await loadBedrockSdk();
  const { ConverseCommand } = mod;
  const client = buildRuntimeClient(cfg, mod);
  const out = await client.send(new ConverseCommand({
    modelId:    cfg.model,
    system:     system ? [{ text: system }] : undefined,
    messages:   await toConverseMessages(messages, images),
    inferenceConfig: { maxTokens, temperature: 0.3 },
  }));
  const blocks = out?.output?.message?.content || [];
  const text = blocks.filter(b => b.text).map(b => b.text).join("");
  return {
    text,
    usage: {
      inputTokens:  out?.usage?.inputTokens  ?? 0,
      outputTokens: out?.usage?.outputTokens ?? 0,
    },
  };
}

export async function callStreaming({ cfg, system, messages, maxTokens, images, onText }) {
  buildClient(cfg);
  const mod = await loadBedrockSdk();
  const { ConverseStreamCommand } = mod;
  const client = buildRuntimeClient(cfg, mod);
  const resp = await client.send(new ConverseStreamCommand({
    modelId:    cfg.model,
    system:     system ? [{ text: system }] : undefined,
    messages:   await toConverseMessages(messages, images),
    inferenceConfig: { maxTokens, temperature: 0.3 },
  }));

  let acc = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const evt of resp.stream || []) {
    // The SDK yields tagged-union events. We care about three:
    //   contentBlockDelta — { delta: { text } } streams the text deltas
    //   metadata          — { usage: { inputTokens, outputTokens } } at end
    //   modelStreamErrorException — surface as an error
    if (evt.contentBlockDelta?.delta?.text) {
      const delta = evt.contentBlockDelta.delta.text;
      acc += delta;
      try { onText(delta); } catch { /* see openai comment */ }
    } else if (evt.metadata?.usage) {
      usage.inputTokens  = evt.metadata.usage.inputTokens  ?? usage.inputTokens;
      usage.outputTokens = evt.metadata.usage.outputTokens ?? usage.outputTokens;
    } else if (evt.modelStreamErrorException) {
      throw new Error(`agent (bedrock): ${evt.modelStreamErrorException.message || "stream error"}`);
    }
  }
  return { text: acc, usage };
}

// sliceLast unused here — bedrock errors come from the SDK with
// readable messages. Keep the import out to avoid lint noise.
// eslint-disable-next-line no-unused-vars
const _keepImportsHappy = sliceLast;
