-- Phase D: prompt templates + eval framework.
--
-- Five new tables + one column on agents:
--
--   prompt_templates  — versionable, parameterised prompts. Agents
--                       point at one via prompt_template_id.
--                       Substitution syntax: ${var}.
--   eval_suites       — a named collection of test cases bound to an
--                       agent. One suite ≈ one regression-test target.
--   eval_cases        — individual test cases inside a suite, each
--                       carrying inputs + an array of scorer configs.
--   eval_runs         — one row per "run this suite now" invocation.
--                       Carries totals (passed/failed/score, tokens,
--                       cost) and overall status.
--   eval_results      — per-case rows for one run: the agent's
--                       output, each scorer's verdict, latency,
--                       tokens, cost.
--
--   agents.prompt_template_id — optional FK. When set, the agent
--                       renders the template (with vars from the
--                       call input) instead of its inline prompt.

-- ─── Prompt templates ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompt_templates (
  id                  UUID        PRIMARY KEY,
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          UUID        REFERENCES projects(id)   ON DELETE CASCADE,
  -- Workspace-shared rows have project_id IS NULL + shared_at_workspace=true,
  -- mirroring configs/agents sharing model.
  shared_at_workspace BOOLEAN     NOT NULL DEFAULT false,

  title               TEXT        NOT NULL,
  description         TEXT,

  -- The prompt body. May contain ${var} placeholders. The variables
  -- column documents the expected vars (for the editor UI's hint
  -- panel + run-time validation) but the substitution is best-effort
  -- — unknown ${var}s render as empty by default.
  body                TEXT        NOT NULL,
  -- Array of { name, type, description, default? }. Stored as JSONB
  -- so future field-types (e.g. enum, number) can land without a
  -- migration.
  variables           JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Workspace-shared rows: project_id IS NULL → uniqueness must look
  -- at NULL specially. Two partial unique indexes cover the cases
  -- cleanly without a NULLS-NOT-DISTINCT (PG 15+) requirement.
  CONSTRAINT prompt_templates_title_chk CHECK (length(title) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS prompt_templates_project_title_uniq
  ON prompt_templates (workspace_id, project_id, title)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS prompt_templates_shared_title_uniq
  ON prompt_templates (workspace_id, title)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_templates_project
  ON prompt_templates (project_id) WHERE project_id IS NOT NULL;


-- ─── Agent → template link ──────────────────────────────────────
-- Nullable so existing agents keep working with their inline prompt.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS prompt_template_id UUID
    REFERENCES prompt_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN agents.prompt_template_id IS
  'When set, the agent renders this template with ${vars} substitution from the call input instead of using its inline prompt column.';


-- ─── Eval suites ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_suites (
  id            UUID        PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,

  title         TEXT        NOT NULL,
  description   TEXT,

  -- One suite targets one agent. Re-using the same agent across
  -- multiple suites is fine; "regression suite for support agent"
  -- and "smoke suite for support agent" can coexist.
  agent_id      UUID        REFERENCES agents(id) ON DELETE SET NULL,

  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT eval_suites_title_unique UNIQUE (workspace_id, project_id, title)
);

CREATE INDEX IF NOT EXISTS idx_eval_suites_project
  ON eval_suites (project_id);


-- ─── Eval cases ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_cases (
  id            UUID        PRIMARY KEY,
  suite_id      UUID        NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,

  title         TEXT        NOT NULL,
  -- The input passed to the agent. Shape: { input: "<text>", vars: { ... } }
  -- so the same case row works whether the agent uses an inline
  -- prompt or a template (vars get merged into the template render
  -- context).
  inputs        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Per-scorer expected values (free-form because each scorer
  -- interprets its own expected shape). Shape: { exact: "...",
  -- contains: ["...","..."], regex: "...", json: { ... }, llm_judge: { rubric: "..." } }
  expected      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Which scorers to run for this case + per-scorer config.
  -- Shape: [{ type: "exact" | "contains" | "regex" | "json" | "llm_judge",
  --          weight: 1, config: { ... } }]
  scorers       JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Used for ordering in the editor; also for stable result display.
  position      INTEGER     NOT NULL DEFAULT 0,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_suite
  ON eval_cases (suite_id, position);


-- ─── Eval runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_runs (
  id            UUID        PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  suite_id      UUID        NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  agent_id      UUID        REFERENCES agents(id) ON DELETE SET NULL,

  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  -- Aggregate counters. Updated once at end-of-run; running snapshot
  -- not modelled (the UI polls eval_results for in-flight progress).
  --   { passed, failed, score, totalTokens, totalCostMicros, durationMs }
  totals        JSONB,
  error         TEXT,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_suite_time
  ON eval_runs (suite_id, started_at DESC);


-- ─── Eval results ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_results (
  id            UUID        PRIMARY KEY,
  run_id        UUID        NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id       UUID        NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  -- Snapshot of the case title so historical results stay readable
  -- even after the case is renamed / deleted.
  case_title    TEXT        NOT NULL,

  status        TEXT        NOT NULL CHECK (status IN ('passed', 'failed', 'errored')),
  -- The model's raw output. May contain PII — operators can prune via
  -- retention. Truncated by the runner to 64KB to keep the table lean.
  output_text   TEXT,
  -- Array of { type, passed, score, weight, details }. Same length +
  -- order as the case's scorers.
  scorer_results JSONB     NOT NULL DEFAULT '[]'::jsonb,
  -- Aggregate score for this case (weighted average of scorer scores).
  score         REAL,
  -- Provider stats from the agent call. cost_micros mirrors
  -- agent_token_events; we copy here for case-level analytics.
  latency_ms    INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_micros   BIGINT,
  -- Populated on status='errored' — agent call failed, etc.
  error         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run
  ON eval_results (run_id, created_at);
