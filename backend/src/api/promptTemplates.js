// Prompt templates REST API.
//
// Endpoints (project-scoped):
//   GET    /prompt-templates                  — list (project + workspace-shared)
//   POST   /prompt-templates                  — create
//   GET    /prompt-templates/:id              — fetch one
//   PUT    /prompt-templates/:id              — update
//   DELETE /prompt-templates/:id              — delete
//   POST   /prompt-templates/:id/preview      — render against supplied vars (no persistence)
//
// Permissions:
//   prompt.read   — list / get / preview (viewers + editors + admins)
//   prompt.write  — create / update / delete (editors + admins)
//   prompt.share_workspace — author workspace-shared rows (workspace admin)

import { Router } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission, hasPermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";
import { render, extractVariables } from "../prompts/render.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  requirePermission("prompt.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, description, body, variables,
                shared_at_workspace, project_id,
                created_at, updated_at, created_by
           FROM prompt_templates
          WHERE workspace_id = $1
            AND (
                  project_id = $2
               OR (project_id IS NULL AND shared_at_workspace = true)
            )
          ORDER BY shared_at_workspace, title`,
        [req.user.workspaceId, req.user.projectId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post(
  "/",
  requirePermission("prompt.write"),
  async (req, res, next) => {
    try {
      const {
        title, description, body, variables,
        sharedAtWorkspace = false,
      } = req.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        throw new ValidationError("title is required");
      }
      if (!body || typeof body !== "string") {
        throw new ValidationError("body is required");
      }
      if (variables && !Array.isArray(variables)) {
        throw new ValidationError("variables must be an array");
      }
      // Workspace-shared rows are an admin privilege — mirrors configs
      // + agents sharing model.
      if (sharedAtWorkspace
       && !await hasPermission(req, "prompt.share_workspace")) {
        throw new ForbiddenError("only workspace admins can create workspace-shared prompt templates");
      }

      const id = randomUUID();
      const projectIdToWrite = sharedAtWorkspace ? null : req.user.projectId;
      try {
        await pool.query(
          `INSERT INTO prompt_templates
             (id, workspace_id, project_id, shared_at_workspace,
              title, description, body, variables, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            id, req.user.workspaceId, projectIdToWrite, !!sharedAtWorkspace,
            title.trim(), description || null, body,
            JSON.stringify(variables || []),
            req.user.id || null,
          ],
        );
      } catch (e) {
        if (e.code === "23505") {
          throw new ValidationError(`a prompt template titled "${title}" already exists`);
        }
        throw e;
      }
      await auditLog({
        req, action: sharedAtWorkspace ? "prompt.create.shared" : "prompt.create",
        resource: { type: "prompt_template", id, name: title.trim() },
        projectId: projectIdToWrite,
      });
      res.status(201).json({ id });
    } catch (e) { next(e); }
  },
);

router.get(
  "/:id",
  requirePermission("prompt.read"),
  async (req, res, next) => {
    try {
      const row = await loadAndAuth(req);
      res.json(row);
    } catch (e) { next(e); }
  },
);

router.put(
  "/:id",
  requirePermission("prompt.write"),
  async (req, res, next) => {
    try {
      const existing = await loadAndAuth(req);
      // Shared rows are admin-only edits, matching the create rule.
      if (existing.shared_at_workspace
       && !await hasPermission(req, "prompt.share_workspace")) {
        throw new ForbiddenError("workspace-shared prompt templates can only be edited by workspace admins");
      }

      const { title, description, body, variables } = req.body || {};
      const updates = [], params = [req.params.id, req.user.workspaceId];
      if (title !== undefined) {
        if (!String(title).trim()) throw new ValidationError("title cannot be blank");
        params.push(String(title).trim());
        updates.push(`title = $${params.length}`);
      }
      if (description !== undefined) {
        params.push(description || null);
        updates.push(`description = $${params.length}`);
      }
      if (body !== undefined) {
        if (typeof body !== "string") throw new ValidationError("body must be a string");
        params.push(body);
        updates.push(`body = $${params.length}`);
      }
      if (variables !== undefined) {
        if (!Array.isArray(variables)) throw new ValidationError("variables must be an array");
        params.push(JSON.stringify(variables));
        updates.push(`variables = $${params.length}::jsonb`);
      }
      if (!updates.length) return res.json({ ok: true });
      updates.push("updated_at = NOW()");

      const r = await pool.query(
        `UPDATE prompt_templates SET ${updates.join(", ")}
          WHERE id = $1 AND workspace_id = $2`,
        params,
      );
      if (!r.rowCount) throw new NotFoundError("prompt template");

      await auditLog({
        req, action: "prompt.update",
        resource: { type: "prompt_template", id: req.params.id },
        projectId: existing.project_id || null,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

router.delete(
  "/:id",
  requirePermission("prompt.write"),
  async (req, res, next) => {
    try {
      const existing = await loadAndAuth(req);
      if (existing.shared_at_workspace
       && !await hasPermission(req, "prompt.share_workspace")) {
        throw new ForbiddenError("workspace-shared prompt templates can only be deleted by workspace admins");
      }
      await pool.query(
        `DELETE FROM prompt_templates WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, req.user.workspaceId],
      );
      await auditLog({
        req, action: "prompt.delete",
        resource: { type: "prompt_template", id: req.params.id },
        projectId: existing.project_id || null,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// Preview — render the template against vars without saving.
// Used by the editor's "Try it" panel + the agent designer's
// "what does this look like".
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/preview",
  requirePermission("prompt.read"),
  async (req, res, next) => {
    try {
      const row = await loadAndAuth(req);
      const vars = req.body?.vars || {};
      try {
        const rendered = render(row.body, vars, { strict: !!req.body?.strict });
        res.json({
          rendered,
          missing: extractVariables(row.body).filter(v => vars[v] === undefined),
        });
      } catch (e) {
        // Strict render with missing vars throws; return as a 400 so
        // the UI can surface the exact missing list.
        res.status(400).json({ error: "RENDER_FAILED", message: e.message });
      }
    } catch (e) { next(e); }
  },
);

// ─── helpers ──────────────────────────────────────────────────

async function loadAndAuth(req) {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, project_id, shared_at_workspace,
            title, description, body, variables, created_at, updated_at
       FROM prompt_templates
      WHERE id = $1 AND workspace_id = $2
        AND (
              project_id = $3
           OR (project_id IS NULL AND shared_at_workspace = true)
        )`,
    [req.params.id, req.user.workspaceId, req.user.projectId],
  );
  if (!rows[0]) throw new NotFoundError("prompt template");
  return rows[0];
}

export default router;
