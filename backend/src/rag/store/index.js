// Vector store dispatcher.
//
// getStore(kb) returns an object exposing the same three methods every
// store implements:
//
//   upsertChunks(kbId, documentId, chunks) → void
//   search(kbId, queryVector, { topK, minScore }) → match[]
//   deleteDocumentChunks(documentId) → void
//
// Plus an optional `ensureBackend()` lifecycle hook that initializes
// any backend-specific resources (Qdrant: create the collection if
// missing). The KB-create endpoint calls it eagerly so the user sees
// connection errors immediately rather than at first ingest.
//
// pgvector needs no per-KB config — the adapter just talks to the
// app's Postgres pool. Other backends (qdrant today) pull their
// connection details from a configs row referenced by
// kb_backend_config_id. The dispatcher resolves that here so each
// adapter receives a flat `cfg` object and stays oblivious to the
// configs / encryption layer.

import { pool } from "../../db/pool.js";

const KNOWN_BACKENDS = ["pgvector", "qdrant"];

export function listBackends() {
  return KNOWN_BACKENDS.map(name => ({ name }));
}

/**
 * Build a bound store for one KB. The returned object's methods all
 * close over the KB's identity / backend config so callers don't have
 * to thread it through every call.
 */
export async function getStore(kb) {
  const backend = kb.kb_backend || "pgvector";

  if (backend === "pgvector") {
    const m = await import("./pgvector.js");
    return {
      backend: "pgvector",
      upsertChunks:         (kbId, docId, chunks)  => m.upsertChunks(kbId, docId, chunks),
      search:               (kbId, vec, opts)      => m.search(kbId, vec, opts),
      deleteDocumentChunks: (docId)                => m.deleteDocumentChunks(docId),
      // pgvector has no per-KB setup — the table is shared.
      ensureBackend:        async () => {},
    };
  }

  if (backend === "qdrant") {
    const m   = await import("./qdrant.js");
    const cfg = await resolveBackendCfg(kb);    // { url, apiKey, collection }
    return {
      backend: "qdrant",
      upsertChunks:         (_kbId, docId, chunks) => m.upsertChunks(cfg, docId, chunks),
      search:               (_kbId, vec, opts)     => m.search(cfg, vec, opts),
      deleteDocumentChunks: (docId)                => m.deleteDocumentChunks(cfg, docId),
      ensureBackend:        ()                     => m.ensureCollection(cfg),
    };
  }

  throw new Error(`unknown kb backend: ${backend}`);
}

/**
 * Load the connection details for an external backend.
 *
 * Returns: { url, apiKey, collection }
 *
 * Throws if the KB row points at a backend that needs a config but
 * none is wired up — better to fail loudly here than to ship the
 * adapter a half-built cfg.
 */
async function resolveBackendCfg(kb) {
  if (!kb.kb_backend_config_id) {
    throw new Error(
      `KB "${kb.title || kb.id}" uses backend "${kb.kb_backend}" but ` +
      `no backend config is attached. Pick a vector.${kb.kb_backend} ` +
      `config when creating the KB.`,
    );
  }
  const { rows } = await pool.query(
    `SELECT type, data FROM configs WHERE id = $1`,
    [kb.kb_backend_config_id],
  );
  if (!rows[0]) {
    throw new Error(`KB backend config not found (id=${kb.kb_backend_config_id})`);
  }
  // Dynamic import — keeps the boot graph clean of configs/crypto when
  // pgvector is the only backend in use.
  const { decryptSecrets } = await import("../../configs/registry.js");
  const data = decryptSecrets(rows[0].type, rows[0].data) || {};

  return {
    url:        data.url || data.baseUrl || "",
    apiKey:     data.apiKey || data.api_key || "",
    collection: kb.kb_backend_collection || defaultCollectionName(kb),
  };
}

/** Stable default collection name when the user doesn't pick one. */
function defaultCollectionName(kb) {
  return `daisy_kb_${String(kb.id || "").replace(/-/g, "").slice(0, 16)}`;
}
