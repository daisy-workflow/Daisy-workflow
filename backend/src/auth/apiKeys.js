// API-key generation + lookup for service accounts.
//
// Token format:   `dks_<32-base64url-bytes>`
//                  ┬──  ────────────────────
//                  │    256 bits of entropy (crypto.randomBytes(32))
//                  └─── product+kind prefix ("daisy-key, service")
//                       — makes a leaked key recognisable in logs and
//                       lets the auth middleware short-circuit on a
//                       prefix check before doing any DB work.
//
// Storage:   We persist only sha256(token) hex. The plaintext is shown
//            ONCE to the caller at creation time; the server never sees
//            it again. There is no recover-or-reset path — the customer
//            issues a new key and revokes the old one.
//
// Lookup:    Hot path is `findActiveByToken(token)` — middleware calls
//            this on every request that presents a dks_ bearer. It's a
//            single PK-indexed read against api_keys.key_hash.
//
// Expiry:    `expires_at` is optional. NULL means "no expiry"; non-NULL
//            keys get the same revoked-row treatment past their date.
//
// Last-used: We update last_used_at + last_used_ip best-effort after a
//            successful auth. Done in a microtask so we don't slow the
//            request path waiting on the write to land.

import crypto from "node:crypto";
import { pool } from "../db/pool.js";

const KEY_PREFIX        = "dks_";
const KEY_RANDOM_BYTES  = 32;          // 256 bits — well above the OWASP recommendation
const DISPLAY_PREFIX_LEN = 8;          // first chars after `dks_`, shown in the UI to identify the key

/**
 * Generate a brand-new API key.
 *
 * Returns:
 *   {
 *     token,    plaintext  — shown to the caller ONCE
 *     prefix,   "dks_abc12345"  — what the UI displays
 *     hash,     sha256 hex  — what we persist
 *   }
 */
export function generateKey() {
  const random = crypto.randomBytes(KEY_RANDOM_BYTES).toString("base64url");
  const token  = `${KEY_PREFIX}${random}`;
  return {
    token,
    prefix: token.slice(0, KEY_PREFIX.length + DISPLAY_PREFIX_LEN),
    hash:   sha256Hex(token),
  };
}

/** Cheap detection used by middleware. */
export function isApiKeyToken(token) {
  return typeof token === "string" && token.startsWith(KEY_PREFIX);
}

/**
 * Hot path: resolve a presented token through api_keys → service_account
 * → project. Returns null for any failure (revoked, expired, missing,
 * service account disabled, project deleted) — caller treats that as 401.
 *
 * The query joins all four tables in one round trip to keep the auth
 * path under the 1-2ms budget we set elsewhere. If this becomes a
 * bottleneck, the natural next step is a small in-process cache keyed
 * on key_hash with a short TTL — the lookup is read-mostly.
 */
export async function findActiveByToken(token) {
  if (!isApiKeyToken(token)) return null;
  const hash = sha256Hex(token);
  const { rows } = await pool.query(
    `SELECT
        k.id                AS key_id,
        k.expires_at        AS key_expires_at,
        k.revoked_at        AS key_revoked_at,
        sa.id               AS service_account_id,
        sa.name             AS service_account_name,
        sa.role             AS service_account_role,
        sa.status           AS service_account_status,
        sa.deleted_at       AS service_account_deleted_at,
        p.id                AS project_id,
        p.workspace_id      AS workspace_id,
        p.deleted_at        AS project_deleted_at
     FROM api_keys k
     JOIN service_accounts sa ON sa.id = k.service_account_id
     JOIN projects p          ON p.id  = sa.project_id
    WHERE k.key_hash = $1
    LIMIT 1`,
    [hash],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  // Validation chain — fail soft, return null so the caller treats
  // anything in this bundle as "invalid token" without leaking which
  // part was wrong.
  if (r.key_revoked_at)               return null;
  if (r.key_expires_at && new Date(r.key_expires_at) < new Date()) return null;
  if (r.service_account_status !== "active") return null;
  if (r.service_account_deleted_at)   return null;
  if (r.project_deleted_at)           return null;

  return {
    keyId:              r.key_id,
    serviceAccountId:   r.service_account_id,
    serviceAccountName: r.service_account_name,
    role:               r.service_account_role,
    projectId:          r.project_id,
    workspaceId:        r.workspace_id,
  };
}

/**
 * Best-effort last-used update. Fired-and-forgotten so request latency
 * isn't bound to the write — a slow update doesn't slow auth.
 */
export function markUsed(keyId, ip) {
  queueMicrotask(async () => {
    try {
      await pool.query(
        `UPDATE api_keys
            SET last_used_at = NOW(),
                last_used_ip = $2
          WHERE id = $1`,
        [keyId, ip || null],
      );
    } catch { /* swallow — telemetry-grade write */ }
  });
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
