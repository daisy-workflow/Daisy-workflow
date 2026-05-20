// Qdrant vector store adapter.
//
// One KB → one Qdrant collection. The collection name comes from
// kb_backend_collection (set at KB-create time, defaults to
// `daisy_kb_<short-id>`). Search has no kb_id filter because each
// collection only holds chunks for its owning KB.
//
// Points carry their content + ordinal + document_id in the payload
// so we can:
//   • return chunk text from search() without a second round-trip
//   • delete all points for a document via filter (no need to
//     remember the point ids)
//
// Auth: Qdrant Cloud sends an "api-key" header. Self-hosted clusters
// often run unauthenticated. The cfg's apiKey is optional — when
// blank we just don't send the header.
//
// Vector dim: 1536, cosine distance — matches the rest of the RAG
// pipeline (see store/pgvector.js for the rationale). Vectors are
// padded by the caller before reaching here.

import { randomUUID } from "node:crypto";
import { padVector, TARGET_DIM } from "./pgvector.js";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Idempotent: GET first, PUT only if 404. PUT is destructive if the
 * collection already exists (Qdrant recreates), so we never blind-PUT.
 */
export async function ensureCollection(cfg) {
  requireCfg(cfg);
  const head = await qdrant(cfg, "GET", `/collections/${enc(cfg.collection)}`, null, {
    // GET on missing collection returns 404 — that's expected, not an
    // error we want to throw on.
    okStatuses: [200, 404],
  });
  if (head.status === 200) return { existed: true };

  await qdrant(cfg, "PUT", `/collections/${enc(cfg.collection)}`, {
    vectors: { size: TARGET_DIM, distance: "Cosine" },
  });
  return { existed: false, created: true };
}

/**
 * Replace all points belonging to a document. Same semantics as the
 * pgvector adapter:
 *   1. Delete the old points (filter by document_id payload field).
 *   2. Upsert the new batch.
 *
 * Qdrant supports batched upserts up to ~100 points cleanly. Our
 * ingest pipeline already chunks at EMBED_BATCH (100), so each call
 * here matches one embedder batch.
 */
export async function upsertChunks(cfg, documentId, chunks) {
  if (!chunks?.length) return;
  requireCfg(cfg);

  // 1. Wipe existing points for this document.
  await qdrant(cfg, "POST", `/collections/${enc(cfg.collection)}/points/delete?wait=true`, {
    filter: {
      must: [{ key: "document_id", match: { value: documentId } }],
    },
  });

  // 2. Push the new batch.
  const points = chunks.map(c => ({
    id:      randomUUID(),
    vector:  padVector(c.embedding),
    payload: {
      document_id: documentId,
      ordinal:     c.ordinal,
      content:     c.content,
      tokens:      c.tokens || null,
      metadata:    c.metadata || null,
    },
  }));

  // `wait=true` makes the call return only after the points are
  // visible to search — important for tests + the "ingest then test
  // query" UI flow.
  await qdrant(cfg, "PUT", `/collections/${enc(cfg.collection)}/points?wait=true`, {
    points,
  });
}

/**
 * ANN search. Qdrant returns hits in descending score order already.
 * We filter by minScore client-side because Qdrant's
 * `score_threshold` interprets thresholds differently per distance
 * metric — applying our own keeps the semantics identical to the
 * pgvector adapter.
 */
export async function search(cfg, queryVector, { topK = 5, minScore = 0 } = {}) {
  requireCfg(cfg);
  const limit = Math.min(Math.max(Number(topK) || 5, 1), 100);
  const padded = padVector(queryVector);

  const body = {
    vector:        padded,
    limit,
    with_payload:  true,
    with_vector:   false,
  };
  const resp = await qdrant(cfg, "POST",
    `/collections/${enc(cfg.collection)}/points/search`, body);

  const hits = (resp.body?.result || []).filter(h => h.score >= minScore);
  return hits.map(h => ({
    id:          h.id,
    document_id: h.payload?.document_id || null,
    ordinal:     h.payload?.ordinal,
    content:     h.payload?.content || "",
    metadata:    h.payload?.metadata || null,
    score:       h.score,
  }));
}

/** Delete all points belonging to a document. Called from the REST
 *  delete-document endpoint and from upsertChunks (above). */
export async function deleteDocumentChunks(cfg, documentId) {
  requireCfg(cfg);
  await qdrant(cfg, "POST",
    `/collections/${enc(cfg.collection)}/points/delete?wait=true`,
    {
      filter: {
        must: [{ key: "document_id", match: { value: documentId } }],
      },
    },
  );
}

// ─── HTTP helper ────────────────────────────────────────────────

/**
 * One thin wrapper around fetch. Returns { status, body } when
 * status is in `okStatuses`; throws a descriptive error otherwise so
 * the ingest path surfaces clean failures (no opaque "fetch failed").
 */
async function qdrant(cfg, method, path, body = null, { okStatuses } = {}) {
  const ok = okStatuses || [200, 201, 204];
  const url = `${cfg.url.replace(/\/$/, "")}${path}`;

  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["api-key"] = cfg.apiKey;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  const text  = await r.text().catch(() => "");
  if (text) { try { parsed = JSON.parse(text); } catch { /* non-json */ } }

  if (!ok.includes(r.status)) {
    const detail = (parsed?.status?.error
                 || parsed?.message
                 || text || "").toString().slice(0, 400);
    throw new Error(
      `qdrant ${method} ${path} → HTTP ${r.status}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return { status: r.status, body: parsed };
}

function requireCfg(cfg) {
  if (!cfg?.url)        throw new Error("qdrant cfg: url is required");
  if (!cfg?.collection) throw new Error("qdrant cfg: collection is required");
}

function enc(s) { return encodeURIComponent(s); }
