// Authentication endpoints.
//
//   POST /auth/login    — email + password → access JWT + refresh cookie
//   POST /auth/refresh  — uses refresh cookie → new access JWT + rotated cookie
//   POST /auth/logout   — revokes refresh token + clears cookie
//   GET  /auth/me       — current user info (requires bearer)
//   GET  /auth/config   — public discovery (advertises OIDC if configured)
//
// All four mutating endpoints are mounted UNDER /auth, which is also
// the cookie path so the refresh cookie isn't sent on /graphs etc.
//
// Logging note:
//   Failed logins always return 401 with the same body regardless of
//   whether the user exists or the password was wrong — this avoids
//   user-enumeration via timing or response shape. The structured log
//   line on failure DOES include enough context for an admin to
//   investigate (email + outcome).

import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { log } from "../utils/logger.js";
import { ValidationError, UnauthorizedError } from "../utils/errors.js";
import { hash, verify, needsRehash } from "../auth/passwords.js";
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  REFRESH_COOKIE,
  refreshCookieOptions,
} from "../auth/tokens.js";
import { requireUser } from "../middleware/auth.js";
import { limiters } from "../middleware/rateLimit.js";
import { auditLog } from "../audit/log.js";
import {
  isSamlConfiguredAtSpLevel,
  getSamlConfig,
  workspaceIdForSlug,
  buildAuthnRequestUrl,
  consumeSamlResponse,
  resolveSamlUser,
  spMetadata,
} from "../auth/saml.js";

const router = Router();

// ──────────────────────────────────────────────────────────────────────
// OIDC — lazy imported, only active when OIDC_ISSUER_URL is set.
//
// Memory-backed pending-flow store keyed by state. Each entry holds the
// PKCE verifier + the post-login redirect URL. Single-process scope is
// fine for self-hosted; switch to Redis if you ever fan out to multiple
// API instances. Entries auto-expire after 10 minutes — well past any
// realistic OIDC redirect dance.
// ──────────────────────────────────────────────────────────────────────
const oidcPending = new Map();
const OIDC_TTL_MS = 10 * 60 * 1000;

let _oidcClient = null;
async function getOidcClient() {
  if (_oidcClient) return _oidcClient;
  if (!process.env.OIDC_ISSUER_URL) return null;
  let openid;
  try { openid = await import("openid-client"); }
  catch (e) {
    log.warn("OIDC requested but openid-client not installed", { error: e.message });
    return null;
  }
  const { Issuer } = openid;
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER_URL);
  _oidcClient = new issuer.Client({
    client_id:     process.env.OIDC_CLIENT_ID,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    redirect_uris: [process.env.OIDC_REDIRECT_URI],
    response_types: ["code"],
  });
  log.info("oidc client ready", { issuer: issuer.metadata.issuer });
  return _oidcClient;
}

// ────────────────────────────────────────────────────────────────────
// GET /auth/config — public, no auth.
//
// Lets the frontend ask "is OIDC available, what's the SSO button
// label?" before painting the login screen. Returns nothing sensitive.
// ────────────────────────────────────────────────────────────────────
router.get("/config", async (req, res) => {
  const oidcEnabled = !!process.env.OIDC_ISSUER_URL;
  // SAML is per-workspace. The login screen asks "does workspace X
  // have SAML on?" via ?workspace=<slug>. Without a slug we just
  // report whether the SP keypair is configured (so the UI can show
  // a "Sign in with SSO — pick your workspace" affordance).
  let samlEnabled = false;
  let samlLabel = process.env.SAML_BUTTON_LABEL || "Sign in with SAML";
  if (isSamlConfiguredAtSpLevel()) {
    const slug = req.query?.workspace;
    if (slug) {
      const wsId = await workspaceIdForSlug(String(slug));
      if (wsId) {
        const cfg = await getSamlConfig(wsId);
        samlEnabled = !!cfg;
      }
    } else {
      // SP-level switch is on; per-workspace state is unknown until
      // the user picks one. The frontend renders the SSO button with
      // a workspace-slug prompt in this case.
      samlEnabled = true;
    }
  }
  res.json({
    localEnabled: true,
    oidcEnabled,
    oidcLabel:  process.env.OIDC_BUTTON_LABEL || "Sign in with SSO",
    samlEnabled,
    samlLabel,
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /auth/login   { email, password }
//
// Two limiters: per-IP catches a flood from a single attacker;
// per-email catches credential-stuffing across rotating proxies
// (same target email, different IPs).
// ────────────────────────────────────────────────────────────────────
router.post("/login", limiters.login, limiters.loginByEmail, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      throw new ValidationError("email and password required");
    }
    const u = await findActiveUserByEmail(email);
    const ok = u && u.password_hash && await verify(password, u.password_hash);
    if (!ok) {
      log.warn("login failed", { email });
      // Audit the failure with the attempted email — useful for
      // spotting credential-stuffing patterns across IPs even if
      // the email doesn't correspond to a real user.
      await auditLog({
        req, action: "auth.login", outcome: "failed",
        actor: { email: String(email || "").toLowerCase() },
        metadata: { reason: u ? "bad-password" : "no-user" },
      });
      // Single 401 shape regardless of which check failed.
      throw new UnauthorizedError("invalid credentials");
    }

    // Opportunistic rehash if we bumped the cost factor since this
    // hash was created. Keeps stored hashes current at zero user cost.
    if (needsRehash(u.password_hash)) {
      const fresh = await hash(password);
      await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",
        [fresh, u.id]);
    }

    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id=$1", [u.id]);
    log.info("login ok", { userId: u.id, email: u.email });
    await auditLog({
      req, action: "auth.login",
      actor: { id: u.id, email: u.email, role: u.role },
      workspaceId: u.workspace_id,
    });

    const tokens = await issueTokensFor(req, res, u);
    res.json(tokens);
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /auth/refresh   (uses cookie)
//
// Reads the refresh token from the cookie, rotates it (issues a new
// one, marks the old revoked + chained), and hands back a fresh
// access JWT. Theft-replay protection lives in consumeRefreshToken().
// ────────────────────────────────────────────────────────────────────
router.post("/refresh", limiters.refresh, async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedError("missing refresh cookie");

    const consumed = await consumeRefreshToken(presented);
    if (!consumed) {
      // Either expired, revoked, or theft-replay (consume already
      // burned the user's chain in that case). Audit either way —
      // a rejected refresh is interesting when investigating a
      // session-hijack scenario.
      await auditLog({
        req, action: "auth.refresh", outcome: "failed",
        metadata: { reason: "invalid-or-theft-replay" },
      });
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      throw new UnauthorizedError("refresh token invalid");
    }

    const { rows } = await pool.query(
      `SELECT id, email, role, workspace_id, status
         FROM users WHERE id = $1`,
      [consumed.userId],
    );
    if (rows.length === 0 || rows[0].status !== "active") {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      throw new UnauthorizedError("user not available");
    }
    const u = rows[0];

    const next = await issueRefreshToken({
      userId:        u.id,
      userAgent:     req.headers["user-agent"] || null,
      ip:            req.ip || null,
      predecessorId: consumed.id,
    });
    res.cookie(REFRESH_COOKIE, next.token, refreshCookieOptions());

    res.json({
      accessToken: signAccessToken({
        userId:      u.id,
        email:       u.email,
        role:        u.role,
        workspaceId: u.workspace_id,
      }),
      user: publicUser(u),
    });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /auth/logout
//
// Best-effort revoke of the refresh cookie + clear it. Idempotent —
// always returns 204 even if the cookie was missing or already
// revoked, so the client UI doesn't hang on logout failures.
// ────────────────────────────────────────────────────────────────────
router.post("/logout", async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(presented);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    await auditLog({ req, action: "auth.logout" });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// GET /auth/me — requires Authorization: Bearer
//
// Returns the user object the frontend's auth store uses. Cheap
// (no DB hit beyond what requireUser already did).
// ────────────────────────────────────────────────────────────────────
router.get("/me", requireUser, async (req, res) => {
  res.json({
    id:          req.user.id,
    email:       req.user.email,
    role:        req.user.role,
    workspaceId: req.user.workspaceId,
    status:      req.user.status,
  });
});

// ────────────────────────────────────────────────────────────────────
// OIDC: GET /auth/oidc/login?next=/some/path
//
// Kicks off the auth-code-with-PKCE dance:
//   1. Generate state + a code verifier.
//   2. Stash the verifier + post-login URL keyed by state.
//   3. Redirect to the provider's authorization_endpoint with the
//      state + the code_challenge.
// On the way back, /auth/oidc/callback consumes the state, exchanges
// the code, and issues our session cookies.
// ────────────────────────────────────────────────────────────────────
router.get("/oidc/login", async (req, res, next) => {
  try {
    const client = await getOidcClient();
    if (!client) {
      return res.status(404).send("OIDC is not configured on this server.");
    }
    const { generators } = await import("openid-client");
    const state    = generators.state();
    const verifier = generators.codeVerifier();
    const challenge = generators.codeChallenge(verifier);
    oidcPending.set(state, {
      verifier,
      next:    typeof req.query.next === "string" && req.query.next.startsWith("/")
                 ? req.query.next : "/",
      created: Date.now(),
    });
    setTimeout(() => oidcPending.delete(state), OIDC_TTL_MS).unref?.();

    const url = client.authorizationUrl({
      scope: process.env.OIDC_SCOPE || "openid email profile",
      state,
      code_challenge:        challenge,
      code_challenge_method: "S256",
    });
    res.redirect(url);
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// OIDC: GET /auth/oidc/callback
//
// Exchange the authorization code, verify the id_token, locate or
// auto-provision the user, and issue Daisy session tokens.
//
// Match strategy:
//   1. Match by oidc_subject — fastest, survives email change.
//   2. If no match, match by lower(email) — when an admin created the
//      user locally first, this links the local row to OIDC on first
//      SSO login.
//   3. If still no match, auto-provision IF
//      OIDC_AUTOPROVISION=true; otherwise refuse with a clear error.
//
// Newly provisioned OIDC users land in the workspace named by
// OIDC_DEFAULT_WORKSPACE (or "Default") with role=editor by default.
// Admin can promote them through the users API afterwards.
// ────────────────────────────────────────────────────────────────────
router.get("/oidc/callback", async (req, res, next) => {
  try {
    const client = await getOidcClient();
    if (!client) {
      return res.status(404).send("OIDC is not configured on this server.");
    }

    const params  = client.callbackParams(req);
    const pending = oidcPending.get(params.state || "");
    if (!pending) {
      return res.status(400).send("OIDC state expired or unknown — try signing in again.");
    }
    oidcPending.delete(params.state);

    const tokenSet = await client.callback(
      process.env.OIDC_REDIRECT_URI,
      params,
      { state: params.state, code_verifier: pending.verifier },
    );
    const claims = tokenSet.claims();
    const sub   = claims.sub;
    const email = (claims.email || "").toLowerCase();
    if (!sub) {
      return res.status(400).send("OIDC response missing `sub` claim.");
    }
    if (!email) {
      return res.status(400).send("OIDC response missing `email` claim. Add the `email` scope.");
    }

    // 1. Match by oidc_subject.
    let user = await findOne(
      `SELECT id, email, role, workspace_id, status
         FROM users WHERE oidc_subject = $1`,
      [sub],
    );

    // 2. Match by email (link local account to OIDC on first SSO).
    if (!user) {
      user = await findOne(
        `SELECT id, email, role, workspace_id, status
           FROM users WHERE lower(email) = $1`,
        [email],
      );
      if (user) {
        await pool.query(
          "UPDATE users SET oidc_subject=$1 WHERE id=$2",
          [sub, user.id],
        );
      }
    }

    // 3. Auto-provision (opt-in).
    if (!user) {
      if (String(process.env.OIDC_AUTOPROVISION || "").toLowerCase() !== "true") {
        return res.status(403).send(
          "Your SSO account is not registered. Ask an admin to create your user, " +
          "or set OIDC_AUTOPROVISION=true to enable self-signup.",
        );
      }
      const wsName = process.env.OIDC_DEFAULT_WORKSPACE || "Default";
      const ws = await ensureWorkspaceByName(wsName);
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, password_hash, role, workspace_id,
                            status, oidc_subject, display_name)
         VALUES ($1, lower($2), NULL, 'editor', $3, 'active', $4, $5)`,
        [id, email, ws.id, sub, claims.name || null],
      );
      await pool.query(
        `INSERT INTO workspace_members (user_id, workspace_id, role)
         VALUES ($1, $2, 'editor')
         ON CONFLICT DO NOTHING`,
        [id, ws.id],
      );
      user = { id, email, role: "editor", workspace_id: ws.id, status: "active" };
      log.info("oidc user provisioned", { userId: id, email });
    }

    if (user.status !== "active") {
      return res.status(403).send("Your account is disabled — contact an admin.");
    }

    await pool.query("UPDATE users SET last_login_at=NOW() WHERE id=$1", [user.id]);
    log.info("oidc login ok", { userId: user.id, email: user.email });
    await auditLog({
      req, action: "auth.oidc.login",
      actor: { id: user.id, email: user.email, role: user.role },
      workspaceId: user.workspace_id,
      metadata: { sub },
    });

    // Issue Daisy tokens. We set the refresh cookie and bounce back
    // to the SPA at /login?oidc=done&next=…; the LoginPage hook calls
    // auth.tryRefresh() to materialise the access token in memory.
    const refresh = await issueRefreshToken({
      userId:    user.id,
      userAgent: req.headers["user-agent"] || null,
      ip:        req.ip || null,
    });
    res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());

    const next = pending.next || "/";
    const search = new URLSearchParams({ oidc: "done", next }).toString();
    res.redirect(`/login?${search}`);
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function findOne(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function ensureWorkspaceByName(name) {
  const slug = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "default";
  const { rows: existing } = await pool.query(
    "SELECT id, name FROM workspaces WHERE slug=$1", [slug],
  );
  if (existing.length) return existing[0];
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)",
    [id, name, slug],
  );
  return { id, name };
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function findActiveUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, role, workspace_id, status, password_hash
       FROM users
      WHERE lower(email) = lower($1) AND status = 'active'
      LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function issueTokensFor(req, res, u) {
  const accessToken = signAccessToken({
    userId:      u.id,
    email:       u.email,
    role:        u.role,
    workspaceId: u.workspace_id,
  });
  const refresh = await issueRefreshToken({
    userId:    u.id,
    userAgent: req.headers["user-agent"] || null,
    ip:        req.ip || null,
  });
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
  return {
    accessToken,
    user: publicUser(u),
  };
}

function publicUser(u) {
  return {
    id:          u.id,
    email:       u.email,
    role:        u.role,
    workspaceId: u.workspace_id,
    status:      u.status,
  };
}

// ════════════════════════════════════════════════════════════════════
// SAML SSO — multi-tenant per-workspace.
//
// Three routes:
//
//   GET  /auth/saml/login?workspace=<slug>&next=<path>
//        Builds the AuthnRequest for the named workspace's IdP and
//        302-redirects the browser to it. Workspace selection lives
//        in the query — the IdP echoes it back via RelayState.
//
//   POST /auth/saml/callback
//        ACS endpoint. The IdP POSTs the signed SAML assertion here;
//        we verify, map attributes onto a local user, issue Daisy's
//        refresh cookie, and bounce the browser back to /login so
//        the SPA can materialise the access token.
//
//   GET  /auth/saml/metadata?workspace=<slug>
//        Service-provider metadata XML — what the IdP admin imports
//        to configure their side without manual field copying.
//
// All three are public (no requireUser). RelayState carries a signed
// payload so a tampered redirect can't smuggle a different workspace
// into the callback. See auth/saml.js for the wrapper internals.
// ════════════════════════════════════════════════════════════════════

router.get("/saml/login", async (req, res, next) => {
  try {
    if (!isSamlConfiguredAtSpLevel()) {
      return res.status(404).send("SAML is not configured on this server.");
    }
    const slug = String(req.query.workspace || "").trim();
    if (!slug) return res.status(400).send("workspace query param required");
    const wsId = await workspaceIdForSlug(slug);
    if (!wsId) return res.status(404).send(`workspace "${slug}" not found`);
    const cfg = await getSamlConfig(wsId);
    if (!cfg) return res.status(404).send(`SAML is not enabled for workspace "${slug}"`);

    const next = (typeof req.query.next === "string" && req.query.next.startsWith("/"))
      ? req.query.next
      : "/";
    const url = await buildAuthnRequestUrl({ workspaceId: wsId, next });
    res.redirect(url);
  } catch (e) { next(e); }
});

router.post("/saml/callback", async (req, res, next) => {
  try {
    if (!isSamlConfiguredAtSpLevel()) {
      return res.status(404).send("SAML is not configured on this server.");
    }
    // node-saml expects the parsed body to include the SAMLResponse +
    // RelayState fields. Express + body-parser-urlencoded handles
    // this when the IdP POSTs application/x-www-form-urlencoded
    // (the default HTTP-POST binding).
    const result = await consumeSamlResponse(req).catch((e) => {
      throw new Error(`SAML response verification failed: ${e.message}`);
    });

    const user = await resolveSamlUser(result);

    if (user.status !== "active") {
      return res.status(403).send("Your account is disabled — contact an admin.");
    }

    await pool.query("UPDATE users SET last_login_at=NOW() WHERE id=$1", [user.id]);
    log.info("saml login ok", { userId: user.id, email: user.email, workspaceId: result.workspaceId });
    await auditLog({
      req, action: "auth.saml.login",
      actor:       { id: user.id, email: user.email, role: user.role },
      workspaceId: user.workspace_id,
      metadata:    { sub: result.sub, idpIssuer: result.cfg.idp_entity_id },
    });

    // Issue Daisy tokens. We set the refresh cookie and bounce back
    // to /login?saml=done so the LoginPage hook calls auth.tryRefresh
    // to materialise the access token in memory — exact same shape
    // as the OIDC callback.
    const refresh = await issueRefreshToken({
      userId:    user.id,
      userAgent: req.headers["user-agent"] || null,
      ip:        req.ip || null,
    });
    res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
    const next = result.next || "/";
    const search = new URLSearchParams({ saml: "done", next }).toString();
    res.redirect(`/login?${search}`);
  } catch (e) {
    const statusCode = e.statusCode || 400;
    res.status(statusCode).send(e.message || "SAML callback failed");
  }
});

router.get("/saml/metadata", async (req, res, next) => {
  try {
    if (!isSamlConfiguredAtSpLevel()) {
      return res.status(404).send("SAML is not configured on this server.");
    }
    const slug = String(req.query.workspace || "").trim();
    if (!slug) return res.status(400).send("workspace query param required");
    const wsId = await workspaceIdForSlug(slug);
    if (!wsId) return res.status(404).send(`workspace "${slug}" not found`);
    const xml = await spMetadata(wsId);
    res.type("application/samlmetadata+xml").send(xml);
  } catch (e) { next(e); }
});

export default router;
