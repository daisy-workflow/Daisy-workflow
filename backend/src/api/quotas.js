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
// Note: micros→dollars conversion lives on the frontend so the API
// stays integer-typed. Frontend divides cost_micros by 1_000_000.
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
// GET /quotas/usage/by-model — per-model breakdown for the active
// project. Drives the "where did our tokens go" UI block on the
// quotas page. Defaults to the current calendar month (matches the
// tokens_per_month quota's bucket); ?days=N overrides.
//
// Returns one row per (provider, model) with totals + dollar cost.
// ────────────────────────────────────────────────────────────────────
router.get("/usage/by-model",
  requirePermission("quota.read"),
  async (req, res, next) => {
    try {
      const days = Number(req.query.days);
      const since = Number.isFinite(days) && days > 0
        ? `NOW() - INTERVAL '${Math.min(days, 365) | 0} days'`
        : `date_trunc('month', NOW())`;
      // Inline interval guarded by `(days | 0)` above so SQL injection
      // can't slip through the template string — only ints in 0–365
      // reach the query.
      // ORDER BY uses the aggregate expressions directly rather than
      // the SELECT-list aliases. Postgres resolves bare identifiers
      // in ORDER BY to the underlying column first when one exists,
      // which means `input_tokens` / `cost_micros` here would refer
      // to the un-aggregated columns and trip the GROUP BY rule.
      // Repeating SUM(...) is the unambiguous form.
      const { rows } = await pool.query(
        `SELECT provider, model,
                COUNT(*)::int       AS calls,
                SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::int AS cache_hits,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens,
                SUM(cost_micros)::bigint   AS cost_micros,
                AVG(latency_ms) FILTER (WHERE NOT cache_hit) AS avg_latency_ms
           FROM agent_token_events
          WHERE project_id = $1
            AND created_at >= ${since}
          GROUP BY provider, model
          ORDER BY SUM(cost_micros) DESC,
                   SUM(input_tokens) + SUM(output_tokens) DESC`,
        [req.user.projectId],
      );
      res.json({
        sinceMode: Number.isFinite(days) && days > 0 ? `${days}d` : "month-to-date",
        rows,
      });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// GET /quotas/usage/by-agent — same shape, grouped by agent. Useful
// for "which agent is eating the budget" diagnostics.
// ────────────────────────────────────────────────────────────────────
router.get("/usage/by-agent",
  requirePermission("quota.read"),
  async (req, res, next) => {
    try {
      const days = Number(req.query.days);
      const since = Number.isFinite(days) && days > 0
        ? `NOW() - INTERVAL '${Math.min(days, 365) | 0} days'`
        : `date_trunc('month', NOW())`;
      const { rows } = await pool.query(
        `SELECT COALESCE(agent_title, '(deleted)') AS agent_title,
                COUNT(*)::int       AS calls,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens,
                SUM(cost_micros)::bigint   AS cost_micros
           FROM agent_token_events
          WHERE project_id = $1
            AND created_at >= ${since}
          GROUP BY COALESCE(agent_title, '(deleted)')
          ORDER BY SUM(cost_micros) DESC
          LIMIT 50`,
        [req.user.projectId],
      );
      res.json({ rows });
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
