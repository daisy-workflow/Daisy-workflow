-- Service-account audit distinguishability.
--
-- The audit log already records who performed each action via
-- actor_id + denormalised actor_email. Once API keys ship, the actor
-- can be a service account rather than a human — `actor_kind` lets
-- queries filter or display "human-initiated" vs "automation-driven"
-- without joining anywhere.
--
-- Existing rows are backfilled to 'user' (the only kind that existed
-- before this migration).

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'user';

-- Defence in depth — only the two kinds we know about today. New
-- kinds (e.g. 'oauth_app' or 'workflow_internal') can be added by
-- relaxing this constraint in a follow-up migration.
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_actor_kind_chk;
ALTER TABLE audit_logs
  ADD  CONSTRAINT audit_logs_actor_kind_chk
    CHECK (actor_kind IN ('user', 'service_account'));

-- Cheap filter for "show me only automation actions" / vice versa.
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_kind
  ON audit_logs (workspace_id, actor_kind, created_at DESC);
