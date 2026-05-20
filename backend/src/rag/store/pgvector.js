// pgvector-backed chunk store.
//
// The schema fixes embeddings at 1536 dims (see migration 026 header
// for the rationale). All embeddings entering this module are first
// normalised to that width: longer vectors are truncated; shorter
// vectors get zero-padded on the right. Cosine similarity is
// invariant to shared zero-padding so voyage's native 1024-dim
// vectors compare meaningfully against openai's 1536.
//
// All queries scope by kb_id first; the btree on (kb_id) filters the
// candidate set before pgvector's IVFFlat index does the ANN sort.

import { pool } from "../../db/pool.js";
import { randomUUID } from "node:crypto";

export const TARGET_DIM = 1536;

/**
 * Normalise a numeric vector to TARGET_DIM by truncate-or-zero-pad.
 * Returns a JS array (callers stringify via vectorLiteral).
 */
export function padVector(v) {
  if (!Array.isArray(v)) throw new Error("padVector: vector must be an array");
  if (v.length === TARGET_DIM) return v;
  if (v.length > TARGET_DIM) return v.slice(0, TARGET_DIM);
  const padded = new Array(TARGET_DIM);
  for (let i = 0; i < v.length; i++) padded[i] = v[i];
  for (let i = v.length; i < TARGET_DIM; i++) padded[i] = 0;
  return padded;
}

/**
 * pgvector accepts vectors as the text form "[1,2,3]". We send it as
 * a string + cast it server-side ($N::vector). Numbers are emitted
 * with toFixed(6) to keep the body compact without losing meaningful
 * precision (cosine is robust at 1e-6).
 */
function vectorLiteral(v) {
  let out = "[";
  for (let i = 0; i < v.length; i++) {
    if (i > 0) out += ",";
    out += Number(v[i]).toFixed(6);
  }
  return out + "]";
}

/**
 * Replace all chunks for a document. Transaction-bracketed so a
 * mid-insert error doesn't leave the document with a partial set.
 *
 * chunks: Array<{ ordinal, content, embedding, tokens?, metadata? }>
 */
export async function upsertChunks(kbId, documentId, chunks) {
  if (!chunks?.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM kb_chunks WHERE document_id = $1", [documentId]);
    // Per-row INSERT to keep the code readable. At BATCH_SIZE (100)
    // chunks per embed call this isn't a hot path; a multi-row VALUES
    // form is a future optimisation if profiling says so.
    for (const c of chunks) {
      const padded = padVector(c.embedding);
      await client.query(
        `INSERT INTO kb_chunks
           (id, kb_id, document_id, ordinal, content, tokens, embedding, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8)`,
        [
          randomUUID(),
          kbId,
          documentId,
          c.ordinal,
          c.content,
          c.tokens || null,
          vectorLiteral(padded),
          c.metadata ? JSON.stringify(c.metadata) : null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * ANN search for the top-K most similar chunks in a KB.
 *
 * Returns rows of:
 *   { id, document_id, ordinal, content, metadata, score }
 *
 * `score` is cosine similarity (1 = identical, 0 = orthogonal).
 * pgvector's `<=>` is cosine *distance*; we flip to similarity in
 * the SELECT so the UI shows a more intuitive number.
 */
export async function search(kbId, queryVector, { topK = 5, minScore = 0 } = {}) {
  const padded = padVector(queryVector);
  const lit = vectorLiteral(padded);
  const limit = Math.min(Math.max(Number(topK) || 5, 1), 100);
  const { rows } = await pool.query(
    `SELECT id,
            document_id,
            ordinal,
            content,
            metadata,
            (1 - (embedding <=> $2::vector))::float AS score
       FROM kb_chunks
      WHERE kb_id = $1
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [kbId, lit, limit],
  );
  return rows.filter(r => r.score >= minScore);
}

/** Drop all chunks for a document. Used when the doc row is being
 *  re-ingested before the new ones land. */
export async function deleteDocumentChunks(documentId) {
  await pool.query("DELETE FROM kb_chunks WHERE document_id = $1", [documentId]);
}
