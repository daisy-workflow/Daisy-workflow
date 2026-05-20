-- Pluggable vector store backends for knowledge bases.
--
-- Migration 026 hard-coded pgvector as the only store. This migration
-- adds per-KB backend selection without breaking existing rows — any
-- KB created before this migration keeps `pgvector` as its backend by
-- column default.
--
-- Schema:
--   kb_backend             — which adapter to use ('pgvector' | 'qdrant').
--   kb_backend_config_id   — points at a configs row of type matching
--                            the backend (vector.qdrant for Qdrant).
--                            Null for pgvector (no external connection
--                            needed). For external backends, this carries
--                            the connection URL + api key (encrypted).
--   kb_backend_collection  — backend-specific identifier. For Qdrant
--                            this is the Qdrant collection name; one
--                            collection per KB. Null for pgvector
--                            (which uses the shared kb_chunks table).
--
-- Adding another backend later = new check constraint value + new
-- configs registry type + new adapter file under src/rag/store/.

ALTER TABLE knowledge_bases
  ADD COLUMN IF NOT EXISTS kb_backend TEXT NOT NULL DEFAULT 'pgvector',
  ADD COLUMN IF NOT EXISTS kb_backend_config_id UUID REFERENCES configs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kb_backend_collection TEXT;

-- CHECK added in a second pass so the column-add succeeds when the
-- check constraint already exists from a prior incomplete migration.
-- Drop-and-recreate stays idempotent across `npm run migrate` restarts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'knowledge_bases_kb_backend_chk'
  ) THEN
    ALTER TABLE knowledge_bases
      ADD CONSTRAINT knowledge_bases_kb_backend_chk
        CHECK (kb_backend IN ('pgvector', 'qdrant'));
  END IF;
END $$;

COMMENT ON COLUMN knowledge_bases.kb_backend IS
  'Vector store adapter: pgvector (default, shared kb_chunks table) or qdrant (external server, one collection per KB).';
COMMENT ON COLUMN knowledge_bases.kb_backend_config_id IS
  'Reference to a configs row carrying the backend connection details (url, api key). Null for pgvector.';
COMMENT ON COLUMN knowledge_bases.kb_backend_collection IS
  'Backend-specific identifier — for Qdrant, the collection name. Auto-generated at KB-create time if not supplied by the user.';
