// RAG ingest orchestrator + retrieve helper.
//
// Two public flows:
//
//   createAndIngestDocument({...})
//     Inserts a kb_documents row + runs the full pipeline
//     (chunk → embed → store) inline. Returns when the doc is
//     'ready' or 'failed'. Used by the REST API's /upload + /url
//     endpoints and the rag.ingest DAG plugin.
//
//   retrieve({ kbId, query, topK, ... })
//     Embeds the query, runs the pgvector ANN search, charges the
//     project's monthly token quota for the query embedding, and
//     logs an agent_token_events row so the Quotas page surfaces
//     retrieval spend.
//
// Both paths route token spend through the existing quota +
// agent_token_events machinery (re-using "[embed]" / "[query]" as
// the agent_title) so RAG cost shows up in the same dashboards as
// regular agent calls — no separate "RAG dashboard" to maintain.

import { randomUUID, createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";
import { chunkText, estimateTokens } from "./chunk.js";
import { getStore } from "./store/index.js";
import { getEmbedder } from "./embedders/index.js";
import { recordAgentTokenEvent } from "../plugins/agent/usage.js";

// Embedding API batch size. Both OpenAI and Voyage handle ~2000
// inputs per request comfortably; 100 keeps individual calls fast
// and the failure blast radius small.
const EMBED_BATCH = 100;

/**
 * Load a KB row by id. Returns null when not found or soft-deleted.
 */
export async function loadKb(id) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, project_id, title,
            embedding_provider, embedding_model, embedding_config_id,
            dimension, chunk_size, chunk_overlap,
            kb_backend, kb_backend_config_id, kb_backend_collection
       FROM knowledge_bases
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Resolve the embedding provider's credentials. Three sources, in
 * preference order:
 *   1. The KB's embedding_config_id (encrypted configs row)
 *   2. <PROVIDER>_API_KEY env var
 *   3. AI_API_KEY env var (the "Ask AI" fallback)
 *
 * Returns { provider, model, apiKey, baseUrl } — the shape every
 * embedder's embed() accepts.
 */
export async function resolveEmbeddingCfg(kb) {
  if (kb.embedding_config_id) {
    const { rows } = await pool.query(
      `SELECT type, data FROM configs WHERE id = $1`,
      [kb.embedding_config_id],
    );
    if (rows[0]) {
      // Dynamic import — configs/registry pulls in the type registry
      // which is heavy and not needed unless we're actually using a
      // configs-backed embedder.
      const { decryptSecrets } = await import("../configs/registry.js");
      const data = decryptSecrets(rows[0].type, rows[0].data) || {};
      return {
        provider: kb.embedding_provider,
        model:    kb.embedding_model,
        apiKey:   data.apiKey || data.api_key || "",
        baseUrl:  data.baseUrl || data.base_url || null,
      };
    }
  }
  const envKey =
    process.env[`${kb.embedding_provider.toUpperCase()}_API_KEY`] ||
    process.env.AI_API_KEY ||
    "";
  return {
    provider: kb.embedding_provider,
    model:    kb.embedding_model,
    apiKey:   envKey,
    baseUrl:  null,
  };
}

/**
 * Run extract → chunk → embed → store for a document row.
 *
 * Expects the kb_documents row to already exist (status='pending').
 * On success: status='ready', chunk_count set, error cleared.
 * On failure: status='failed', error populated, throws.
 *
 * The KB's document_count + chunk_count counters are refreshed at
 * the end via a sub-select so a concurrent ingest can't race the
 * rollup.
 */
export async function ingestDocument({ kb, document, text, ctx = {} }) {
  if (!text || !text.trim()) {
    await markFailed(document.id, "empty document (extracted text was blank)");
    return { id: document.id, chunkCount: 0, tokens: 0 };
  }

  await pool.query(
    `UPDATE kb_documents SET status='processing', updated_at=NOW() WHERE id=$1`,
    [document.id],
  );

  const chunks = chunkText(text, {
    chunkSize: kb.chunk_size || 800,
    overlap:   kb.chunk_overlap || 100,
  });
  if (!chunks.length) {
    await markFailed(document.id, "chunker produced no chunks");
    return { id: document.id, chunkCount: 0, tokens: 0 };
  }

  const cfg = await resolveEmbeddingCfg(kb);
  if (!cfg.apiKey) {
    await markFailed(document.id, `no api key for embedding provider "${kb.embedding_provider}"`);
    throw new Error(`no api key for embedding provider "${kb.embedding_provider}"`);
  }
  const embedder = getEmbedder(kb.embedding_provider);

  // Run embedding in batches so a partial failure doesn't leak as
  // a 30 MB request body and surface as a generic "fetch failed".
  const records  = [];
  let tokensSpent = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    try {
      const { vectors, usage } = await embedder.embed({
        cfg,
        texts:     batch,
        inputType: "document",
      });
      tokensSpent += Number(usage?.tokens) || 0;
      if (vectors.length !== batch.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${batch.length} inputs`,
        );
      }
      for (let j = 0; j < batch.length; j++) {
        records.push({
          ordinal:   i + j,
          content:   batch[j],
          tokens:    estimateTokens(batch[j]),
          embedding: vectors[j],
        });
      }
    } catch (e) {
      await markFailed(document.id, `embed failed at chunk ${i}: ${e.message}`);
      throw e;
    }
  }

  // Dispatch to the right backend (pgvector / qdrant / …). The store
  // closure already knows the KB's backend + connection cfg, so the
  // call here is backend-agnostic.
  const store = await getStore(kb);
  await store.upsertChunks(kb.id, document.id, records);

  await pool.query(
    `UPDATE kb_documents
        SET status='ready', chunk_count=$2, error=NULL, updated_at=NOW()
      WHERE id=$1`,
    [document.id, records.length],
  );
  await refreshKbCounters(kb.id);

  await chargeEmbeddingSpend({
    kb,
    tokens:    tokensSpent,
    title:     `[embed] ${kb.title}`,
    executionId: ctx.executionId,
  });

  log.info("kb ingest done", {
    kbId: kb.id, documentId: document.id, chunks: records.length, tokens: tokensSpent,
  });
  return { id: document.id, chunkCount: records.length, tokens: tokensSpent };
}

/**
 * Insert the kb_documents row, then run ingestDocument. Convenience
 * wrapper used by the REST upload/url endpoints + the rag.ingest
 * plugin.
 */
export async function createAndIngestDocument({
  kb, title, sourceType, sourceUri, contentType, byteSize, text, createdBy,
}) {
  const id = randomUUID();
  const contentHash = createHash("sha256").update(text || "").digest("hex");
  await pool.query(
    `INSERT INTO kb_documents
       (id, kb_id, title, source_type, source_uri, content_type, byte_size,
        content_hash, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
    [
      id, kb.id, title, sourceType, sourceUri || null,
      contentType || null, byteSize || null, contentHash, createdBy || null,
    ],
  );
  return ingestDocument({ kb, document: { id, kb_id: kb.id, title }, text });
}

/**
 * Query a KB. Returns:
 *   { matches: [{id, document_id, ordinal, content, metadata, score}], usage }
 *
 * The query embedding is charged to the project's monthly token
 * quota and logged to agent_token_events with "[query] <KB title>"
 * as the agent_title so retrieval spend is visible on the Quotas
 * page alongside agent spend.
 */
export async function retrieve({ kbId, query, topK = 5, minScore = 0, ctx = {} }) {
  const kb = await loadKb(kbId);
  if (!kb) throw new Error(`kb not found: ${kbId}`);

  const cfg = await resolveEmbeddingCfg(kb);
  if (!cfg.apiKey) {
    throw new Error(`no api key for embedding provider "${kb.embedding_provider}"`);
  }
  const embedder = getEmbedder(kb.embedding_provider);
  const { vectors, usage } = await embedder.embed({
    cfg,
    texts:     [String(query || "")],
    inputType: "query",
  });
  const queryVec = vectors[0];

  // Same dispatcher path as ingest. Each KB knows its backend; the
  // store closure handles pgvector vs Qdrant vs whatever lands next.
  const store = await getStore(kb);
  const matches = await store.search(kb.id, queryVec, { topK, minScore });

  await chargeEmbeddingSpend({
    kb,
    tokens:    Number(usage?.tokens) || 0,
    title:     `[query] ${kb.title}`,
    executionId: ctx.executionId,
  });

  return { matches, kb, usage };
}

// ─── internal helpers ───────────────────────────────────────────

async function markFailed(documentId, reason) {
  await pool.query(
    `UPDATE kb_documents SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
    [documentId, reason],
  );
}

async function refreshKbCounters(kbId) {
  await pool.query(
    `UPDATE knowledge_bases
        SET document_count = (
              SELECT COUNT(*) FROM kb_documents
               WHERE kb_id=$1 AND status='ready'
            ),
            chunk_count = (
              SELECT COALESCE(SUM(chunk_count),0) FROM kb_documents
               WHERE kb_id=$1 AND status='ready'
            ),
            updated_at = NOW()
      WHERE id=$1`,
    [kbId],
  );
}

/**
 * Charge the embedding tokens against the project's monthly quota +
 * write an agent_token_events row so the Quotas page picks it up.
 * Both writes are fire-and-forget — metering failures must not roll
 * back a successful ingest / retrieve.
 */
async function chargeEmbeddingSpend({ kb, tokens, title, executionId }) {
  if (!kb.project_id || tokens <= 0) return;
  try {
    const { incrementUsage } = await import("../auth/quotas.js");
    incrementUsage(kb.project_id, "tokens_per_month", tokens).catch(() => {});
  } catch { /* quota module unavailable — skip */ }
  recordAgentTokenEvent({
    workspaceId: kb.workspace_id,
    projectId:   kb.project_id,
    executionId: executionId || null,
    agentId:     null,
    agentTitle:  title,
    provider:    kb.embedding_provider,
    model:       kb.embedding_model,
    inputTokens: tokens,
    outputTokens: 0,
    cacheHit:    false,
    latencyMs:   null,
  }).catch(() => {});
}
