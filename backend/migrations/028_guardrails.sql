-- Guardrails — input/output content filters applied to every agent call.
--
-- Three artefacts:
--
--   guardrail_policies     — one row per project carrying the default
--                            policy (per-detector enabled flag, mode,
--                            thresholds). Apply scope is per-side
--                            (input only / output only / both / none).
--
--   agents.guardrails_override
--                          — partial JSONB on each agent row. Overrides
--                            the project policy at agent granularity.
--                            Missing fields fall through to the project
--                            default.
--
--   guardrail_violations   — append-only audit log of every flagged
--                            detection. Indexed by (project, time) for
--                            the GuardrailsPage's violation feed, and
--                            by execution for per-run diagnosis.
--
-- Detectors today: pii (regex-based), toxicity (OpenAI Moderation),
-- jailbreak (heuristic patterns). Each is configured under
-- guardrail_policies.config.<detector>.

CREATE TABLE IF NOT EXISTS guardrail_policies (
  id            UUID        PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,

  -- Which side(s) of the agent call to scan. 'none' = guardrails
  -- temporarily disabled for the project without losing the config.
  apply_to      TEXT        NOT NULL DEFAULT 'both'
                CHECK (apply_to IN ('input', 'output', 'both', 'none')),

  -- Per-detector config. Top-level keys are detector names; each
  -- value is its config object (enabled flag + mode + thresholds +
  -- type lists). See src/guardrails/detectors/index.js for the
  -- catalog the UI uses to render this.
  config        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  updated_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One policy per project. Workspace defaults are not modelled
  -- separately for Phase C — projects are seeded with sensible defaults
  -- (off-by-default) when their first PUT lands.
  CONSTRAINT guardrail_policies_unique UNIQUE (workspace_id, project_id)
);

COMMENT ON TABLE guardrail_policies IS
  'Per-project default guardrail policy. Agent-level overrides live in agents.guardrails_override.';

-- Agent-level override. Partial JSONB; the orchestrator deep-merges
-- it on top of the project policy at every call. NULL = no override.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS guardrails_override JSONB;

COMMENT ON COLUMN agents.guardrails_override IS
  'Optional per-agent guardrail overrides. Same shape as guardrail_policies.config; merged on top of the project policy.';


CREATE TABLE IF NOT EXISTS guardrail_violations (
  id            UUID        PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,

  -- Origin: which execution + node + agent triggered the violation.
  -- All nullable because the same machinery also catches violations
  -- from the test endpoint (no execution) and agents that were
  -- subsequently deleted.
  execution_id  UUID,
  node          TEXT,
  agent_id      UUID        REFERENCES agents(id) ON DELETE SET NULL,
  agent_title   TEXT,

  side          TEXT        NOT NULL CHECK (side IN ('input', 'output')),
  detector      TEXT        NOT NULL,
  -- Configured mode at the time of detection. Recorded alongside
  -- action_taken so we can audit "policy was warn, action was warned"
  -- vs "policy was warn at time of policy edit".
  mode          TEXT        NOT NULL CHECK (mode IN ('block', 'redact', 'warn')),
  action_taken  TEXT        NOT NULL CHECK (action_taken IN ('blocked', 'redacted', 'warned')),
  -- Per-detector evidence — PII match list, moderation scores,
  -- jailbreak rule ids. Never carries raw user text; PII matches are
  -- masked before storage.
  details       JSONB,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "what violations did THIS project log recently?" Drives
-- the GuardrailsPage violations feed.
CREATE INDEX IF NOT EXISTS idx_gv_project_time
  ON guardrail_violations (project_id, created_at DESC);

-- Per-execution lookup for the execution-detail view.
CREATE INDEX IF NOT EXISTS idx_gv_execution
  ON guardrail_violations (execution_id)
  WHERE execution_id IS NOT NULL;

COMMENT ON TABLE guardrail_violations IS
  'Append-only audit log of guardrail detections. Pruned by the retention runner (GUARDRAIL_VIOLATION_DAYS, default 90).';
