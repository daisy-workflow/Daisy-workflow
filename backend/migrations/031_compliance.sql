-- Phase F: compliance modes + data residency.
--
-- Three new workspace-level columns; no separate compliance table
-- because the constraints live in code (src/compliance/policies.js)
-- and are deliberately not user-editable per mode (changing what
-- HIPAA means at runtime is a footgun).
--
--   compliance_mode      — 'none' | 'hipaa' | 'gdpr'
--                          Default 'none' keeps every existing
--                          workspace working unchanged.
--   data_residency       — 'global' | 'us' | 'eu' | 'apac'
--                          Restricts allowed provider endpoint
--                          regions. 'global' = no restriction.
--   compliance_settings  — JSONB carrying mode-specific contacts:
--                          { gdprDpoEmail, hipaaContactEmail,
--                            customMessage }. Mostly used by the UI
--                            to show "report a violation" addresses;
--                            no enforcement value.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS compliance_mode TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS data_residency  TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS compliance_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- CHECK constraints added in a second pass so this migration stays
-- idempotent against partial reruns. The check values are kept in
-- sync with src/compliance/policies.js#MODES.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_compliance_mode_chk'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_compliance_mode_chk
        CHECK (compliance_mode IN ('none', 'hipaa', 'gdpr'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_data_residency_chk'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_data_residency_chk
        CHECK (data_residency IN ('global', 'us', 'eu', 'apac'));
  END IF;
END $$;

COMMENT ON COLUMN workspaces.compliance_mode IS
  'Workspace-wide compliance regime. none = no restrictions; hipaa = BAA-eligible providers only + forced PII redact + no URL fetches; gdpr = GDPR endpoints (export/erasure) + forced PII redact.';
COMMENT ON COLUMN workspaces.data_residency IS
  'Workspace-wide data-residency region. Restricts provider endpoint URLs; "global" = no restriction.';
COMMENT ON COLUMN workspaces.compliance_settings IS
  'Mode-specific contacts and overrides. See src/api/compliance.js for the accepted shape.';


-- Track per-user erasure events so we have a paper trail for GDPR
-- audits. The user row is anonymised in place (we don't hard-delete
-- because audit log entries FK back to it); a row here records WHO
-- requested it, WHO ran it, and WHEN.
CREATE TABLE IF NOT EXISTS compliance_erasure_log (
  id            UUID        PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Target user — kept as plain text after the user row is
  -- anonymised so the audit trail survives.
  user_id       UUID,
  user_email_at_erasure TEXT,
  requested_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT,
  -- Per-resource counts so an auditor can see what got wiped vs.
  -- what was retained (audit log entries are retained on legal-hold
  -- grounds; memories are erased).
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_erasure_workspace_time
  ON compliance_erasure_log (workspace_id, created_at DESC);

COMMENT ON TABLE compliance_erasure_log IS
  'GDPR Article 17 audit trail. Every right-to-erasure invocation lands here, with per-resource counts in `details` so the auditor can reconstruct what was wiped and what was retained.';
