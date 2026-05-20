// Voyage AI embeddings — Anthropic's recommended embedder.
//
// Native dim is 1024 for both voyage-3 and voyage-3-large. Vectors
// are right-padded to 1536 inside the pgvector store (see
// store/pgvector.js#padVector) so they coexist with OpenAI's
// embeddings in the same column.
//
// Voyage exposes an `input_type` field — passing "document" at
// ingest time and "query" at retrieval time materially improves
// retrieval quality. The ingest + retrieve callers in src/rag/ingest.js
// set it accordingly via the `inputType` arg.

const DEFAULT_BASE_URL = "https://api.voyageai.com/v1";

export const MODELS = [
  { id: "voyage-3",        nativeDim: 1024, contextWindow: 32000 },
  { id: "voyage-3-large",  nativeDim: 1024, contextWindow: 32000 },
  { id: "voyage-3-lite",   nativeDim:  512, contextWindow: 32000 },
];

/**
 * Embed a batch of texts.
 *
 * cfg:
 *   apiKey   — required
 *   model    — defaults to voyage-3
 *   baseUrl  — proxy override; defaults to api.voyageai.com.
 *
 * inputType:
 *   "document" | "query"  — Voyage's contextual hint; defaults to
 *                            "document" because the ingest path is
 *                            the hot one.
 */
export async function embed({ cfg, texts, inputType = "document" }) {
  if (!texts?.length) return { vectors: [], usage: { tokens: 0 } };
  if (!cfg?.apiKey) throw new Error("voyage embed: cfg.apiKey is required");

  const base  = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = cfg.model || "voyage-3";

  const body = {
    model,
    input:      texts,
    input_type: inputType,
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
    throw new Error(`voyage embed HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const json = await r.json();
  const vectors = (json.data || []).map(d => d.embedding);
  const tokens  = json.usage?.total_tokens ?? 0;
  return { vectors, usage: { tokens } };
}
