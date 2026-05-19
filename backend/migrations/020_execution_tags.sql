-- 020_execution_tags.sql
--
-- Tags v1 — executions only.
--
-- Adds a free-form string-array tag column to every execution row plus a
-- GIN index so the list endpoint's overlap filter (`tags && ARRAY[...]`)
-- stays fast as the table grows.
--
-- Why TEXT[] over JSONB:
--   • Tags are a flat list of strings in v1 (key/value can come later if
--     needed). The array shape gives us native PostgreSQL operators
--     (`&&` overlap, `@>` contains, `<@` is-contained-by) without a
--     JSON cast, and a much smaller on-disk footprint per row.
--   • A GIN index on TEXT[] supports overlap queries directly with the
--     default opclass — no `gin_trgm_ops` install needed.
--
-- Backfill: existing rows pick up `'{}'` (empty array) via the column
-- default, so historical executions stay queryable with no untagged
-- handling needed on the read path.
--
-- Rollback: ALTER TABLE executions DROP COLUMN tags; — drops the index
-- with it (CASCADE not required since the index is on this column only).

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[];

-- GIN index for the list-by-tag query. Marked CONCURRENTLY when run on
-- a populated production DB; the migrator runs in a transaction, so we
-- use the regular form here — fine for a small/empty table at install
-- time and for the dev environments this engine targets.
CREATE INDEX IF NOT EXISTS executions_tags_gin
  ON executions USING GIN (tags);
