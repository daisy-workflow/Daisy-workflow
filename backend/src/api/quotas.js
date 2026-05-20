// Project quotas API.
//
// Endpoints:
//   GET    /quotas                  → list snapshots for the active
//                                     project (limit + current usage,
//                                     one row per known kind).
//   PUT    /quotas/:kind            → set / change the limit for one
//                                     kind. Workspace admin only
//                                     (`quota.write`).
//   DELETE /quotas/:kind            → remove the quota (= unlimited).
//                                     Does NOT touch usage rows —
//                                     historical metering is kept.
//
// The list endpoint is gated on `quota.read` which the built-in
// project-admin role holds; setting / unsetting requires `quota.write`
// which only workspace admins have.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { ValidationError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { listSnapshots, KNOWN_KINDS } from "../auth/quotas.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

// ────────────────────────────────────────────────────────────────────
// GET /quotas — snapshots for the active project.
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("quota.read"),
  async (req, res, next) => {
    try {
      const snapshots = await listSnapshots(req.user.projectId);
      res.json(snapshots);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// PUT /quotas/:kind — upsert. Body: { limit }. Period is implied by
// the kind (see auth/quotas.js).
// ────────────────────────────────────────────────────────────────────
router.put("/:kind",
  requirePermission("quota.write"),
  async (req, res, next) => {
    try {
      const { kind } = req.params;
      if (!KNOWN_KINDS.includes(kind)) {
        throw new ValidationError(`unknown quota kind: ${kind}`);
      }
      const rawLimit = req.body?.limit;
      const limit = Number(rawLimit);
      if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
        throw new ValidationError("body.limit must be a non-negative integer");
      }

      // Period derives from kind in code so the column always matches
      // the kind's natural bucket. Operators can't accidentally set
      // monthly tokens with a daily period and then wonder why usage
      // resets every 24h.
      const period =
        kind === "tokens_per_month"   ? "month"
      : kind === "executions_per_day" ? "day"
      : /* storage_bytes */            "none";

      await pool.query(
        `INSERT INTO project_quotas (project_id, kind, limit_value, period)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, kind) DO UPDATE
            SET limit_value = EXCLUDED.limit_value,
                period      = EXCLUDED.period,
                updated_at  = NOW()`,
        [req.user.projectId, kind, limit, period],
      );
      await auditLog({
        req, action: "quota.set",
        resource: { type: "project", id: req.user.projectId },
        projectId: req.user.projectId,
        metadata: { kind, limit, period },
      });
      res.json({ kind, limit, period });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// DELETE /quotas/:kind — remove the limit (back to unlimited). Usage
// rows are retained for historical metering; only the cap goes.
// ────────────────────────────────────────────────────────────────────
router.delete("/:kind",
  requirePermission("quota.write"),
  async (req, res, next) => {
    try {
      const { kind } = req.params;
      if (!KNOWN_KINDS.includes(kind)) {
        throw new ValidationError(`unknown quota kind: ${kind}`);
      }
      await pool.query(
        `DELETE FROM project_quotas WHERE project_id = $1 AND kind = $2`,
        [req.user.projectId, kind],
      );
      await auditLog({
        req, action: "quota.unset",
        resource: { type: "project", id: req.user.projectId },
        projectId: req.user.projectId,
        metadata: { kind },
      });
      res.json({ kind, removed: true });
    } catch (e) { next(e); }
  },
);

export default router;
