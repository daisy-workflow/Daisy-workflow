-- SAML SSO — per-workspace IdP configuration.
--
-- Each workspace can have at most one SAML config (1-to-1 with
-- workspaces, hence the PK). When enabled, /auth/saml/login?workspace=<slug>
-- builds the AuthnRequest from this row and ships the browser to
-- idp_sso_url. The IdP POSTs the assertion back to our ACS at
-- /auth/saml/callback, which verifies the signature against idp_cert,
-- extracts the named attributes, and matches / provisions the local
-- user — mirroring the OIDC flow.

CREATE TABLE IF NOT EXISTS saml_configs (
  workspace_id        UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT false,

  -- IdP side — supplied by the customer's identity team.
  idp_entity_id       TEXT NOT NULL,
  idp_sso_url         TEXT NOT NULL,
  idp_slo_url         TEXT,                                   -- optional single-logout endpoint
  idp_cert            TEXT NOT NULL,                          -- x509 PEM, signs assertions

  -- Attribute mapping — IdPs use wildly inconsistent names for the
  -- same data. Defaults are the most common OASIS names but each row
  -- can override. Email is required; name is a display hint; groups
  -- is null when the IdP doesn't expose them.
  attribute_email     TEXT NOT NULL DEFAULT 'email',
  attribute_name      TEXT NOT NULL DEFAULT 'displayName',
  attribute_groups    TEXT,

  -- Provisioning policy. When auto_provision=true, a successful SSO
  -- for an unknown email creates a local user with default_role.
  -- When false, unknown users are rejected with a clear message.
  auto_provision      BOOLEAN NOT NULL DEFAULT true,
  default_role        TEXT NOT NULL DEFAULT 'editor',

  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT saml_configs_default_role_chk
    CHECK (default_role IN ('admin', 'editor', 'viewer'))
);

COMMENT ON TABLE saml_configs IS
  'Per-workspace SAML 2.0 SSO configuration. One row per workspace; enabled flag flips SSO on without losing config when temporarily disabling.';

-- Per-user SAML subject (NameID) for stable identity matching across
-- email changes — mirrors the oidc_subject column. Nullable because
-- the same user table is also used by local / OIDC accounts.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS saml_subject TEXT;
CREATE INDEX IF NOT EXISTS idx_users_saml_subject
  ON users (saml_subject) WHERE saml_subject IS NOT NULL;
