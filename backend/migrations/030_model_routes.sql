-- Phase E: model routing.
--
-- A model_route is a named indirection between a workflow node and
-- the agent that ultimately answers. Three strategies ship in Phase E:
--
--   static    — pin a single agent. Useful for swapping models in
--               one place without editing every workflow.
--   tier      — three slots (cheap / balanced / strong); the caller
--               picks at call time or accepts the route's default.
--   fallback  — ordered chain; try the head, retry on error with the
--               next agent until one returns or the chain is empty.
--
-- The plugin `model.route` reads the route and dispatches; the
-- runner returns the underlying agent's output verbatim so a route
-- is transparent to downstream nodes.

CREATE TABLE IF NOT EXISTS model_routes (
  id            UUID        PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,

  title         TEXT        NOT NULL,
  description   TEXT,

  strategy      TEXT        NOT NULL
                CHECK (strategy IN ('static', 'tier', 'fallback')),

  -- Per-strategy config. Shapes:
  --   static:    { "agent": "<agent title>" }
  --   tier:      { "tiers":   { "cheap": "<title>", "balanced": "<title>", "strong": "<title>" },
  --                "default": "balanced" }
  --   fallback:  { "chain":   ["<title>", "<title>", ...],
  --                "retryOn": ["error", "timeout"] }   ← optional; defaults to all
  config        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT model_routes_title_unique UNIQUE (workspace_id, project_id, title)
);

CREATE INDEX IF NOT EXISTS idx_model_routes_project
  ON model_routes (project_id);

COMMENT ON TABLE model_routes IS
  'Named routing indirections. The model.route plugin reads them at call time and forwards to the chosen agent.';
