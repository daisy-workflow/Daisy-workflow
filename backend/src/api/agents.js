// Agents API — CRUD for named LLM personas.
//
// RBAC v2: project-scoped. Workspace-shared agents (shared_at_workspace
// = true) are a Phase 3 follow-up — for now every agent is project-private,
// the schema's project_id column is nullable so the shared case can land
// without another migration. Inserts here always supply a value.
//
// An agent row pairs a system prompt with a stored ai.provider config.
// The `agent` plugin runs an agent by title, sending the workflow's input
// text alongside the prompt to the configured provider. Agent and config
// must live in the SAME project (or both be workspace-shared).
//
// Auth model:
//   • Reads (list/get)              — admin, editor, viewer.
//   • Writes (create/update/delete) — admin, editor.

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import { requireUser, requireRole, requireProject } from "../middleware/auth.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

// Titles double as the lookup key for the agent plugin (`agent: "<title>"`),
// so they need to be friendly but predictable.
const TITLE_RE = /^[A-Za-z0-9 _.\-]+$/;

router.get("/", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    // Agents surface project-private + workspace-shared in the same
    // list. Config lookup for the joined row also accepts either layer
    // so a shared agent referencing a shared config resolves cleanly.
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.prompt, a.config_name, a.description,
              a.shared_at_workspace,
              a.project_id,
              a.created_at, a.updated_at, a.updated_by,
              c.type AS config_type,
              COALESCE(u.display_name, u.email) AS updated_by_email
         FROM agents a
         LEFT JOIN configs c
                ON c.name = a.config_name
               AND c.workspace_id = a.workspace_id
               AND (
                    c.project_id = a.project_id
                 OR (c.project_id IS NULL AND c.shared_at_workspace = true)
               )
         LEFT JOIN users u ON u.id = a.updated_by
        WHERE a.workspace_id = $1
          AND (
                a.project_id = $2
             OR (a.project_id IS NULL AND a.shared_at_workspace = true)
          )
        ORDER BY a.shared_at_workspace, a.title`,
      [req.user.workspaceId, req.user.projectId],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, COALESCE(u.display_name, u.email) AS updated_by_email
         FROM agents a
         LEFT JOIN users u ON u.id = a.updated_by
        WHERE a.id=$1 AND a.workspace_id=$2
          AND (
                a.project_id = $3
             OR (a.project_id IS NULL AND a.shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("agent");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post("/", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { title, prompt, config_name, description, sharedAtWorkspace = false,
            guardrails_override, prompt_template_id } = req.body || {};
    validatePayload({ title, prompt, config_name }, /* requireAll */ true);

    // Only workspace admins can author workspace-shared agents — same
    // privilege-escalation guard as configs.
    if (sharedAtWorkspace
        && !await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("only workspace admins can create workspace-shared agents");
    }

    await ensureConfigExists(config_name, req.user.workspaceId, req.user.projectId);

    const id = uuid();
    const projectIdToWrite = sharedAtWorkspace ? null : req.user.projectId;
    try {
      await pool.query(
        `INSERT INTO agents (id, title, prompt, config_name, description,
                              workspace_id, project_id, shared_at_workspace,
                              guardrails_override, prompt_template_id, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [id, title.trim(), prompt, config_name, description || null,
         req.user.workspaceId, projectIdToWrite, !!sharedAtWorkspace,
         guardrails_override ? JSON.stringify(guardrails_override) : null,
         prompt_template_id || null,
         req.user.id],
      );
    } catch (e) {
      if (e.code === "23505") {
        throw new ValidationError(`an agent titled "${title}" already exists`);
      }
      throw e;
    }
    await auditLog({
      req, action: sharedAtWorkspace ? "agent.create.shared" : "agent.create",
      resource: { type: "agent", id, name: title.trim() },
      projectId: projectIdToWrite,
      metadata: { sharedAtWorkspace: !!sharedAtWorkspace },
    });
    res.status(201).json({ id, title, sharedAtWorkspace: !!sharedAtWorkspace });
  } catch (e) { next(e); }
});

router.put("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { title, prompt, config_name, description, guardrails_override,
            prompt_template_id } = req.body || {};
    // Look up in either layer so shared agents are editable.
    const { rows: lookup } = await pool.query(
      `SELECT shared_at_workspace
         FROM agents
        WHERE id=$1 AND workspace_id=$2
          AND (
                project_id = $3
             OR (project_id IS NULL AND shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (lookup.length === 0) throw new NotFoundError("agent");
    if (lookup[0].shared_at_workspace
        && !await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace-shared agents can only be edited by workspace admins");
    }

    if (config_name !== undefined) {
      await ensureConfigExists(config_name, req.user.workspaceId, req.user.projectId);
    }
    validatePayload({ title, prompt, config_name }, /* requireAll */ false);

    const sets = [], params = [];
    if (title       !== undefined) { params.push(title.trim()); sets.push(`title = $${params.length}`); }
    if (prompt      !== undefined) { params.push(prompt);       sets.push(`prompt = $${params.length}`); }
    if (config_name !== undefined) { params.push(config_name);  sets.push(`config_name = $${params.length}`); }
    if (description !== undefined) { params.push(description || null); sets.push(`description = $${params.length}`); }
    // guardrails_override: null = clear the override, object = upsert,
    // undefined = leave alone. The CAST keeps the column properly
    // typed (JSONB).
    if (guardrails_override !== undefined) {
      params.push(guardrails_override ? JSON.stringify(guardrails_override) : null);
      sets.push(`guardrails_override = $${params.length}::jsonb`);
    }
    // prompt_template_id: null = unbind (fall back to inline prompt),
    // UUID = pin a template, undefined = leave alone.
    if (prompt_template_id !== undefined) {
      params.push(prompt_template_id || null);
      sets.push(`prompt_template_id = $${params.length}`);
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    params.push(req.user.id);
    sets.push(`updated_by = $${params.length}`);
    params.push(req.params.id);
    const idIdx = params.length;
    params.push(req.user.workspaceId);
    const wsIdx = params.length;
    sets.push("updated_at = NOW()");
    try {
      const { rowCount } = await pool.query(
        `UPDATE agents SET ${sets.join(", ")}
          WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
        params,
      );
      if (rowCount === 0) throw new NotFoundError("agent");
    } catch (e) {
      if (e.code === "23505") {
        throw new ValidationError(`an agent titled "${title}" already exists`);
      }
      throw e;
    }
    await auditLog({
      req, action: "agent.update",
      resource: { type: "agent", id: req.params.id, name: title?.trim() },
      projectId: lookup[0].shared_at_workspace ? null : req.user.projectId,
    });
    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

router.delete("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rows: lookup } = await pool.query(
      `SELECT shared_at_workspace FROM agents
        WHERE id=$1 AND workspace_id=$2
          AND (
                project_id = $3
             OR (project_id IS NULL AND shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (lookup.length === 0) throw new NotFoundError("agent");
    if (lookup[0].shared_at_workspace
        && !await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace-shared agents can only be deleted by workspace admins");
    }
    const { rowCount } = await pool.query(
      "DELETE FROM agents WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rowCount === 0) throw new NotFoundError("agent");
    await auditLog({
      req, action: "agent.delete",
      resource: { type: "agent", id: req.params.id },
      projectId: lookup[0].shared_at_workspace ? null : req.user.projectId,
    });
    res.status(200).json({ ok: true, id: req.params.id, deleted: "agent" });
  } catch (e) { next(e); }
});

// ── helpers ───────────────────────────────────────────────────────────

function validatePayload({ title, prompt, config_name }, requireAll) {
  if (requireAll) {
    if (!title || !prompt || !config_name) {
      throw new ValidationError("title, prompt, and config_name are required");
    }
  }
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) throw new ValidationError("title must be a non-empty string");
    if (!TITLE_RE.test(title.trim())) {
      throw new ValidationError("title may contain letters, digits, spaces, underscores, dots, and dashes only");
    }
  }
  if (prompt !== undefined) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new ValidationError("prompt must be a non-empty string");
  }
  if (config_name !== undefined) {
    if (typeof config_name !== "string" || !config_name.trim()) throw new ValidationError("config_name must be a non-empty string");
  }
}

async function ensureConfigExists(name, workspaceId, projectId) {
  // Same project-private + workspace-shared overlay as the loader uses
  // at runtime. Agents that pick the shared OpenAI config don't need a
  // project-private duplicate to validate.
  const { rows } = await pool.query(
    `SELECT type FROM configs
      WHERE name=$1
        AND workspace_id=$2
        AND (
              project_id = $3
           OR (project_id IS NULL AND shared_at_workspace = true)
        )
      LIMIT 1`,
    [name, workspaceId, projectId],
  );
  if (rows.length === 0) {
    throw new ValidationError(`config "${name}" not found in this project or workspace-shared. Create one of type ai.provider on the Configurations page.`);
  }
  if (rows[0].type !== "ai.provider") {
    throw new ValidationError(`config "${name}" is type "${rows[0].type}", but agents require type ai.provider.`);
  }
}

/**
 * Same helper as configs.js — used to gate sharing-promotion actions.
 * We don't import from configs.js to keep the module dependency
 * graph one-way; the function is tiny.
 */
async function isWorkspaceAdmin(userId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT role FROM workspace_members
      WHERE user_id = $1 AND workspace_id = $2 LIMIT 1`,
    [userId, workspaceId],
  );
  if (rows.length && rows[0].role === "admin") return true;
  const { rows: u } = await pool.query(
    `SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2 AND role = 'admin' LIMIT 1`,
    [userId, workspaceId],
  );
  return u.length > 0;
}

export default router;
