// Model routes REST API.
//
// Endpoints (project-scoped):
//   GET    /model-routes              — list
//   POST   /model-routes              — create
//   GET    /model-routes/:id          — fetch one
//   PUT    /model-routes/:id          — update (strategy + config)
//   DELETE /model-routes/:id          — delete
//
// Permissions:
//   route.read    — list / get (editors + viewers)
//   route.write   — create / update / delete (editors + admins)

import { Router } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

const STRATEGIES = new Set(["static", "tier", "fallback"]);

// ─────────────────────────────────────────────────────────
router.get("/",
  requirePermission("route.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, description, strategy, config, created_at, updated_at
           FROM model_routes
          WHERE workspace_id = $1 AND project_id = $2
          ORDER BY title`,
        [req.user.workspaceId, req.user.projectId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post("/",
  requirePermission("route.write"),
  async (req, res, next) => {
    try {
      const { title, description, strategy, config } = req.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        throw new ValidationError("title is required");
      }
      if (!STRATEGIES.has(strategy)) {
        throw new ValidationError(`strategy must be one of: ${[...STRATEGIES].join(", ")}`);
      }
      const cfg = validateConfig(strategy, config);
      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO model_routes
             (id, workspace_id, project_id, title, description, strategy, config, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [id, req.user.workspaceId, req.user.projectId,
           title.trim(), description || null, strategy,
           JSON.stringify(cfg), req.user.id || null],
        );
      } catch (e) {
        if (e.code === "23505") throw new ValidationError(`a route titled "${title}" already exists`);
        throw e;
      }
      await auditLog({
        req, action: "route.create",
        resource: { type: "model_route", id, name: title.trim() },
        projectId: req.user.projectId,
        metadata: { strategy },
      });
      res.status(201).json({ id });
    } catch (e) { next(e); }
  },
);

router.get("/:id",
  requirePermission("route.read"),
  async (req, res, next) => {
    try {
      const row = await loadAndAuth(req);
      res.json(row);
    } catch (e) { next(e); }
  },
);

router.put("/:id",
  requirePermission("route.write"),
  async (req, res, next) => {
    try {
      const existing = await loadAndAuth(req);
      const { title, description, strategy, config } = req.body || {};

      const updates = [], params = [req.params.id, req.user.workspaceId, req.user.projectId];
      if (title !== undefined) {
        if (!String(title).trim()) throw new ValidationError("title cannot be blank");
        params.push(String(title).trim()); updates.push(`title = $${params.length}`);
      }
      if (description !== undefined) {
        params.push(description || null); updates.push(`description = $${params.length}`);
      }
      // Strategy + config travel together — changing strategy without
      // updating config almost always means a bad row, so we require
      // both when either is sent.
      if (strategy !== undefined || config !== undefined) {
        const newStrategy = strategy || existing.strategy;
        if (!STRATEGIES.has(newStrategy)) {
          throw new ValidationError(`strategy must be one of: ${[...STRATEGIES].join(", ")}`);
        }
        const cfg = validateConfig(newStrategy, config ?? existing.config);
        params.push(newStrategy); updates.push(`strategy = $${params.length}`);
        params.push(JSON.stringify(cfg)); updates.push(`config = $${params.length}::jsonb`);
      }
      if (!updates.length) return res.json({ ok: true });
      updates.push("updated_at = NOW()");
      const r = await pool.query(
        `UPDATE model_routes SET ${updates.join(", ")}
          WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        params,
      );
      if (!r.rowCount) throw new NotFoundError("model route");
      await auditLog({
        req, action: "route.update",
        resource: { type: "model_route", id: req.params.id },
        projectId: req.user.projectId,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

router.delete("/:id",
  requirePermission("route.write"),
  async (req, res, next) => {
    try {
      await loadAndAuth(req);
      await pool.query(
        `DELETE FROM model_routes WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        [req.params.id, req.user.workspaceId, req.user.projectId],
      );
      await auditLog({
        req, action: "route.delete",
        resource: { type: "model_route", id: req.params.id },
        projectId: req.user.projectId,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─── helpers ─────────────────────────────────────────────

async function loadAndAuth(req) {
  const { rows } = await pool.query(
    `SELECT id, title, description, strategy, config, created_at, updated_at
       FROM model_routes
      WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
    [req.params.id, req.user.workspaceId, req.user.projectId],
  );
  if (!rows[0]) throw new NotFoundError("model route");
  return rows[0];
}

/**
 * Per-strategy config validation. We only enforce the structure the
 * dispatcher relies on — agent titles aren't checked for existence
 * here because routes are created before the agents they reference
 * might be (and the dispatcher gives a clear error at call time).
 */
function validateConfig(strategy, config) {
  const cfg = config && typeof config === "object" ? config : {};
  if (strategy === "static") {
    if (!cfg.agent || typeof cfg.agent !== "string") {
      throw new ValidationError("static strategy requires config.agent (string)");
    }
    return { agent: cfg.agent };
  }
  if (strategy === "tier") {
    if (!cfg.tiers || typeof cfg.tiers !== "object") {
      throw new ValidationError("tier strategy requires config.tiers (object)");
    }
    // Each tier value must be a string (agent title). Empty tiers
    // are rejected because the dispatcher would fail at call time
    // with a less helpful error.
    const tiers = {};
    for (const [k, v] of Object.entries(cfg.tiers)) {
      if (!v || typeof v !== "string") {
        throw new ValidationError(`tier "${k}" must be an agent title (string)`);
      }
      tiers[k] = v;
    }
    if (!Object.keys(tiers).length) {
      throw new ValidationError("tier strategy requires at least one tier");
    }
    return { tiers, default: cfg.default || Object.keys(tiers)[0] };
  }
  if (strategy === "fallback") {
    const chain = Array.isArray(cfg.chain) ? cfg.chain.filter(s => typeof s === "string" && s) : [];
    if (!chain.length) throw new ValidationError("fallback strategy requires a non-empty config.chain");
    return { chain };
  }
  return cfg;
}

export default router;
