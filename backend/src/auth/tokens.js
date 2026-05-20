// JWT access tokens + opaque rotated refresh tokens.
//
// Design:
//   • Access token = JWT (HS256, signed with JWT_SECRET).
//       - Lifetime: 15 minutes (configurable via ACCESS_TOKEN_TTL).
//       - Payload: { sub, email, role, ws, exp, iat } where ws is the
//         currently-active workspace_id.
//       - Stored client-side in memory only (not localStorage) to
//         minimise XSS exposure.
//
//   • Refresh token = 32-byte random base64url string.
//       - Lifetime: 30 days (REFRESH_TOKEN_TTL).
//       - Stored at rest as sha256(token) hex in refresh_tokens.
//       - Rotated on every use: each /auth/refresh issues a brand-new
//         token, marks the old one revoked + chains via rotated_to.
//       - Sent to the client as an httpOnly + Secure (in prod) cookie
//         path-scoped to /auth so it doesn't leak on every request.
//
// Why opaque refresh tokens instead of refresh JWTs:
//   • Trivial revocation: delete the row.
//   • No need for a separate denylist on logout.
//   • Hashing means a DB dump doesn't give an attacker live tokens.
//
// Theft-detection bonus:
//   When a refresh token is presented, if it's already been
//   `rotated_to` something else, that's a sign the original token was
//   stolen and used by a different actor. We revoke the entire chain.

import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

// TTLs are parsed by the jsonwebtoken library, which understands ms-style
// strings ("15m", "30d") natively. Keep these strings, not numbers.
const ACCESS_TTL  = process.env.ACCESS_TOKEN_TTL  || "15m";
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL || "30d";
const REFRESH_TTL_MS = parseDurationMs(REFRESH_TTL);

const JWT_ALG    = "HS256";
const JWT_ISSUER = "daisy-dag";

// ────────────────────────────────────────────────────────────────────
// Access token
// ────────────────────────────────────────────────────────────────────

/** Issue a fresh access JWT.
 *
 *  RBAC v2 adds `proj` — the currently-active project for this
 *  session. It's a UX hint (the UI remembers which project the user
 *  was last in). Server-side RBAC checks always re-resolve against
 *  the project carried on the request (path param, header, or body),
 *  NOT this claim — `proj` is purely a default for routes that
 *  didn't specify a project explicitly.
 */
export function signAccessToken({ userId, email, role, workspaceId, projectId = null }) {
  return jwt.sign(
    {
      sub:   userId,
      email: email,
      role:  role,
      ws:    workspaceId,
      proj:  projectId,
    },
    secret(),
    { algorithm: JWT_ALG, issuer: JWT_ISSUER, expiresIn: ACCESS_TTL },
  );
}

/** Verify a JWT. Throws on signature mismatch / expiry / wrong issuer.
 *  Returns the decoded payload on success. */
export function verifyAccessToken(token) {
  return jwt.verify(token, secret(), {
    algorithms: [JWT_ALG],
    issuer:     JWT_ISSUER,
  });
}

// ────────────────────────────────────────────────────────────────────
// Refresh tokens
// ────────────────────────────────────────────────────────────────────

/**
 * Issue a fresh refresh token, persist its hash, and return:
 *   { token, expiresAt }   — token is the plaintext to give the client
 *
 * `predecessorId` (optional) chains rotation: when the new token comes
 * from a /refresh call rather than /login, we point the old row at
 * the new one for forensic walking + theft detection.
 */
export async function issueRefreshToken({
  userId,
  userAgent = null,
  ip = null,
  predecessorId = null,
} = {}) {
  const token  = base64url(crypto.randomBytes(32));
  const hash   = sha256Hex(token);
  const id     = crypto.randomUUID();
  const expiry = new Date(Date.now() + REFRESH_TTL_MS);

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, hash, userAgent, ip, expiry],
  );

  if (predecessorId) {
    await pool.query(
      `UPDATE refresh_tokens
          SET revoked_at = NOW(),
              rotated_to = $1
        WHERE id = $2 AND revoked_at IS NULL`,
      [id, predecessorId],
    );
  }

  return { id, token, expiresAt: expiry };
}

/**
 * Look up a refresh token by its plaintext value (we hash and search).
 * Returns the active row, or null if absent / expired / revoked.
 *
 * If the token exists but has been *rotated* (used and replaced with a
 * new one), we treat the presentation as a theft-replay: revoke every
 * still-active token in the user's session chain and return null.
 */
export async function consumeRefreshToken(plaintext) {
  if (!plaintext) return null;
  const hash = sha256Hex(plaintext);
  const { rows } = await pool.query(
    `SELECT id, user_id, expires_at, revoked_at, rotated_to
       FROM refresh_tokens
      WHERE token_hash = $1
      LIMIT 1`,
    [hash],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  // Theft-replay: this row was already rotated, attacker is using
  // an old copy. Burn the whole user's refresh-token surface.
  if (row.rotated_to) {
    await pool.query(
      `UPDATE refresh_tokens
          SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [row.user_id],
    );
    return null;
  }

  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  return { id: row.id, userId: row.user_id };
}

/** Revoke a single refresh token (e.g. on /auth/logout). */
export async function revokeRefreshToken(plaintext) {
  if (!plaintext) return false;
  const hash = sha256Hex(plaintext);
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  return rowCount > 0;
}

/** Revoke every active refresh token for a user (admin disable, "log
 *  out everywhere", etc). */
export async function revokeAllForUser(userId) {
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rowCount;
}

// ────────────────────────────────────────────────────────────────────
// Cookie shape (used by /auth endpoints).
// ────────────────────────────────────────────────────────────────────

export const REFRESH_COOKIE = "daisy_rt";

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure:   config.env === "production",
    // Path is "/" so the cookie is attached regardless of whether
    // the frontend talks to the backend directly (path-prefix /auth)
    // or via the dev Vite proxy (which mounts the API under /api,
    // so the browser URL is /api/auth/refresh — that path does NOT
    // start with /auth and a "/auth"-scoped cookie wouldn't be
    // sent). HttpOnly + SameSite=Lax keep the broader path scope
    // safe; only POST /auth/refresh and /auth/logout actually read
    // the cookie server-side.
    path:     "/",
    maxAge:   REFRESH_TTL_MS,
  };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function secret() {
  const s = config.jwtSecret;
  if (!s || s === "change-me") {
    // Don't crash dev if the user hasn't customised .env, but loudly
    // refuse to issue tokens with the placeholder secret in prod.
    if (config.env === "production") {
      throw new Error("JWT_SECRET must be set to a strong random value in production");
    }
  }
  return s || "dev-fallback-jwt-secret";
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function parseDurationMs(s) {
  const m = String(s).trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) throw new Error(`unparseable duration: ${s}`);
  const n = parseInt(m[1], 10);
  switch (m[2] || "ms") {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    case "d":  return n * 24 * 60 * 60 * 1000;
  }
  return n;
}
