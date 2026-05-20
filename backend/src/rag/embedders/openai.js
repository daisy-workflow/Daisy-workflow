// OpenAI embeddings — text-embedding-3-small and text-embedding-3-large.
//
// Both models accept a `dimensions` parameter that returns a
// matryoshka-truncated vector. We always request 1536 to match the
// pgvector column width, which gives small its native dim and
// truncates large from 3072 → 1536. The truncated 1536 prefix is the
// model's intended representation (large is *trained* matryoshka),
// so similarity quality stays high.

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export const MODELS = [
  { id: "text-embedding-3-small", nativeDim: 1536, contextWindow: 8191 },
  { id: "text-embedding-3-large", nativeDim: 3072, contextWindow: 8191 },
];

/**
 * Embed a batch of texts. OpenAI accepts up to ~2048 inputs per call;
 * the ingest pipeline already chunks batches at 100 so we send one
 * request per batch and pass the array through.
 *
 * cfg:
 *   apiKey   — required
 *   model    — defaults to text-embedding-3-small
 *   baseUrl  — for Azure-style proxies. Defaults to api.openai.com.
 */
export async function embed({ cfg, texts /* , inputType */ }) {
  if (!texts?.length) return { vectors: [], usage: { tokens: 0 } };
  if (!cfg?.apiKey) throw new Error("openai embed: cfg.apiKey is required");

  const base  = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = cfg.model || "text-embedding-3-small";

  const body = {
    model,
    input: texts,
    // Force 1536 — matches kb_chunks.embedding's vector(1536) column.
    // text-embedding-3-large is matryoshka-trained, so truncation is
    // both supported and lossless-by-design.
    dimensions: 1536,
  };

  const r = await fetch(`${base}/embeddings`, {
    method:  "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`openai embed HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const json = await r.json();
  // OpenAI returns data ordered to match the input array.
  const vectors = (json.data || []).map(d => d.embedding);
  const tokens  = json.usage?.total_tokens ?? 0;
  return { vectors, usage: { tokens } };
}
