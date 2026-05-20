-- RBAC v2 Phase 1 — Project hierarchy.
--
-- Adds a Project entity nested inside Workspace. Every owned resource
-- (graphs, triggers, configs, agents, executions, memories, node_states,
-- audit_logs) now carries project_id NOT NULL — except audit_logs whose
-- project_id is nullable to preserve "workspace-level events" (project
-- creation, role grants, plugin install) that don't have a project
-- context.
--
-- Bootstrap: every existing workspace gets a "Default" project. The
-- Default workspace gets its Default project at a known UUID
-- (00000000-0000-0000-0000-000000000002) so seeds and tests can refer
-- to it without an extra lookup.
--
-- See: wiki/RBAC v2 Design.md

-- ────────────────────────────────────────────────────────────────────
-- Projects
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  -- Free-form labels: owner, cost_center, env, classification, …
  -- The admin UI surfaces well-known keys as a form; others appear in a
  -- raw JSON editor.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Soft-delete + restore window. `deleted_at` flips the project to
  -- hidden; `purge_at` is when the retention runner hard-deletes.
  deleted_at      TIMESTAMPTZ,
  purge_at        TIMESTAMPTZ,

  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT projects_status_chk
    CHECK (status IN ('active', 'archived', 'deleted')),
  -- Slugs are scoped per-workspace, not globally — two workspaces can
  -- both have a "finance" project.
  CONSTRAINT projects_slug_per_workspace_unique
    UNIQUE (workspace_id, slug)
);

COMMENT ON TABLE projects IS
  'Team-isolation unit within a workspace. Every owned resource carries project_id NOT NULL.';

CREATE INDEX IF NOT EXISTS idx_projects_workspace
  ON projects (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_deleted
  ON projects (deleted_at) WHERE deleted_at IS NOT NULL;

-- Seed the Default project under the Default workspace. Known UUID so
-- tests + migrations downstream can reference it without a SELECT.
INSERT INTO projects (id, workspace_id, name, slug, description)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'Default',
  'default',
  'Default project. Pre-RBAC-v2 resources live here.'
)
ON CONFLICT (id) DO NOTHING;

-- For every OTHER existing workspace, create a Default project too.
-- Idempotent thanks to UNIQUE(workspace_id, slug) and the INSERT … SELECT
-- pattern with NOT EXISTS.
INSERT INTO projects (id, workspace_id, name, slug, description)
SELECT
  gen_random_uuid(),
  w.id,
  'Default',
  'default',
  'Default project. Auto-created for workspace ' || w.slug
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM projects p
   WHERE p.workspace_id = w.id AND p.slug = 'default'
);

-- ────────────────────────────────────────────────────────────────────
-- Project membership
-- ────────────────────────────────────────────────────────────────────
--
-- Mirrors workspace_members. Three built-in roles. Workspace admins
-- IMPLICITLY have admin in every project under their workspace; that
-- inheritance is enforced in code (auth/permissions.js), not data,
-- so we don't accumulate millions of synthetic rows.
CREATE TABLE IF NOT EXISTS project_members (
  user_id      UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'editor',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, project_id),
  CONSTRAINT project_members_role_chk
    CHECK (role IN ('admin', 'editor', 'viewer'))
);
CREATE INDEX IF NOT EXISTS idx_project_members_project
  ON project_members (project_id);

-- Existing users keep the same authoring power they had at workspace
-- level by being made editors on the Default project. Workspace admins
-- don't need a row — they inherit. Skip users who are already in the
-- table (re-running this migration is a no-op).
INSERT INTO project_members (user_id, project_id, role)
SELECT
  u.id,
  p.id,
  CASE
    -- workspace admins inherit, don't insert
    WHEN u.role = 'admin'  THEN 'editor'   -- safety: keeps editor row even though they'll inherit admin
    WHEN u.role = 'viewer' THEN 'viewer'
    ELSE 'editor'
  END
FROM users u
JOIN projects p ON p.workspace_id = u.workspace_id AND p.slug = 'default'
WHERE u.role <> 'admin'              -- skip; admins inherit via workspace
  AND NOT EXISTS (
    SELECT 1 FROM project_members pm
     WHERE pm.user_id = u.id AND pm.project_id = p.id
  );

-- ────────────────────────────────────────────────────────────────────
-- project_id on every owned resource.
--
-- All columns are added nullable, backfilled to the workspace's
-- Default project, then locked NOT NULL. This pattern keeps the
-- migration safe to run on a partially-applied DB.
-- ────────────────────────────────────────────────────────────────────

-- graphs ─────────────────────────────────────────────────────────────
ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE graphs g
   SET project_id = p.id
  FROM projects p
 WHERE p.workspace_id = g.workspace_id
   AND p.slug = 'default'
   AND g.project_id IS NULL;

ALTER TABLE graphs
  ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_graphs_project ON graphs (project_id);

-- triggers ───────────────────────────────────────────────────────────
ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE triggers t
   SET project_id = p.id
  FROM projects p
 WHERE p.workspace_id = t.workspace_id
   AND p.slug = 'default'
   AND t.project_id IS NULL;

ALTER TABLE triggers
  ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_triggers_project ON triggers (project_id);

-- configs ────────────────────────────────────────────────────────────
-- Configs are special: project_id is NULLABLE to allow workspace-shared
-- configs (project admin can opt-in to share a config workspace-wide,
-- only workspace admins can author shared configs — enforced in API).
-- shared_at_workspace doubles as a sanity flag so we can index sharing
-- intent independently from a NULL project_id.
ALTER TABLE configs
  ADD COLUMN IF NOT EXISTS project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS shared_at_workspace BOOLEAN NOT NULL DEFAULT false;

UPDATE configs c
   SET project_id = p.id
  FROM projects p
 WHERE p.workspace_id = c.workspace_id
   AND p.slug = 'default'
   AND c.project_id IS NULL;
-- Configs do NOT lock NOT NULL — NULL is meaningful (workspace-shared).
CREATE INDEX IF NOT EXISTS idx_configs_project
  ON configs (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_configs_workspace_shared
  ON configs (workspace_id) WHERE shared_at_workspace = true;

-- agents ─────────────────────────────────────────────────────────────
-- Same sharing semantics as configs.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS shared_at_workspace BOOLEAN NOT NULL DEFAULT false;

UPDATE agents a
   SET project_id = p.id
  FROM projects p
 WHERE p.workspace_id = a.workspace_id
   AND p.slug = 'default'
   AND a.project_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_agents_project
  ON agents (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_workspace_shared
  ON agents (workspace_id) WHERE shared_at_workspace = true;

-- executions ─────────────────────────────────────────────────────────
ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE executions e
   SET project_id = p.id
  FROM projects p
 WHERE p.workspace_id = e.workspace_id
   AND p.slug = 'default'
   AND e.project_id IS NULL;

ALTER TABLE executions
  ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions (project_id);

-- memories ───────────────────────────────────────────────────────────
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE memories m
   SET project_id = p.id
  FROM projects p
 WHERE p.workspace_id = m.workspace_id
   AND p.slug = 'default'
   AND m.project_id IS NULL;

ALTER TABLE memories
  ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project_id);

-- node_states ────────────────────────────────────────────────────────
-- Denormalised from execution.project_id for query efficiency on the
-- common "show me node logs for this project" path.
ALTER TABLE node_states
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE node_states ns
   SET project_id = e.project_id
  FROM executions e
 WHERE e.id = ns.execution_id
   AND ns.project_id IS NULL;

ALTER TABLE node_states
  ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_node_states_project ON node_states (project_id);

-- audit_logs ─────────────────────────────────────────────────────────
-- Nullable on purpose — workspace-level events (project create/delete,
-- user role grant, plugin install) carry workspace_id but NULL project_id.
-- System events still carry both as NULL.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_project
  ON audit_logs (project_id) WHERE project_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- updated_at trigger for projects (matches the pattern used elsewhere).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION projects_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_set_updated_at();

DROP TRIGGER IF EXISTS trg_project_members_updated_at ON project_members;
CREATE TRIGGER trg_project_members_updated_at
  BEFORE UPDATE ON project_members
  FOR EACH ROW EXECUTE FUNCTION projects_set_updated_at();
