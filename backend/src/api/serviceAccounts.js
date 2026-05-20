// Service accounts API — machine identities scoped to a project.
//
// Auth model:
//   • A service account is a project-scoped entity. It carries one
//     built-in role (admin / editor / viewer) which gates what its
//     keys can do *within* the project. SAs cannot cross projects.
//   • Only project admins (or workspace admins, who inherit) can
//     CRUD service accounts. service_account.create / read / delete
//     are all in the project-admin permission set.
//   • All endpoints require an active project (the SA lives there).
//
// Endpoints:
//   GET    /service-accounts                          list active-project SAs
//   POST   /service-accounts                          create
//   GET    /service-accounts/:id                      one
//   PUT    /service-accounts/:id                      rename / role / status
//   DELETE /service-accounts/:id                      soft delete (deleted_at)
//
//   POST   /service-accounts/:id/keys                 issue a new API key
//                                                     (returned ONCE)
//   GET    /service-accounts/:id/keys                 list keys (prefix only)
//   POST   /service-accounts/:id/keys/:keyId/revoke   revoke a key

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  ValidationError, NotFoundError, ForbiddenError, ConflictError,
} from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { generateKey } from "../auth/apiKeys.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

// Names match the IDENT shape used elsewhere — alphanumeric + - _ . — so
// SA names can be referenced from logs, audits, and config payloads
// without escaping. Bounded to 64 chars for display sanity.
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// ────────────────────────────────────────────────────────────────────
// List + get
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("service_account.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT sa.id, sa.name, sa.description, sa.role, sa.status,
                sa.created_at, sa.updated_at,
                COALESCE(u.display_name, u.email) AS created_by_email,
                (SELECT COUNT(*) FROM api_keys k
                   WHERE k.service_account_id = sa.id
                     AND k.revoked_at IS NULL)::int AS active_key_count,
                (SELECT MAX(k.last_used_at) FROM api_keys k
                   WHERE k.service_account_id = sa.id)         AS last_used_at
           FROM service_accounts sa
           LEFT JOIN users u ON u.id = sa.created_by
          WHERE sa.project_id = $1
            AND sa.deleted_at IS NULL
          ORDER BY sa.name`,
        [req.user.projectId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.get("/:id",
  requirePermission("service_account.read"),
  async (req, res, next) => {
    try {
      const sa = await loadSa(req.params.id, req.user.projectId);
      res.json(sa);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────────
router.post("/",
  requirePermission("service_account.create"),
  async (req, res, next) => {
    try {
      const { name, description, role = "editor" } = req.body || {};
      if (!name || !NAME_RE.test(name)) {
        throw new ValidationError("name is required (alphanumeric + ._-, up to 64 chars)");
      }
      if (!["admin", "editor", "viewer"].includes(role)) {
        throw new ValidationError("role must be admin, editor, or viewer");
      }
      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO service_accounts
             (id, project_id, name, description, role, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, req.user.projectId, name, description || null, role, req.user.id],
        );
      } catch (e) {
        if (e.code === "23505") {
          throw new ConflictError(`a service account named "${name}" already exists in this project`);
        }
        throw e;
      }
      await auditLog({
        req, action: "service_account.create",
        resource: { type: "service_account", id, name },
        projectId: req.user.projectId,
        metadata: { role },
      });
      res.status(201).json({ id, name, role });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// Update (name / description / role / status)
//
// Status flips an SA between 'active' and 'disabled' — disabling
// invalidates every key without revoking them, so re-enabling restores
// them. Revoking a key is the permanent action; disabling the SA is
// the recoverable one.
// ────────────────────────────────────────────────────────────────────
router.put("/:id",
  requirePermission("service_account.create"),     // same gate as create — both project-admin
  async (req, res, next) => {
    try {
      const sa = await loadSa(req.params.id, req.user.projectId);
      const { name, description, role, status } = req.body || {};

      const sets = []; const params = [];
      if (name !== undefined) {
        if (!NAME_RE.test(name)) throw new ValidationError("invalid name");
        params.push(name); sets.push(`name = $${params.length}`);
      }
      if (description !== undefined) {
        params.push(description || null); sets.push(`description = $${params.length}`);
      }
      if (role !== undefined) {
        if (!["admin", "editor", "viewer"].includes(role)) {
          throw new ValidationError("role must be admin, editor, or viewer");
        }
        params.push(role); sets.push(`role = $${params.length}`);
      }
      if (status !== undefined) {
        if (!["active", "disabled"].includes(status)) {
          throw new ValidationError("status must be active or disabled");
        }
        params.push(status); sets.push(`status = $${params.length}`);
      }
      if (sets.length === 0) return res.json({ id: req.params.id, updated: false });

      sets.push("updated_at = NOW()");
      params.push(req.params.id);
      const idIdx = params.length;
      params.push(req.user.projectId);
      const projIdx = params.length;

      try {
        await pool.query(
          `UPDATE service_accounts SET ${sets.join(", ")}
            WHERE id = $${idIdx} AND project_id = $${projIdx} AND deleted_at IS NULL`,
          params,
        );
      } catch (e) {
        if (e.code === "23505") throw new ConflictError(`a service account named "${name}" already exists`);
        throw e;
      }
      await auditLog({
        req, action: "service_account.update",
        resource: { type: "service_account", id: req.params.id, name: name || sa.name },
        projectId: req.user.projectId,
        metadata: {
          changes: { name, description, role, status },
        },
      });
      res.json({ id: req.params.id, updated: true });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// Delete (soft)
//
// Sets deleted_at + flips status to 'disabled' so every active key
// returned by middleware lookups starts failing immediately. The
// retention runner can hard-purge later; we leave the row in place
// so audit trail for past SA actions still resolves.
// ────────────────────────────────────────────────────────────────────
router.delete("/:id",
  requirePermission("service_account.delete"),
  async (req, res, next) => {
    try {
      const sa = await loadSa(req.params.id, req.user.projectId);
      await pool.query(
        `UPDATE service_accounts
            SET deleted_at = NOW(),
                status     = 'disabled',
                updated_at = NOW()
          WHERE id = $1 AND project_id = $2`,
        [req.params.id, req.user.projectId],
      );
      await auditLog({
        req, action: "service_account.delete",
        resource: { type: "service_account", id: req.params.id, name: sa.name },
        projectId: req.user.projectId,
      });
      res.json({ id: req.params.id, deleted: true });
    } catch (e) { next(e); }
  },
);

// ════════════════════════════════════════════════════════════════════
// API keys
// ════════════════════════════════════════════════════════════════════

// POST /service-accounts/:id/keys — issue a new key.
//
// The plaintext token is returned ONCE in the response. We never see
// it again on the server side — only sha256(token) hex is persisted.
// The UI must surface this clearly: "copy now, we can't show it again."
router.post("/:id/keys",
  requirePermission("service_account.create"),
  async (req, res, next) => {
    try {
      const sa = await loadSa(req.params.id, req.user.projectId);
      if (sa.status !== "active") {
        throw new ValidationError("can't issue a key for a disabled service account");
      }
      const { description, expiresAt } = req.body || {};
      let expiresAtTs = null;
      if (expiresAt) {
        const d = new Date(expiresAt);
        if (Number.isNaN(d.getTime())) {
          throw new ValidationError("expiresAt must be an ISO-8601 timestamp");
        }
        if (d.getTime() <= Date.now()) {
          throw new ValidationError("expiresAt must be in the future");
        }
        expiresAtTs = d;
      }
      const { token, prefix, hash } = generateKey();
      const keyId = randomUUID();
      await pool.query(
        `INSERT INTO api_keys
           (id, service_account_id, key_hash, prefix, description, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [keyId, sa.id, hash, prefix, description || null, expiresAtTs, req.user.id],
      );
      await auditLog({
        req, action: "service_account.key.issue",
        resource: { type: "service_account", id: sa.id, name: sa.name },
        projectId: req.user.projectId,
        metadata: { keyId, prefix, expiresAt: expiresAtTs?.toISOString() || null },
      });
      // SHOW-ONCE RESPONSE. The token field never appears in any
      // subsequent GET — once the dialog is dismissed, it's gone.
      res.status(201).json({
        id: keyId,
        token,                              // plaintext, ONE TIME ONLY
        prefix,
        expiresAt: expiresAtTs?.toISOString() || null,
      });
    } catch (e) { next(e); }
  },
);

router.get("/:id/keys",
  requirePermission("service_account.read"),
  async (req, res, next) => {
    try {
      await loadSa(req.params.id, req.user.projectId);
      const { rows } = await pool.query(
        `SELECT id, prefix, description, expires_at, last_used_at,
                last_used_ip, revoked_at, created_at
           FROM api_keys
          WHERE service_account_id = $1
          ORDER BY created_at DESC`,
        [req.params.id],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post("/:id/keys/:keyId/revoke",
  requirePermission("service_account.delete"),
  async (req, res, next) => {
    try {
      const sa = await loadSa(req.params.id, req.user.projectId);
      const { rowCount } = await pool.query(
        `UPDATE api_keys SET revoked_at = NOW()
          WHERE id = $1 AND service_account_id = $2 AND revoked_at IS NULL`,
        [req.params.keyId, sa.id],
      );
      if (rowCount === 0) {
        throw new NotFoundError("api key (or already revoked)");
      }
      await auditLog({
        req, action: "service_account.key.revoke",
        resource: { type: "service_account", id: sa.id, name: sa.name },
        projectId: req.user.projectId,
        metadata: { keyId: req.params.keyId },
      });
      res.json({ id: req.params.keyId, revoked: true });
    } catch (e) { next(e); }
  },
);

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

async function loadSa(id, projectId) {
  const { rows } = await pool.query(
    `SELECT id, project_id, name, description, role, status,
            created_at, updated_at, deleted_at
       FROM service_accounts
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [id, projectId],
  );
  if (rows.length === 0) throw new NotFoundError("service account");
  return rows[0];
}

export default router;
