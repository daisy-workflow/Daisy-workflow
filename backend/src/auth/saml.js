// SAML SSO — per-workspace IdP wrapper.
//
// Built on @node-saml/node-saml (the active fork of passport-saml).
// One SP keypair is shared across all workspaces — the IdPs care
// about distinguishing workspaces via entityID, not the SP cert.
// Operators supply the SP keypair via env vars:
//
//     SAML_SP_ENTITY_ID         https://daisy.example.com
//     SAML_SP_ACS_URL           https://daisy.example.com/api/auth/saml/callback
//     SAML_SP_PRIVATE_KEY       PEM, used to sign AuthnRequests
//     SAML_SP_CERT              PEM, published in SP metadata for IdP to verify our sigs
//
// If any of those are missing, SAML is disabled (the /auth/config
// endpoint reports samlEnabled=false and the LoginPage doesn't show
// the SSO button). One env-vars probe at boot; configs live in the
// `saml_configs` table per workspace.
//
// Workspace selection at login time travels in the RelayState
// parameter — opaque to the IdP, echoed back on the callback. We put
// the workspace_id in there + a CSRF nonce + the post-login `next`
// path the LoginPage wants to bounce to.

import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

// ────────────────────────────────────────────────────────────────────
// SP-side env-driven config — read once at module load.
// ────────────────────────────────────────────────────────────────────
const SP_ENTITY_ID   = process.env.SAML_SP_ENTITY_ID   || null;
const SP_ACS_URL     = process.env.SAML_SP_ACS_URL     || null;
const SP_PRIVATE_KEY = process.env.SAML_SP_PRIVATE_KEY || null;
const SP_CERT        = process.env.SAML_SP_CERT        || null;

/** Is SAML usable at all (regardless of workspace config)? */
export function isSamlConfiguredAtSpLevel() {
  return !!(SP_ENTITY_ID && SP_ACS_URL && SP_PRIVATE_KEY && SP_CERT);
}

// ────────────────────────────────────────────────────────────────────
// Per-workspace config helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Load the SAML config row for a workspace. Returns null when no row
 * exists OR when the row is present but enabled=false (the LoginPage
 * shouldn't even attempt to redirect in that case).
 */
export async function getSamlConfig(workspaceId) {
  if (!workspaceId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM saml_configs WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  if (!r.enabled) return null;
  return r;
}

/**
 * Resolve a workspace slug → id. Used by login + callback so external
 * callers can use the human-friendly slug in URLs while internal
 * lookups use the UUID.
 */
export async function workspaceIdForSlug(slug) {
  if (!slug) return null;
  const { rows } = await pool.query(
    `SELECT id FROM workspaces WHERE slug = $1`,
    [slug],
  );
  return rows[0]?.id || null;
}

// ────────────────────────────────────────────────────────────────────
// @node-saml/node-saml instance per workspace, cached.
//
// Instances are tiny but the cert parsing isn't free — keep one
// alive per workspace. Cache key is workspaceId + a hash of the
// stored IdP fields so a config edit invalidates the cached SAML
// helper without a server restart.
// ────────────────────────────────────────────────────────────────────
const _samlCache = new Map();       // cacheKey → SamlInstance

async function loadSamlClient(workspaceId) {
  if (!isSamlConfiguredAtSpLevel()) {
    throw new Error("SAML SP keypair is not configured. Set SAML_SP_ENTITY_ID, SAML_SP_ACS_URL, SAML_SP_PRIVATE_KEY, SAML_SP_CERT.");
  }
  const cfg = await getSamlConfig(workspaceId);
  if (!cfg) {
    throw new Error("SAML is not enabled for this workspace.");
  }

  const cacheKey = `${workspaceId}|${hashConfig(cfg)}`;
  const cached = _samlCache.get(cacheKey);
  if (cached) return { cfg, saml: cached };

  // Lazy import keeps @node-saml out of the dev install dependency
  // graph until SAML is actually enabled.
  let mod;
  try {
    mod = await import("@node-saml/node-saml");
  } catch (e) {
    throw new Error(
      "SAML requires @node-saml/node-saml. Install with " +
      "`npm install @node-saml/node-saml`. Original: " + e.message,
    );
  }
  const { SAML } = mod;

  const saml = new SAML({
    issuer:                 SP_ENTITY_ID,
    callbackUrl:            SP_ACS_URL,
    entryPoint:             cfg.idp_sso_url,
    logoutUrl:              cfg.idp_slo_url || undefined,
    idpIssuer:              cfg.idp_entity_id,
    idpCert:                cfg.idp_cert,
    privateKey:             SP_PRIVATE_KEY,
    decryptionPvk:          SP_PRIVATE_KEY,
    publicCert:             SP_CERT,
    // Signing posture: sign every AuthnRequest. Most IdPs accept
    // unsigned requests too but enabling this matches enterprise
    // expectations and gives us mutual proof of identity.
    signatureAlgorithm:     "sha256",
    digestAlgorithm:        "sha256",
    wantAssertionsSigned:   true,
    wantAuthnResponseSigned: true,
    // SP-initiated only in v1 — IdP-initiated assertions have looser
    // CSRF protection and are usually unnecessary. Operators that
    // need IdP-initiated can flip this later.
    disableRequestedAuthnContext: false,
    identifierFormat:       "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });

  _samlCache.set(cacheKey, saml);
  // Cap the cache to avoid leaking memory in the (unlikely) case of
  // hundreds of workspaces churning configs. LRU eviction would be
  // nicer but a plain size cap is fine for now.
  if (_samlCache.size > 64) {
    const firstKey = _samlCache.keys().next().value;
    _samlCache.delete(firstKey);
  }
  return { cfg, saml };
}

function hashConfig(cfg) {
  // Hash the fields that change the SAML behaviour. Other columns
  // (attribute_*, default_role, auto_provision) are consumed at
  // callback time, not at SAML-init time.
  return crypto.createHash("sha256")
    .update([cfg.idp_entity_id, cfg.idp_sso_url, cfg.idp_cert, cfg.idp_slo_url || ""].join("|"))
    .digest("hex").slice(0, 16);
}

// ────────────────────────────────────────────────────────────────────
// RelayState — opaque to the IdP, used by us to carry the workspace
// + post-login redirect across the redirect dance. Signed so a
// tampered RelayState can't smuggle a different workspace into the
// callback.
// ────────────────────────────────────────────────────────────────────

const RELAY_SECRET = process.env.SAML_RELAY_SECRET
  || process.env.JWT_SECRET
  || "daisy-saml-relay-fallback-set-SAML_RELAY_SECRET-in-prod";

export function packRelayState({ workspaceId, next }) {
  const body = `${workspaceId}|${next || "/"}|${Date.now()}`;
  const sig = crypto.createHmac("sha256", RELAY_SECRET).update(body).digest("base64url").slice(0, 24);
  return Buffer.from(`${body}|${sig}`, "utf8").toString("base64url");
}

export function unpackRelayState(relay) {
  if (!relay) return null;
  let decoded;
  try { decoded = Buffer.from(relay, "base64url").toString("utf8"); }
  catch { return null; }
  const parts = decoded.split("|");
  if (parts.length !== 4) return null;
  const [workspaceId, next, tsStr, sig] = parts;
  const expected = crypto.createHmac("sha256", RELAY_SECRET)
    .update(`${workspaceId}|${next}|${tsStr}`)
    .digest("base64url").slice(0, 24);
  if (sig !== expected) return null;
  // 10-minute lifetime — same as our OIDC pending-state TTL.
  if (Date.now() - Number(tsStr) > 10 * 60_000) return null;
  return { workspaceId, next };
}

// ────────────────────────────────────────────────────────────────────
// Public ops — used by the auth router.
// ────────────────────────────────────────────────────────────────────

/**
 * Build the URL the user's browser should redirect to in order to
 * begin a SAML login. Includes signed RelayState carrying the
 * workspace + post-login redirect target.
 */
export async function buildAuthnRequestUrl({ workspaceId, next }) {
  const { saml } = await loadSamlClient(workspaceId);
  const relay = packRelayState({ workspaceId, next });
  return await saml.getAuthorizeUrlAsync(relay, undefined, {});
}

/**
 * Consume a SAML POST from the IdP. Returns the verified profile +
 * the RelayState payload (workspaceId, next). Throws on signature /
 * audience mismatch.
 */
export async function consumeSamlResponse(req) {
  const relay = req.body?.RelayState || req.query?.RelayState;
  const payload = unpackRelayState(relay);
  if (!payload) {
    throw new Error("SAML RelayState missing, malformed, or expired");
  }
  const { saml, cfg } = await loadSamlClient(payload.workspaceId);
  const { profile } = await saml.validatePostResponseAsync(req.body);
  if (!profile) throw new Error("SAML response missing profile");

  // Extract attributes the configured names point at. NameID is the
  // canonical subject; email + name are display + matching.
  const sub   = profile.nameID || profile.NameID;
  const email = String(
    profile[cfg.attribute_email]
    || profile.email
    || profile["urn:oid:0.9.2342.19200300.100.1.3"]
    || "",
  ).toLowerCase();
  const name  = profile[cfg.attribute_name]
    || profile.displayName
    || profile.cn
    || null;
  const groupsRaw = cfg.attribute_groups
    ? profile[cfg.attribute_groups]
    : null;
  const groups = Array.isArray(groupsRaw) ? groupsRaw
                : (typeof groupsRaw === "string" && groupsRaw) ? [groupsRaw]
                : [];
  return {
    workspaceId: payload.workspaceId,
    next:        payload.next,
    sub, email, name, groups, cfg,
  };
}

/**
 * SP metadata XML — what the IdP admin imports to configure their
 * side. Per-workspace because we encode the entityID using the
 * workspace slug in the AuthnRequest issuer; without the workspace
 * argument the metadata wouldn't tell the IdP which audience to use.
 */
export async function spMetadata(workspaceId) {
  const { saml } = await loadSamlClient(workspaceId);
  return saml.generateServiceProviderMetadata(SP_CERT, SP_CERT);
}

/** Invalidate the cached client for a workspace — call after config
 *  changes so the next login picks up the new IdP details. */
export function invalidateSamlCache(workspaceId) {
  for (const k of _samlCache.keys()) {
    if (k.startsWith(`${workspaceId}|`)) _samlCache.delete(k);
  }
}

// ────────────────────────────────────────────────────────────────────
// SAML-attribute → local user resolution.
//
// Mirrors the OIDC matching ladder (saml_subject → email → provision).
// Returns the matched / created user row.
// ────────────────────────────────────────────────────────────────────

export async function resolveSamlUser({ workspaceId, sub, email, name, cfg }) {
  if (!sub)   throw new Error("SAML assertion missing NameID (sub)");
  if (!email) throw new Error("SAML assertion missing email attribute (configure attribute_email on the workspace's SAML config)");

  // 1. Match by saml_subject.
  let { rows } = await pool.query(
    `SELECT id, email, role, workspace_id, status
       FROM users WHERE saml_subject = $1`,
    [sub],
  );
  let user = rows[0];

  // 2. Match by email + workspace (link the local row to SAML on
  //    first SSO). The workspace match prevents email collisions
  //    across tenants from accidentally federating users.
  if (!user) {
    const r = await pool.query(
      `SELECT id, email, role, workspace_id, status
         FROM users
        WHERE lower(email) = $1 AND workspace_id = $2`,
      [email, workspaceId],
    );
    user = r.rows[0];
    if (user) {
      await pool.query(
        `UPDATE users SET saml_subject = $1 WHERE id = $2`,
        [sub, user.id],
      );
    }
  }

  // 3. Auto-provision when the workspace config allows it.
  if (!user) {
    if (!cfg.auto_provision) {
      const err = new Error("Your SSO account is not registered in this workspace. Ask an admin to invite you first.");
      err.statusCode = 403;
      throw err;
    }
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role, workspace_id,
                          status, saml_subject, display_name)
       VALUES ($1, lower($2), NULL, $3, $4, 'active', $5, $6)`,
      [id, email, cfg.default_role, workspaceId, sub, name],
    );
    await pool.query(
      `INSERT INTO workspace_members (user_id, workspace_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, workspace_id) DO NOTHING`,
      [id, workspaceId, cfg.default_role],
    );
    user = { id, email, role: cfg.default_role, workspace_id: workspaceId, status: "active" };
    log.info("saml user provisioned", { userId: id, email, workspaceId });
  }

  return user;
}
