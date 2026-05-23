// Config type registry — defines the shape of each `type` of config row.
//
// A type schema looks like:
//
//   {
//     label: "Database",
//     description: "JDBC-style database connection",
//     fields: [
//       { name: "host", type: "string",  required: true,  description: "..." },
//       { name: "port", type: "number",  default: 5432 },
//       { name: "password", type: "string", secret: true },
//       ...
//     ],
//   }
//
// Field types: "string" | "number" | "boolean" | "select" (with `options`).
// Field flags:
//   - required  → reject create/update if missing
//   - secret    → encrypted at rest, masked in /configs list responses
//   - default   → applied at validate-time when the field is missing
//
// `generic` is a special escape hatch: any keys are accepted, and any field
// can be marked `secret` by the user via the editor UI.

import {
  decryptValue,
  isEncrypted,
  isV2Envelope,
  encryptValueWithDek,
  decryptValueWithDek,
  readCryptoBlock,
  writeCryptoBlock,
  removeCryptoBlock,
  wipeBuffer,
} from "./crypto.js";
import { generateDataKey, decryptDataKey } from "../secrets/kms.js";

export const TYPES = Object.freeze({
  database: {
    label: "Database",
    description: "Generic database connection (Postgres, MySQL, etc.)",
    fields: [
      { name: "engine",   type: "select", required: true,
        options: ["postgres", "mysql", "sqlite", "mssql", "oracle"],
        default: "postgres",
        description: "Database engine" },
      { name: "host",     type: "string",  required: true,  description: "Hostname or IP" },
      { name: "port",     type: "number",  description: "TCP port (default depends on engine)" },
      { name: "database", type: "string",  required: true,  description: "Schema / database name" },
      { name: "username", type: "string" },
      { name: "password", type: "string",  secret: true },
      { name: "ssl",      type: "boolean", default: false },
    ],
  },
  "mail.smtp": {
    label: "Mail (SMTP / outgoing)",
    description: "Outgoing SMTP server used by the email.send plugin",
    fields: [
      { name: "host",     type: "string",  required: true },
      { name: "port",     type: "number",  required: true, default: 587 },
      { name: "secure",   type: "boolean", default: false, description: "Use TLS (true for port 465)" },
      { name: "username", type: "string" },
      { name: "password", type: "string",  secret: true },
      { name: "from",     type: "string",  description: "Default From: address" },
    ],
  },
  "mail.imap": {
    label: "Mail (IMAP / incoming)",
    description: "Incoming IMAP server used by the email trigger",
    fields: [
      { name: "host",     type: "string",  required: true },
      { name: "port",     type: "number",  required: true, default: 993 },
      { name: "tls",      type: "boolean", default: true },
      { name: "username", type: "string",  required: true },
      { name: "password", type: "string",  secret: true,  required: true },
      { name: "folder",   type: "string",  default: "INBOX" },
    ],
  },
  mqtt: {
    label: "MQTT broker",
    description: "MQTT broker connection used by the MQTT trigger",
    fields: [
      { name: "url",      type: "string", required: true,
        description: "Broker URL, e.g. mqtt://broker.local:1883 or mqtts://…:8883" },
      { name: "clientId", type: "string" },
      { name: "username", type: "string" },
      { name: "password", type: "string", secret: true },
    ],
  },
  "ai.provider": {
    label: "AI provider",
    description:
      "API credentials for an LLM provider. Referenced by the `agent` " +
      "plugin via a stored agent's config name.",
    fields: [
      { name: "provider", type: "select", required: true,
        options: [
          "anthropic",
          "openai",
          "azure-openai",
          "gemini",
          "bedrock",
          "ollama",
          // Embedding-only providers. The chat-agent dispatcher
          // ignores these (no callProvider mapping) but the RAG
          // embed pipeline can pick them up — keeping them in one
          // config type means a user wiring up RAG uses the same
          // form they already know.
          "voyage",
          // In-tree mock for offline dev + demos. No outbound HTTP;
          // responses come from the `mockRules` field below.
          "mock",
        ],
        default: "anthropic",
        description: "Provider family. Drives the request shape, endpoint, and credential format." },
      { name: "apiKey",   type: "string", secret: true,
        description: "API key. Encrypted at rest. Bedrock + Ollama may not need this — see provider-specific notes." },
      { name: "model",    type: "string", required: true,
        description: "Model id. Examples: claude-sonnet-4-5-20250929, gpt-4o-mini, gemini-2.0-flash-001, anthropic.claude-3-5-sonnet-20241022-v2:0 (Bedrock), llama3.1:8b (Ollama)." },
      { name: "baseUrl",  type: "string",
        description: "Endpoint override. Required for ollama (e.g. http://localhost:11434/v1) and bedrock (e.g. https://bedrock-runtime.us-east-1.amazonaws.com)." },
      // Provider-specific extras. We keep them all here rather than
      // gate per-provider in the UI — the unused fields stay blank
      // and the provider modules ignore them. Avoids a complex
      // conditional schema.
      // `showIf` gates UI visibility — the frontend ConfigDesigner
      // only renders a field when every key/value pair under showIf
      // matches the current form data. Backend validation still allows
      // the field on the row (you can save data for a hidden field via
      // the API), but humans editing through the UI won't be presented
      // with Bedrock fields when they picked OpenAI, etc.
      { name: "azureDeployment", type: "string",
        showIf: { provider: "azure-openai" },
        description: "Azure OpenAI only. The deployment name from your Azure portal (NOT the model name)." },
      { name: "azureApiVersion", type: "string",
        showIf: { provider: "azure-openai" },
        description: "Azure OpenAI only. e.g. 2024-08-01-preview. Defaults to a known-good version." },
      { name: "awsRegion", type: "string",
        showIf: { provider: "bedrock" },
        description: "Bedrock only. e.g. us-east-1. AWS credential chain (env, IAM role) supplies the keys." },
      { name: "awsAccessKeyId",     type: "string", secret: true,
        showIf: { provider: "bedrock" },
        description: "Bedrock only. Optional — leave blank to use the standard AWS credential chain." },
      { name: "awsSecretAccessKey", type: "string", secret: true,
        showIf: { provider: "bedrock" },
        description: "Bedrock only. Optional — leave blank to use the standard AWS credential chain." },
      // ── Mock provider only ────────────────────────────────────────────
      // Only rendered when provider="mock". The default rule set is a
      // working example covering every field of the rule schema in one
      // place: substring + regex match, delayMs (simulated latency),
      // responseJson (JSON-mode prompts), explicit token counts (cost
      // rollup), empty-match catch-all. ConfigDesigner seeds these
      // defaults the moment the user switches provider to mock.
      { name: "mockRules", type: "string", multiline: true,
        showIf: { provider: "mock" },
        description:
          "JSON array of rules; first match wins. " +
          "Each rule: { match: \"substring\" | \"/regex/flags\" | \"\" (catch-all), " +
          "response: \"text\" OR responseJson: {…}, " +
          "delayMs?: number, inputTokens?: number, outputTokens?: number }. " +
          "The default is a working example demonstrating every field once.",
        default: [
          "[",
          "  { \"match\": \"hello\",      \"response\": \"Hi there!\" },",
          "  { \"match\": \"/weather/i\", \"response\": \"It is sunny and 72°F.\", \"delayMs\": 50 },",
          "  { \"match\": \"json\",       \"responseJson\": { \"ok\": true, \"result\": 42 } },",
          "  { \"match\": \"expensive\",  \"response\": \"A long answer here.\", \"inputTokens\": 200, \"outputTokens\": 800 },",
          "  { \"match\": \"\",           \"response\": \"[mock] no specific rule matched\" }",
          "]",
        ].join("\n"),
      },
      { name: "mockDefaultResponse", type: "string", multiline: true,
        showIf: { provider: "mock" },
        description:
          "Response returned when none of the rules in mockRules matched " +
          "AND no catch-all rule (match=\"\") is present. Multi-line allowed.",
        default: "[mock] no rule matched",
      },
    ],
  },
  webhook: {
    label: "Webhook target",
    description:
      "Outbound webhook URL + optional HMAC signing secret. Referenced by " +
      "the webhook.send plugin. Stored separately from raw http.request so " +
      "the URL doesn't have to live in workflow DSL.",
    fields: [
      { name: "url", type: "string", required: true,
        description: "Full URL to POST to (https recommended)." },
      { name: "secret", type: "string", secret: true,
        description:
          "Optional HMAC-SHA256 signing key. When set, every request gets " +
          "an X-Daisy-Signature header so the receiver can verify integrity." },
      { name: "authHeader", type: "string",
        description:
          "Optional Authorization header value (e.g. \"Bearer xyz\"). " +
          "Sent verbatim on every call." },
      { name: "extraHeaders", type: "string",
        description:
          "Optional. JSON object of header name → value, merged in after " +
          "the call-level headers. Useful for routing keys, tenant ids, " +
          "etc. Example: {\"X-Tenant\": \"acme\"}" },
    ],
  },
  slack: {
    label: "Slack workspace",
    description:
      "Slack bot credentials. Referenced by the slack.post plugin. The " +
      "token must be a Bot User OAuth Token (xoxb-…) with chat:write " +
      "scope on the channel(s) you want to post to.",
    fields: [
      { name: "botToken", type: "string", secret: true, required: true,
        description: "Bot User OAuth Token (starts with xoxb-)." },
      { name: "defaultChannel", type: "string",
        description:
          "Optional default channel ID (Cxxxxxx) or name (#general). " +
          "Plugins can override per-call via the `channel` input." },
    ],
  },
  "object.store": {
    label: "Object storage (S3 / GCS / Azure Blob)",
    description:
      "Cloud object storage credentials. Referenced by the object.store.* " +
      "plugins (read / write / list / delete / signed_url). One config per " +
      "bucket — switch providers by changing the `provider` dropdown.",
    fields: [
      { name: "provider", type: "select", required: true,
        options: ["s3", "gcs", "azure"],
        default: "s3",
        description:
          "Backing service. `s3` covers AWS S3 + any S3-compatible store " +
          "(MinIO, Cloudflare R2, DigitalOcean Spaces, Wasabi) — set " +
          "`endpoint` to point at the non-AWS host. `gcs` is Google " +
          "Cloud Storage. `azure` is Azure Blob Storage." },
      { name: "bucket", type: "string", required: true,
        description:
          "Default bucket / container name. Plugins can override per call " +
          "via the `bucket` input." },
      // S3-flavoured fields. Leave blank for GCS / Azure.
      { name: "region", type: "string",
        description:
          "S3 only. AWS region (e.g. us-east-1, eu-west-1). For " +
          "S3-compatible stores any non-empty value usually works." },
      { name: "endpoint", type: "string",
        description:
          "S3 only. Override the endpoint for S3-compatible stores " +
          "(MinIO, R2, etc). Leave blank for AWS S3." },
      { name: "forcePathStyle", type: "boolean", default: false,
        description:
          "S3 only. Set true for MinIO / older S3-compatibles that need " +
          "path-style URLs (bucket in the path, not the hostname)." },
      { name: "accessKeyId", type: "string", secret: true,
        description:
          "S3 only. Leave blank to use the worker's standard AWS " +
          "credential chain (env vars, IAM role)." },
      { name: "secretAccessKey", type: "string", secret: true,
        description: "S3 only. Pair with accessKeyId." },
      // GCS-flavoured fields.
      { name: "gcsCredentialsJson", type: "string", secret: true,
        description:
          "GCS only. JSON service-account key (the file contents). Leave " +
          "blank to use the worker's Application Default Credentials." },
      // Azure-flavoured fields.
      { name: "azureAccount", type: "string",
        description: "Azure only. Storage account name." },
      { name: "azureKey", type: "string", secret: true,
        description:
          "Azure only. Shared key for the storage account. Use this OR " +
          "`azureSas`." },
      { name: "azureSas", type: "string", secret: true,
        description:
          "Azure only. SAS token (preferred over the shared key for " +
          "scoped access). Use this OR `azureKey`." },
    ],
  },
  "vector.qdrant": {
    label: "Qdrant vector store",
    description:
      "Connection details for a Qdrant server. Referenced by knowledge " +
      "bases whose `kb_backend = qdrant`. Self-hosted Qdrant may not " +
      "need an api key; Qdrant Cloud always does.",
    fields: [
      { name: "url", type: "string", required: true,
        description: "Base URL of the Qdrant server. e.g. http://localhost:6333 or https://xyz-abc.eu-central.aws.cloud.qdrant.io" },
      { name: "apiKey", type: "string", secret: true,
        description: "Sent as the `api-key` header. Leave blank for unauthenticated self-hosted clusters." },
    ],
  },
  git: {
    label: "Git remote",
    description:
      "Credentials for the `git` plugin's HTTPS operations (clone / pull / " +
      "push / fetch on private repos). The token is injected into the URL " +
      "via a one-shot http.extraheader so it never lands in .git/config. " +
      "SSH-based git URLs don't need this — they auth via the worker's " +
      "SSH agent / known_hosts.",
    fields: [
      { name: "token",       type: "string", secret: true,
        description: "Personal-access token for the host (GitHub PAT, GitLab PAT, Bitbucket app password). Encrypted at rest." },
      { name: "authorName",  type: "string",
        description: "Default name to stamp on commits made by the git.commit operation." },
      { name: "authorEmail", type: "string",
        description: "Default email to stamp on commits made by the git.commit operation." },
    ],
  },
  generic: {
    label: "Generic (key/value)",
    description: "Freeform key/value bag — for things that don't fit a specific type. " +
                 "Each key can optionally be marked secret.",
    // No declared fields — UI shows a freeform key/value editor and the
    // user picks which rows are secret.
    fields: [],
    freeform: true,
  },
});

/** List the types in a UI-friendly array. */
export function listTypes() {
  return Object.entries(TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description,
    fields: def.fields,
    freeform: !!def.freeform,
  }));
}

/** Get the type definition or throw a friendly error. */
export function getType(type) {
  const def = TYPES[type];
  if (!def) throw new Error(`Unknown config type: ${type}`);
  return def;
}

/**
 * Validate a `data` blob against its type. Returns a normalised copy with
 * defaults applied. Throws on the first violation (missing required, wrong
 * scalar type, bad enum value).
 *
 * For freeform types, `data` is returned as-is — the only constraint is that
 * keys be valid identifiers (caller enforces this elsewhere if it matters).
 */
export function validateAndNormalize(type, data) {
  const def = getType(type);
  if (def.freeform) {
    return { ...(data || {}) };
  }
  const out = {};
  const input = data || {};
  for (const f of def.fields) {
    let v = input[f.name];
    if (v === undefined || v === null || v === "") {
      if (f.default !== undefined) v = f.default;
    }
    if ((v === undefined || v === null || v === "") && f.required) {
      throw new Error(`Field "${f.name}" is required for ${type}`);
    }
    if (v !== undefined && v !== null && v !== "") {
      v = coerce(v, f);
      if (f.type === "select" && !f.options.includes(v)) {
        throw new Error(`Field "${f.name}" must be one of ${f.options.join(", ")}`);
      }
    }
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function coerce(v, field) {
  switch (field.type) {
    case "number":
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
        return Number(v);
      }
      throw new Error(`Field "${field.name}" must be a number (got ${typeof v})`);
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true")  return true;
      if (v === "false") return false;
      throw new Error(`Field "${field.name}" must be a boolean (got ${typeof v})`);
    case "string":
    case "select":
      return String(v);
    default:
      return v;
  }
}

/**
 * Encrypt all secret fields in a normalised data object using
 * envelope encryption (v2). The function is async because the KMS
 * provider may be remote (AWS / GCP / etc).
 *
 * Behaviour:
 *   • Generates a fresh DEK via the KMS provider.
 *   • Re-encrypts every plaintext secret field with that DEK.
 *   • Already-encrypted v2 fields are KEPT (their ciphertext + the
 *     existing DEK still match) — this lets PATCH-style updates leave
 *     untouched secrets alone without burning a new KMS call.
 *   • If the row already has a v1 (legacy) envelope on a secret field,
 *     we lazily upgrade it: decrypt with the legacy key, re-encrypt
 *     with the new DEK. After the next save the row is fully v2.
 *   • If the row turns out to have no secret values at all, we don't
 *     generate a DEK at all — no KMS call, no __crypto block.
 *
 * Returns:
 *   { data, encryption_version, kek_id }
 *
 *   `data` is a new object you store as configs.data (JSONB).
 *   `encryption_version` is 1 if there were no secrets to encrypt
 *   (so we can keep the row at v1) or 2 if a DEK was issued.
 *   `kek_id` is non-null only at v2.
 */
export async function encryptSecrets(type, data) {
  const def = getType(type);
  const out = { ...(data || {}) };
  const secretFields = collectSecretFields(def, out);
  if (secretFields.length === 0) {
    // Nothing to encrypt — keep schema simple, no DEK needed.
    removeCryptoBlock(out);
    return { data: out, encryption_version: 1, kek_id: null };
  }

  // Reuse the existing DEK only if every secret field is already a
  // v2 envelope AND we have a wrapped DEK on the row. Otherwise we
  // need a fresh DEK — generating a new one is the safe default and
  // costs one KMS call.
  const existingCrypto = readCryptoBlock(out);
  const allV2 = secretFields.every(({ value }) => isV2Envelope(value));
  if (existingCrypto && allV2) {
    // No-op: every secret is already wrapped with the row's current
    // DEK. Just leave the row as-is.
    return {
      data: out,
      encryption_version: 2,
      kek_id: existingCrypto.kekId,
    };
  }

  const { plaintextDek, wrappedDek, kekId } = await generateDataKey();
  try {
    for (const { name, value } of secretFields) {
      let plain = value;
      // Lazy v1 → v2 upgrade.
      if (isEncrypted(plain) && !isV2Envelope(plain)) {
        plain = decryptValue(plain);
      }
      out[name] = encryptValueWithDek(plain, plaintextDek);
    }
    writeCryptoBlock(out, { wrappedDek, kekId });
    return { data: out, encryption_version: 2, kek_id: kekId };
  } finally {
    wipeBuffer(plaintextDek);
  }
}

/**
 * Decrypt all secret fields in a stored data object. Async because v2
 * rows need a KMS round-trip to unwrap the DEK; v1 rows still resolve
 * synchronously through the legacy key.
 *
 * Returns a new object with plaintext values; the original is left
 * untouched. Used by the engine + trigger manager when wiring configs
 * into ctx.config and into trigger drivers.
 */
export async function decryptSecrets(type, data) {
  const out = { ...(data || {}) };
  const cryptoBlock = readCryptoBlock(out);

  if (!cryptoBlock) {
    // v1 path: every encrypted field is independent, single legacy key.
    for (const k of Object.keys(out)) {
      if (isEncrypted(out[k])) out[k] = decryptValue(out[k]);
    }
    return out;
  }

  // v2 path: unwrap once, then decrypt each secret field with the DEK.
  const dek = await decryptDataKey(cryptoBlock.wrappedDek, cryptoBlock.kekId);
  try {
    for (const k of Object.keys(out)) {
      if (k === "__crypto") continue;
      if (isV2Envelope(out[k])) {
        out[k] = decryptValueWithDek(out[k], dek);
      } else if (isEncrypted(out[k])) {
        // Mixed-version row (e.g. mid-upgrade) — fall back to legacy.
        out[k] = decryptValue(out[k]);
      }
    }
    // The crypto block is internal — drop it from the plaintext map
    // we hand to the engine.
    delete out.__crypto;
    return out;
  } finally {
    wipeBuffer(dek);
  }
}

/** Walk the type schema and pick out every secret field that has
 *  a (potentially encrypted) value attached. Used by encryptSecrets. */
function collectSecretFields(def, data) {
  const out = [];
  if (def.freeform) {
    const secretMap = data?.__secret || {};
    for (const k of Object.keys(secretMap)) {
      if (data[k] === undefined || data[k] === null || data[k] === "") continue;
      out.push({ name: k, value: data[k] });
    }
    return out;
  }
  for (const f of def.fields) {
    if (!f.secret) continue;
    const v = data[f.name];
    if (v === undefined || v === null || v === "") continue;
    out.push({ name: f.name, value: v });
  }
  return out;
}

/**
 * Mask all secret fields with a sentinel string for safe inclusion in a
 * list-style API response. The masked envelope replaces the encrypted
 * payload with a plain "***" so clients don't try to decrypt or re-send it.
 */
export function maskSecrets(type, data) {
  const def = getType(type);
  const out = { ...(data || {}) };
  if (def.freeform) {
    const secretMap = data?.__secret || {};
    for (const k of Object.keys(secretMap)) {
      if (out[k] !== undefined) out[k] = "***";
    }
    return out;
  }
  for (const f of def.fields) {
    if (!f.secret) continue;
    if (out[f.name] !== undefined && out[f.name] !== null && out[f.name] !== "") {
      out[f.name] = "***";
    }
  }
  return out;
}
