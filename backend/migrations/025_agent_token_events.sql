-- Per-call token + cost events for AI agent invocations.
--
-- Append-only — one row per agent invocation. Distinct from
-- quota_usage (which only carries the rolled-up current-period total)
-- so the admin UI can break usage down by model / agent / workflow /
-- time bucket without changing the quota-enforcement hot path.
--
-- Volume: at 10k agent calls/day this table grows ~1MB/day, ~360MB
-- after a year. The retention runner can prune events older than
-- AGENT_TOKEN_EVENT_DAYS (default 365) — same pattern as
-- pruneAuditLogs. Rollups in quota_usage are unaffected by the prune.

CREATE TABLE IF NOT EXISTS agent_token_events (
  id              UUID        PRIMARY KEY,
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  -- Execution + agent context. Both nullable: execution_id is set
  -- when the call ran inside a workflow; agent_id can vanish if the
  -- agent row gets deleted later, which is why we denormalise
  -- agent_title.
  execution_id    UUID,
  agent_id        UUID        REFERENCES agents(id) ON DELETE SET NULL,
  agent_title     TEXT,
  -- Provider + model identity. provider is the registry name
  -- (openai / anthropic / bedrock / etc.); model is whatever the
  -- config carried at call time.
  provider        TEXT        NOT NULL,
  model           TEXT        NOT NULL,
  -- Token counts as returned by the provider. We trust the provider's
  -- usage block — when it's missing we record 0 rather than estimate.
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  -- Cost in micro-dollars (10^-6 USD). Integer-typed to avoid float
  -- drift over millions of rows. dollars = cost_micros / 1_000_000.
  cost_micros     BIGINT      NOT NULL DEFAULT 0,
  -- True when the request hit the agent-level prompt cache and no
  -- provider call was made. cost_micros is 0 for cache hits; input
  -- and output tokens reflect what the original cached call charged.
  cache_hit       BOOLEAN     NOT NULL DEFAULT false,
  -- Latency in milliseconds for the provider call. Skipped on cache
  -- hits. Useful for the future model-router work and for spotting a
  -- provider that's gotten slower.
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot index for the per-project breakdown — "what did this project
-- spend by model, last 30 days?"
CREATE INDEX IF NOT EXISTS idx_agent_token_events_project_time
  ON agent_token_events (project_id, created_at DESC);

-- Per-model breakdown across the whole workspace.
CREATE INDEX IF NOT EXISTS idx_agent_token_events_workspace_model
  ON agent_token_events (workspace_id, model, created_at DESC);

COMMENT ON TABLE agent_token_events IS
  'Per-invocation log of agent token usage + dollar cost. Append-only; pruned by retention runner.';
