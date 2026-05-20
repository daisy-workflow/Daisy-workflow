-- RBAC v2 extras — extension tables for the seven enterprise features.
--
-- These tables exist after Phase 1 so the foundation is in place; their
-- API surfaces and UI land in later phases. Each table comes with a
-- comment describing which phase wires it in.
--
-- See: wiki/RBAC v2 Design.md

-- ────────────────────────────────────────────────────────────────────
-- Project-scoped plugin enablement (Phase 3)
--
-- Plugins are installed at workspace level (the existing `plugins`
-- table is global within an instance). This table records WHICH
-- plugins the project admin has enabled inside their project. Plugins
-- not enabled in a project are not callable by any workflow inside it.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_plugin_grants (
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- No FK to plugins(name) because migration 019 made plugins' primary
  -- key (name, version) — name alone isn't unique, and a partial
  -- unique index (the is_default flag) can't be a FK target. Grants
  -- apply to a plugin by NAME regardless of version, which is the
  -- right semantic anyway: a project trusts "jira", not "jira@1.4.0".
  -- The API does an existence check on plugins.name before writing.
  plugin_name   TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  granted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, plugin_name)
);
CREATE INDEX IF NOT EXISTS idx_project_plugin_grants_plugin
  ON project_plugin_grants (plugin_name);

COMMENT ON TABLE project_plugin_grants IS
  'Per-project plugin allowlist. Workspace admin installs plugins globally; project admin enables which apply in their project. Phase 3.';

-- When a plugin is uninstalled (all versions gone) its grants become
-- inert — the runtime resolver in auth/pluginGrants.js filters against
-- the live plugins table, so orphan rows here are harmless. A periodic
-- sweep can clean them up; not urgent enough to need a DB trigger.

-- ────────────────────────────────────────────────────────────────────
-- Cross-project workflow.fire grants (Phase 3)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cross_project_call_grants (
  caller_project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  callee_project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  granted_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (caller_project_id, callee_project_id),
  -- A project can call itself without an explicit grant — enforced in
  -- code, no constraint needed here.
  CONSTRAINT cross_project_no_self
    CHECK (caller_project_id <> callee_project_id)
);

COMMENT ON TABLE cross_project_call_grants IS
  '"Project A may workflow.fire into Project B." Same-project calls skip this lookup. Phase 3.';

-- ────────────────────────────────────────────────────────────────────
-- Custom roles (Phase 4)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_roles (
  id             UUID PRIMARY KEY,
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  -- Array of permission strings, e.g. ["workflow.read", "execution.read"]
  -- Stored as JSONB for easy querying + GIN indexability.
  permissions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, name)
);

COMMENT ON TABLE custom_roles IS
  'Workspace-scoped custom roles with permission sets. Additive on top of built-in roles. Phase 4.';

CREATE TABLE IF NOT EXISTS role_grants (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type      TEXT NOT NULL,
  scope_id        UUID NOT NULL,
  custom_role_id  UUID REFERENCES custom_roles(id) ON DELETE CASCADE,
  granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT role_grants_scope_chk
    CHECK (scope_type IN ('workspace', 'project'))
);
CREATE INDEX IF NOT EXISTS idx_role_grants_user
  ON role_grants (user_id);
CREATE INDEX IF NOT EXISTS idx_role_grants_scope
  ON role_grants (scope_type, scope_id);

-- ────────────────────────────────────────────────────────────────────
-- Resource-level ACL grants (Phase 4)
--
-- Per-resource permission grants that sit ON TOP of role-based perms.
-- "Mary has view on this one workflow even though she's not in the project."
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_grants (
  id              UUID PRIMARY KEY,
  resource_type   TEXT NOT NULL,   -- 'workflow' | 'config' | 'agent' | ...
  resource_id     UUID NOT NULL,
  principal_type  TEXT NOT NULL,   -- 'user' | 'service_account'
  principal_id    UUID NOT NULL,
  permissions     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["workflow.read", ...]
  granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT resource_grants_principal_chk
    CHECK (principal_type IN ('user', 'service_account')),
  UNIQUE (resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_grants_resource
  ON resource_grants (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_grants_principal
  ON resource_grants (principal_type, principal_id);

-- ────────────────────────────────────────────────────────────────────
-- Service accounts + API keys (Phase 4)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_accounts (
  id            UUID PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  role          TEXT NOT NULL DEFAULT 'editor',   -- built-in role within the project
  status        TEXT NOT NULL DEFAULT 'active',
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,

  CONSTRAINT service_accounts_role_chk
    CHECK (role IN ('admin', 'editor', 'viewer')),
  CONSTRAINT service_accounts_status_chk
    CHECK (status IN ('active', 'disabled')),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_service_accounts_project
  ON service_accounts (project_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  id                    UUID PRIMARY KEY,
  service_account_id    UUID NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
  key_hash              TEXT NOT NULL UNIQUE,        -- sha256 hex of the raw key
  prefix                TEXT NOT NULL,               -- first 8 chars after "dks_", for display
  description           TEXT,
  expires_at            TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  last_used_ip          INET,
  revoked_at            TIMESTAMPTZ,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_service_account
  ON api_keys (service_account_id) WHERE revoked_at IS NULL;
-- Hot path: middleware looks up by hash to authenticate a request.
CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON api_keys (key_hash) WHERE revoked_at IS NULL;

-- ────────────────────────────────────────────────────────────────────
-- Quotas + metering (Phase 5)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_quotas (
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  limit_value  BIGINT NOT NULL,
  period       TEXT NOT NULL,           -- 'month' | 'day' | 'none'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, kind),
  CONSTRAINT project_quotas_kind_chk
    CHECK (kind IN ('tokens_per_month', 'executions_per_day', 'storage_bytes')),
  CONSTRAINT project_quotas_period_chk
    CHECK (period IN ('month', 'day', 'none'))
);

CREATE TABLE IF NOT EXISTS quota_usage (
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  period_start  DATE NOT NULL,            -- always the 1st-of-month or specific day
  usage_value   BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, kind, period_start)
);
-- Hot path: "what's my current usage in this period?" — pure index hit.
CREATE INDEX IF NOT EXISTS idx_quota_usage_current
  ON quota_usage (project_id, kind, period_start DESC);

-- ────────────────────────────────────────────────────────────────────
-- Just-in-time elevation (Phase 5)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jit_grants (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL,           -- 'workspace' | 'project'
  scope_id       UUID NOT NULL,
  role           TEXT NOT NULL,           -- 'admin' typically
  granted_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason         TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT jit_grants_scope_chk
    CHECK (scope_type IN ('workspace', 'project')),
  CONSTRAINT jit_grants_role_chk
    CHECK (role IN ('admin', 'editor', 'viewer'))
);
-- Hot path: "active grants for user U in scope S right now."
CREATE INDEX IF NOT EXISTS idx_jit_grants_active
  ON jit_grants (user_id, scope_type, scope_id)
  WHERE revoked_at IS NULL;
