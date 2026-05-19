// Triggers API.
//
// Auth model:
//   • Reads (list/get/types)         — admin, editor, viewer.
//   • Writes (create/update/delete)  — admin, editor.
//   • Workspace scoping              — every query filters by
//                                      req.user.workspaceId; new
//                                      triggers inherit the caller's
//                                      workspace AND the target
//                                      graph's workspace must match
//                                      (caught by the FK + the
//                                      explicit lookup below).

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { triggerRegistry } from "../triggers/registry.js";
import { syncTrigger, activeCount, fireTriggerById } from "../triggers/manager.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);

router.get("/types", requireRole("admin", "editor", "viewer"), (_req, res) => {
  res.json({ active: activeCount(), types: triggerRegistry.list() });
});

router.get("/", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const params = [req.user.workspaceId];
    const where = ["t.workspace_id = $1"];
    if (req.query.graphId) { params.push(req.query.graphId); where.push(`t.graph_id=$${params.length}`); }
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.graph_id, t.type, t.config, t.enabled,
              t.last_fired_at, t.last_error, t.fire_count,
              t.created_at, t.updated_at, t.updated_by,
              COALESCE(u.display_name, u.email) AS updated_by_email
         FROM triggers t
         LEFT JOIN users u ON u.id = t.updated_by
        WHERE ${where.join(" AND ")}
        ORDER BY t.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, COALESCE(u.display_name, u.email) AS updated_by_email
         FROM triggers t
         LEFT JOIN users u ON u.id = t.updated_by
        WHERE t.id=$1 AND t.workspace_id=$2`,
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("trigger");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post("/", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { name, graphId, type, config = {}, enabled = true } = req.body || {};
    if (!name || !graphId || !type) {
      throw new ValidationError("name, graphId, and type are required");
    }
    triggerRegistry.validateConfig(type, config);
    // Verify graph exists in caller's workspace.
    const { rows: gs } = await pool.query(
      "SELECT id FROM graphs WHERE id=$1 AND workspace_id=$2",
      [graphId, req.user.workspaceId],
    );
    if (gs.length === 0) throw new ValidationError(`graph ${graphId} not found`);

    const id = uuid();
    await pool.query(
      `INSERT INTO triggers (id, name, graph_id, type, config, enabled, workspace_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, name, graphId, type, JSON.stringify(config), Boolean(enabled), req.user.workspaceId, req.user.id],
    );
    if (enabled) await syncTrigger(id);
    await auditLog({
      req, action: "trigger.create",
      resource: { type: "trigger", id, name },
      metadata: { triggerType: type, graphId, enabled: Boolean(enabled) },
    });
    res.status(201).json({ id });
  } catch (e) { next(e); }
});

router.put("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { name, config, enabled } = req.body || {};
    const { rows: existing } = await pool.query(
      "SELECT type FROM triggers WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (existing.length === 0) throw new NotFoundError("trigger");
    if (config !== undefined) triggerRegistry.validateConfig(existing[0].type, config);

    const sets = [], params = [];
    if (name      !== undefined) { params.push(name);                      sets.push(`name = $${params.length}`); }
    if (config    !== undefined) { params.push(JSON.stringify(config));    sets.push(`config = $${params.length}::jsonb`); }
    if (enabled   !== undefined) { params.push(Boolean(enabled));          sets.push(`enabled = $${params.length}`); }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    // Stamp the modifier on every UPDATE.
    params.push(req.user.id);
    sets.push(`updated_by = $${params.length}`);
    params.push(req.params.id);
    const idIdx = params.length;
    params.push(req.user.workspaceId);
    const wsIdx = params.length;
    sets.push("updated_at = NOW()");
    await pool.query(
      `UPDATE triggers SET ${sets.join(", ")} WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
      params,
    );

    await syncTrigger(req.params.id);
    await auditLog({
      req, action: "trigger.update",
      resource: { type: "trigger", id: req.params.id, name: name },
      metadata: { changes: { name, config, enabled } },
    });
    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

// Run-now: insert an execution row + enqueue, bypassing the live
// subscription. The trigger doesn't need to be enabled — useful for
// "test this trigger" and "manually replay" flows. Body may carry a
// custom `payload` object that becomes the execution's inputs.
router.post("/:id/fire", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const payload = req.body?.payload && typeof req.body.payload === "object"
      ? req.body.payload
      : {};
    const result = await fireTriggerById(req.params.id, {
      payload, workspaceId: req.user.workspaceId,
      tags: req.body?.tags,           // forwarded; normalised inside manager.js
    });
    await auditLog({
      req, action: "trigger.fire",
      resource: { type: "trigger", id: req.params.id },
      metadata: { executionId: result.executionId },
    });
    res.status(202).json(result);
  } catch (e) {
    if (/not found/.test(e?.message || "")) return next(new NotFoundError("trigger"));
    next(e);
  }
});

router.delete("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM triggers WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rowCount === 0) throw new NotFoundError("trigger");
    await syncTrigger(req.params.id);   // will stop the live subscription
    await auditLog({
      req, action: "trigger.delete",
      resource: { type: "trigger", id: req.params.id },
    });
    res.status(200).json({ ok: true, id: req.params.id, deleted: "trigger" });
  } catch (e) { next(e); }
});

export default router;
