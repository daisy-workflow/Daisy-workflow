-- Knowledge Bases — vector store for RAG (Phase B).
--
-- Three tables:
--   knowledge_bases — top-level KB rows (project-scoped, soft-deleted).
--   kb_documents    — one row per ingested source (upload / url / plugin).
--   kb_chunks       — per-chunk text + embedding + metadata.
--
-- Embedding dimensionality is normalised to 1536 across all supported
-- providers. We deliberately picked 1536 because it's:
--   • the native size of OpenAI text-embedding-3-small
--   • requestable from text-embedding-3-large via the `dimensions`
--     parameter (model is matryoshka-trained, so truncated vectors are
--     still well-formed)
--   • achievable from Voyage's 1024-dim output by right-padding with
--     zeros (cosine similarity is preserved when both vectors share
--     the same tail of zeros, since 0·0 = 0 in both numerator and
--     denominator of cos θ)
--
-- The single-dimension choice keeps `vector(1536)` constant across
-- the table so pgvector can build a single ANN index. Cross-model
-- search inside a KB is intentionally NOT supported — each KB pins
-- its embedding_provider + embedding_model at creation, and chunks
-- must always be re-embedded with the matching model to be
-- meaningfully comparable.

-- pgvector extension. Idempotent — second `migrate` call is a no-op.
-- Without superuser this will fail with a clear error; the operator
-- needs to run `CREATE EXTENSION vector;` once as a privileged user.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id                    UUID        PRIMARY KEY,
  workspace_id          UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id            UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,

  title                 TEXT        NOT NULL,
  description           TEXT,

  -- Pinned at creation. Changing provider/model after ingest is
  -- meaningless — the existing chunks won't match. To swap models,
  -- create a new KB and re-ingest.
  embedding_provider    TEXT        NOT NULL,
  embedding_model       TEXT        NOT NULL,
  -- Optional pointer at a configs row carrying the api key + base
  -- url for this provider. Null = fall back to env var
  -- (<PROVIDER>_API_KEY).
  embedding_config_id   UUID        REFERENCES configs(id) ON DELETE SET NULL,

  -- Dimension stored for clarity / future-proofing only — the vector
  -- column itself is fixed at 1536 (see top-of-file note).
  dimension             INTEGER     NOT NULL DEFAULT 1536,

  -- Chunking knobs (chars). Defaults are conservative — they fit
  -- inside any embedding model's token limit with margin.
  chunk_size            INTEGER     NOT NULL DEFAULT 800,
  chunk_overlap         INTEGER     NOT NULL DEFAULT 100,

  -- Rolled-up counters refreshed after every ingest / delete. The
  -- per-document chunk_count is the source of truth; this column is
  -- denormalised so the list UI doesn't have to aggregate.
  document_count        INTEGER     NOT NULL DEFAULT 0,
  chunk_count           INTEGER     NOT NULL DEFAULT 0,

  created_by            UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Soft-delete: hidden from listings but row + chunks survive so a
  -- restore is possible. The project soft-delete sweeper purges
  -- KBs older than the retention window.
  deleted_at            TIMESTAMPTZ,

  -- Title uniqueness scoped to the project to give the UI a friendly
  -- error instead of a UUID collision.
  CONSTRAINT knowledge_bases_title_unique UNIQUE (workspace_id, project_id, title)
);

CREATE INDEX IF NOT EXISTS idx_kbs_project
  ON knowledge_bases (project_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE knowledge_bases IS
  'RAG knowledge base. One row per project-scoped KB; chunks live in kb_chunks keyed by kb_id.';


CREATE TABLE IF NOT EXISTS kb_documents (
  id            UUID        PRIMARY KEY,
  kb_id         UUID        NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL,

  -- 'upload'  — multipart file upload via the API
  -- 'url'     — fetched URL
  -- 'plugin'  — added programmatically via rag.ingest plugin
  -- 'text'    — pasted into the UI directly
  source_type   TEXT        NOT NULL CHECK (source_type IN ('upload','url','plugin','text')),
  source_uri    TEXT,       -- file path / url; null for inline text
  content_type  TEXT,       -- detected MIME (text/plain, application/pdf, ...)
  byte_size     BIGINT,

  -- SHA-256 of the extracted text. Lets the UI warn on re-uploading
  -- the same content. Indexed below for the (kb_id, content_hash)
  -- lookup.
  content_hash  TEXT,

  -- Per-document chunk count, set after the embed pass succeeds.
  chunk_count   INTEGER     NOT NULL DEFAULT 0,

  -- 'pending'    — row inserted, ingest not yet started
  -- 'processing' — extract/embed in flight
  -- 'ready'      — searchable
  -- 'failed'     — error column carries the reason; chunks may be
  --                empty or partial
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','ready','failed')),
  error         TEXT,

  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_docs_kb
  ON kb_documents (kb_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_docs_hash
  ON kb_documents (kb_id, content_hash)
  WHERE content_hash IS NOT NULL;


CREATE TABLE IF NOT EXISTS kb_chunks (
  id            UUID         PRIMARY KEY,
  kb_id         UUID         NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id   UUID         NOT NULL REFERENCES kb_documents(id)    ON DELETE CASCADE,
  ordinal       INTEGER      NOT NULL,
  content       TEXT         NOT NULL,
  tokens        INTEGER,
  embedding     vector(1536) NOT NULL,
  -- Free-form per-chunk metadata. Used for richer source-attribution
  -- ("page 3", "section 4.1") when the extractor surfaces it.
  metadata      JSONB,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT kb_chunks_doc_ordinal_unique UNIQUE (document_id, ordinal)
);

-- One ANN index over the whole table — queries always WHERE kb_id =
-- $1 first, so the planner uses the btree on kb_id to filter
-- candidates before the vector comparison. For deployments with
-- millions of chunks per KB we'd want a per-KB partial index or a
-- partitioned table; IVFFlat lists=100 is fine up to ~1M.
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding
  ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb
  ON kb_chunks (kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc
  ON kb_chunks (document_id);

COMMENT ON TABLE kb_chunks IS
  'Per-chunk text + embedding for RAG. Foreign-keyed to kb_documents so deleting a doc auto-purges its chunks.';
