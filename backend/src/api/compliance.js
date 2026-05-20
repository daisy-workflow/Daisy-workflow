// Compliance REST API.
//
//   GET    /compliance                       — current mode, residency, enforcement summary
//   PUT    /compliance                       — set mode + residency (workspace admin only)
//   GET    /compliance/modes                 — catalog of available modes + their rules
//
//   Data-subject endpoints (gated by mode.endpoints.export / erasure):
//   GET    /compliance/users/:id/export      — GDPR Article 20
//   DELETE /compliance/users/:id             — GDPR Article 17
//   GET    /compliance/erasure-log           — paper trail of erasures
//
// All endpoints require workspace-admin (the data subject's rights
// shouldn't be exercised by anyone less privileged than that).

import { Router } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import { requireUser } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

import { MODES, listModes, listRegions, getMode } from "../compliance/policies.js";
import { evictComplianceCache, loadWorkspaceCompliance } from "../compliance/enforce.js";

const router = Router();
router.use(requireUser);

const VALID_MODES   = new Set(Object.keys(MODES));
const VALID_REGIONS = new Set(["global", "us", "eu", "apac"]);

// ─────────────────────────────────────────────────────────────
// Catalog — drives the UI dropdowns. Public to any authenticated
// user so non-admins can see what enforcement means.
// ─────────────────────────────────────────────────────────────
router.get("/modes", (_req, res) => {
  res.json({ modes: listModes(), regions: listRegions() });
});

// ─────────────────────────────────────────────────────────────
// GET /compliance — current settings + the rules they imply.
// ─────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("compliance.read"),
  async (req, res, next) => {
    try {
      const ws = await loadWorkspaceCompliance(req.user.workspaceId);
      const mode = getMode(ws.mode);
      res.json({
        mode:      ws.mode,
        residency: ws.residency,
        settings:  ws.settings,
        enforced: {
          allowedProviders:   mode.allowedProviders,
          requiredGuardrails: mode.requiredGuardrails,
          auditRetentionDays: mode.auditRetentionDays,
          features:           mode.features,
          endpoints:          mode.endpoints,
        },
      });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// PUT /compliance — workspace admin sets mode + residency. We do
// NOT silently rewrite existing configs to comply — the operator
// sees a "non-compliant" list on the page and edits them by hand.
// (Auto-rewriting a credential row would be a footgun.)
// ─────────────────────────────────────────────────────────────
router.put("/",
  requirePermission("compliance.write"),
  async (req, res, next) => {
    try {
      const { mode, residency, settings } = req.body || {};
      if (mode && !VALID_MODES.has(mode)) {
        throw new ValidationError(`mode must be one of: ${[...VALID_MODES].join(", ")}`);
      }
      if (residency && !VALID_REGIONS.has(residency)) {
        throw new ValidationError(`residency must be one of: ${[...VALID_REGIONS].join(", ")}`);
      }
      const updates = [], params = [req.user.workspaceId];
      if (mode      !== undefined) { params.push(mode);                  updates.push(`compliance_mode = $${params.length}`); }
      if (residency !== undefined) { params.push(residency);             updates.push(`data_residency = $${params.length}`); }
      if (settings  !== undefined) {
        if (settings && typeof settings !== "object") {
          throw new ValidationError("settings must be an object");
        }
        params.push(JSON.stringify(settings || {}));
        updates.push(`compliance_settings = $${params.length}::jsonb`);
      }
      if (!updates.length) return res.json({ ok: true });
      const r = await pool.query(
        `UPDATE workspaces SET ${updates.join(", ")}, updated_at = NOW()
          WHERE id = $1`,
        params,
      );
      if (!r.rowCount) throw new NotFoundError("workspace");
      evictComplianceCache(req.user.workspaceId);

      await auditLog({
        req, action: "compliance.update",
        resource: { type: "workspace", id: req.user.workspaceId },
        metadata: { mode, residency },
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// GET /compliance/users/:id/export — GDPR Article 20.
//
// Bundle the user's personal data into a JSON archive. Returns:
//   {
//     user:        { id, email, display_name, role, created_at, … },
//     audit:       [ ... entries the user is the actor on ... ],
//     executions:  [ ... runs they triggered ... ],
//     memories:    [ ... conversation history rows scoped to user ... ]
//   }
//
// Excludes shared business artefacts (workflows, configs, agents) —
// those are workspace property, not personal data.
// ─────────────────────────────────────────────────────────────
router.get("/users/:id/export",
  requirePermission("compliance.dataSubject"),
  async (req, res, next) => {
    try {
      const ws = await loadWorkspaceCompliance(req.user.workspaceId);
      if (!getMode(ws.mode).endpoints?.export) {
        throw new ForbiddenError(
          `Data export is not enabled under "${ws.mode}". Enable it by ` +
          `setting compliance mode to GDPR (or extend policies.js).`,
        );
      }
      const userId = req.params.id;
      const userRow = await loadUser(req.user.workspaceId, userId);
      if (!userRow) throw new NotFoundError("user");

      const [auditRows, execRows, memoryRows] = await Promise.all([
        pool.query(
          `SELECT id, action, actor_id, actor_kind, actor_email, resource_type, resource_id,
                  project_id, metadata, ip, user_agent, created_at
             FROM audit_log
            WHERE workspace_id = $1 AND actor_id = $2
            ORDER BY created_at`,
          [req.user.workspaceId, userId],
        ).then(r => r.rows).catch(() => []),
        pool.query(
          `SELECT id, graph_id, status, started_at, finished_at, tags
             FROM executions
            WHERE workspace_id = $1 AND created_by = $2
            ORDER BY started_at`,
          [req.user.workspaceId, userId],
        ).then(r => r.rows).catch(() => []),
        pool.query(
          `SELECT id, namespace, key, content, conversation_id, role, created_at
             FROM memories
            WHERE workspace_id = $1 AND created_by = $2
            ORDER BY created_at`,
          [req.user.workspaceId, userId],
        ).then(r => r.rows).catch(() => []),
      ]);

      await auditLog({
        req, action: "compliance.export",
        resource: { type: "user", id: userId },
        metadata: {
          counts: {
            audit:       auditRows.length,
            executions:  execRows.length,
            memories:    memoryRows.length,
          },
        },
      });

      res.setHeader("content-disposition",
        `attachment; filename="user-${userId}-export.json"`);
      res.json({
        exportedAt: new Date().toISOString(),
        user: userRow,
        audit:      auditRows,
        executions: execRows,
        memories:   memoryRows,
      });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// DELETE /compliance/users/:id — GDPR Article 17.
//
// We do NOT hard-delete the user row because audit_log entries FK
// back to it on legal-hold grounds. Instead we:
//
//   1. Anonymise the user row (email, display_name, oidc_subject,
//      saml_subject all → null / "[erased]").
//   2. Hard-delete memories (free-form content authored by the user).
//   3. Anonymise actor_email columns on audit_log where actor_id
//      matches.
//   4. Insert a compliance_erasure_log row with per-resource counts.
//
// The audit row itself stays so the workspace's compliance auditor
// can prove the deletion happened.
// ─────────────────────────────────────────────────────────────
router.delete("/users/:id",
  requirePermission("compliance.dataSubject"),
  async (req, res, next) => {
    try {
      const ws = await loadWorkspaceCompliance(req.user.workspaceId);
      if (!getMode(ws.mode).endpoints?.erasure) {
        throw new ForbiddenError(
          `Right-to-erasure is not enabled under "${ws.mode}". Enable it ` +
          `by setting compliance mode to GDPR.`,
        );
      }
      const userId = req.params.id;
      const userRow = await loadUser(req.user.workspaceId, userId);
      if (!userRow) throw new NotFoundError("user");
      const originalEmail = userRow.email;

      // Refuse to erase yourself — too easy to lock yourself out of
      // the workspace. Operators can use another admin's account.
      if (userId === req.user.id) {
        throw new ValidationError("you cannot erase your own account; ask another admin");
      }

      // Transaction so a partial wipe doesn't leave the user
      // half-anonymised.
      const client = await pool.connect();
      const counts = { memories: 0, audit_anon: 0 };
      try {
        await client.query("BEGIN");

        // 1. Anonymise the user row. Marker email so admins can spot
        //    erased rows in the user list without reading the
        //    compliance_erasure_log.
        await client.query(
          `UPDATE users
              SET email         = $2,
                  display_name  = '[erased]',
                  oidc_subject  = NULL,
                  saml_subject  = NULL,
                  password_hash = NULL,
                  status        = 'erased',
                  updated_at    = NOW()
            WHERE id = $1`,
          [userId, `erased+${userId}@example.invalid`],
        );

        // 2. Delete memories. content can carry PII verbatim — wipe.
        const m = await client.query(
          `DELETE FROM memories
            WHERE workspace_id = $1 AND created_by = $2`,
          [req.user.workspaceId, userId],
        );
        counts.memories = m.rowCount;

        // 3. Anonymise audit log actor_email but keep actor_id so
        //    the audit chain stays intact.
        const a = await client.query(
          `UPDATE audit_log
              SET actor_email = '[erased]'
            WHERE workspace_id = $1 AND actor_id = $2 AND actor_email IS NOT NULL`,
          [req.user.workspaceId, userId],
        );
        counts.audit_anon = a.rowCount;

        // 4. Log the erasure event itself.
        await client.query(
          `INSERT INTO compliance_erasure_log
             (id, workspace_id, user_id, user_email_at_erasure,
              requested_by, reason, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            randomUUID(),
            req.user.workspaceId,
            userId,
            originalEmail,
            req.user.id || null,
            req.body?.reason || null,
            JSON.stringify(counts),
          ],
        );

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      // External audit_log row too — separate from the inner
      // compliance_erasure_log so the regular audit feed surfaces it.
      await auditLog({
        req, action: "compliance.erasure",
        resource: { type: "user", id: userId },
        metadata: counts,
      });

      res.json({ ok: true, counts });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// GET /compliance/erasure-log — paper trail for the auditor.
// ─────────────────────────────────────────────────────────────
router.get("/erasure-log",
  requirePermission("compliance.read"),
  async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const { rows } = await pool.query(
        `SELECT id, user_id, user_email_at_erasure, requested_by, reason,
                details, created_at
           FROM compliance_erasure_log
          WHERE workspace_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [req.user.workspaceId, limit],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

// ─── helpers ────────────────────────────────────────────────────

async function loadUser(workspaceId, userId) {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, status, oidc_subject, saml_subject,
            created_at, updated_at
       FROM users
      WHERE id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  return rows[0] || null;
}

export default router;
