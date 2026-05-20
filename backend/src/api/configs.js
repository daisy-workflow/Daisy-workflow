// Typed configurations API.
//
// A config row carries an external-system connection or credential bundle:
//
//     { id, name, type, description, data, created_at, updated_at }
//
// `type` selects the schema (database / mail.smtp / mail.imap / mqtt /
// generic) and `data` is the typed blob. Secret fields inside `data` are
// stored encrypted on disk (see configs/crypto.js); the API only ever
// returns "***" in their place. Encryption is opaque to clients — they
// PUT/POST plaintext, the server encrypts before insert.
//
// Endpoints:
//
//     GET    /configs/types     → registry for the editor UI
//     GET    /configs           → list (secrets masked)
//     GET    /configs/:id       → single row (secrets masked)
//     POST   /configs           → create
//     PUT    /configs/:id       → partial update (omit a secret field to keep its existing value)
//     DELETE /configs/:id       → delete

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import {
  TYPES,
  listTypes,
  getType,
  validateAndNormalize,
  encryptSecrets,
  decryptSecrets,
  maskSecrets,
} from "../configs/registry.js";
import { requireUser, requireRole, requireProject } from "../middleware/auth.js";
import { auditLog } from "../audit/log.js";
import { resyncTriggersUsingConfig } from "../triggers/manager.js";
import { evictMqttClient } from "../plugins/mqtt/util.js";
import { log } from "../utils/logger.js";

const router = Router();

// Auth model:
//   • Reads (list/get/types)     — admin + editor (editor needs them
//                                   to wire configs into graph nodes;
//                                   viewer doesn't edit so omitted).
//   • Writes (create/update/rotate/delete) — admin only. Configs hold
//                                   credentials; only an admin should
//                                   be able to create or rotate them.
//   • Workspace scoping          — every query carries
//                                   workspace_id = req.user.workspaceId.
router.use(requireUser);

// Names share the same identifier rules we use for graph nodes — they're
// how a config is referenced from a DSL expression (${config.<name>.<key>}),
// so they need to be path-safe.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// ──────────────────────────────────────────────────────────────────────────
// Type registry — drives the frontend ConfigDesigner UI.
// Catalog endpoint — no project context required.
// ──────────────────────────────────────────────────────────────────────────
router.get("/types", requireRole("admin", "editor"), (_req, res) => {
  res.json(listTypes());
});

// RBAC v2: everything below scopes by (workspace, project). Workspace-
// shared configs (project_id IS NULL AND shared_at_workspace = true)
// land in Phase 3 — for now every config is project-private, the
// query filters require BOTH workspace + project to match. The
// schema's project_id column is nullable to make the shared case
// possible later, but inserts here always supply a value.
router.use(requireProject);

// ──────────────────────────────────────────────────────────────────────────
// List — secrets masked.
// ──────────────────────────────────────────────────────────────────────────
router.get("/", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    // Configs surface project-private rows + workspace-shared rows in
    // one list. The shared flag travels with the row so the UI can
    // render a chip and decide whether to show edit/delete affordances
    // (workspace-admin only for shared rows).
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.type, c.description, c.data,
              c.shared_at_workspace,
              c.project_id,
              c.created_at, c.updated_at, c.updated_by,
              COALESCE(u.display_name, u.email) AS updated_by_email
         FROM configs c
         LEFT JOIN users u ON u.id = c.updated_by
        WHERE c.workspace_id = $1
          AND (
                c.project_id = $2
             OR (c.project_id IS NULL AND c.shared_at_workspace = true)
          )
        ORDER BY c.shared_at_workspace, c.name`,
      [req.user.workspaceId, req.user.projectId],
    );
    res.json(rows.map(r => ({
      ...r,
      data: maskSecrets(r.type, r.data),
    })));
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Get one — secrets masked. Use update flow to "rotate" a secret.
// ──────────────────────────────────────────────────────────────────────────
router.get("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    // Same overlay as the list — a single row lookup needs to accept
    // both layers, otherwise the UI can't open a shared config when
    // a project is active.
    const { rows } = await pool.query(
      `SELECT c.*, COALESCE(u.display_name, u.email) AS updated_by_email
         FROM configs c
         LEFT JOIN users u ON u.id = c.updated_by
        WHERE c.id=$1
          AND c.workspace_id=$2
          AND (
                c.project_id = $3
             OR (c.project_id IS NULL AND c.shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("config");
    const row = rows[0];
    res.json({ ...row, data: maskSecrets(row.type, row.data) });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────────
router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const { name, type, description = "", data = {}, sharedAtWorkspace = false } = req.body || {};
    if (!name) throw new ValidationError("name required");
    if (!NAME_RE.test(name)) {
      throw new ValidationError(`invalid name: "${name}" — use letters, digits, _, - (must start with a letter or _)`);
    }
    if (!TYPES[type]) throw new ValidationError(`unknown type: "${type}"`);

    // Workspace-shared configs are owned by the workspace as a whole.
    // Only workspace admins can author them — a project admin who's
    // not also a workspace admin can't promote a project secret into
    // a shared one, which would otherwise be a privilege escalation.
    if (sharedAtWorkspace) {
      if (!await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
        throw new ForbiddenError("only workspace admins can create workspace-shared configs");
      }
    }

    const normalised = validateAndNormalize(type, stripMaskedSecrets(type, data));
    if (TYPES[type].freeform && data?.__secret) normalised.__secret = data.__secret;

    // Phase F: compliance gate. Refuse the save when the resolved
    // provider isn't in the workspace's allow-list, or when its
    // endpoint URL doesn't match the workspace's data residency.
    // Runs against the normalised + decrypted data so we see the
    // actual provider/baseUrl the runtime would use.
    if (type === "ai.provider" || type === "vector.qdrant") {
      const { loadWorkspaceCompliance, assertProviderAllowed }
        = await import("../compliance/enforce.js");
      const ws = await loadWorkspaceCompliance(req.user.workspaceId);
      try { assertProviderAllowed(ws, normalised); }
      catch (e) {
        if (e.code === "COMPLIANCE_BLOCKED") throw new ValidationError(e.message);
        throw e;
      }
    }

    const { data: stored, encryption_version, kek_id } =
      await encryptSecrets(type, normalised);

    const id = uuid();
    // Shared configs carry project_id=NULL. Private configs carry the
    // caller's active project. shared_at_workspace flag mirrors the
    // intent so a future SELECT can index on it without needing the
    // (project_id IS NULL) sentinel check.
    const projectIdToWrite = sharedAtWorkspace ? null : req.user.projectId;
    try {
      await pool.query(
        `INSERT INTO configs (id, name, type, description, data,
                              encryption_version, kek_id,
                              workspace_id, project_id, shared_at_workspace,
                              updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, name, type, description || "", JSON.stringify(stored),
         encryption_version, kek_id,
         req.user.workspaceId, projectIdToWrite, !!sharedAtWorkspace,
         req.user.id],
      );
    } catch (e) {
      if (e.code === "23505") throw new ValidationError(`config name "${name}" already exists`);
      throw e;
    }
    await auditLog({
      req, action: sharedAtWorkspace ? "config.create.shared" : "config.create",
      resource: { type: "config", id, name },
      projectId: projectIdToWrite,
      metadata: { configType: type, sharedAtWorkspace: !!sharedAtWorkspace },
    });
    res.status(201).json({ id, name, sharedAtWorkspace: !!sharedAtWorkspace });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Update (partial)
//
// Sending data fields is "merge over the existing row" — fields you don't
// include keep their stored value. Sending the literal "***" for a secret
// field means "keep the existing secret". Sending any other string for a
// secret field rotates it.
// ──────────────────────────────────────────────────────────────────────────
router.put("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const { name, description, data } = req.body || {};

    // Look up the config in either layer. Shared rows (project_id IS
    // NULL + shared_at_workspace = true) must be editable from any
    // project context, gated by workspace-admin role below.
    const { rows } = await pool.query(
      `SELECT * FROM configs
        WHERE id=$1 AND workspace_id=$2
          AND (
                project_id = $3
             OR (project_id IS NULL AND shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("config");
    const existing = rows[0];

    // Workspace-shared rows: only the workspace admin can mutate.
    if (existing.shared_at_workspace) {
      if (!await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
        throw new ForbiddenError("workspace-shared configs can only be edited by workspace admins");
      }
    }

    if (name !== undefined && name !== existing.name && !NAME_RE.test(name)) {
      throw new ValidationError(`invalid name: "${name}"`);
    }

    const sets = [], params = [];
    if (name !== undefined && name !== existing.name) {
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description); sets.push(`description = $${params.length}`);
    }
    if (data !== undefined) {
      // Merge: incoming partial → existing → validate → re-encrypt.
      const merged = mergeData(existing.type, existing.data, data);
      const normalised = validateAndNormalize(existing.type, merged);
      if (TYPES[existing.type].freeform) {
        const incomingSecret = data?.__secret || existing.data?.__secret || {};
        if (incomingSecret && Object.keys(incomingSecret).length) {
          normalised.__secret = incomingSecret;
        }
      }
      // Phase F: same compliance gate as POST. PUT can change the
      // provider mid-life (e.g., user pasted new credentials), so
      // we re-check on every edit rather than only at create-time.
      if (existing.type === "ai.provider" || existing.type === "vector.qdrant") {
        const { loadWorkspaceCompliance, assertProviderAllowed }
          = await import("../compliance/enforce.js");
        const ws = await loadWorkspaceCompliance(req.user.workspaceId);
        try { assertProviderAllowed(ws, normalised); }
        catch (e) {
          if (e.code === "COMPLIANCE_BLOCKED") throw new ValidationError(e.message);
          throw e;
        }
      }
      const { data: stored, encryption_version, kek_id } =
        await encryptSecrets(existing.type, normalised);
      params.push(JSON.stringify(stored));         sets.push(`data = $${params.length}::jsonb`);
      params.push(encryption_version);             sets.push(`encryption_version = $${params.length}`);
      params.push(kek_id);                         sets.push(`kek_id = $${params.length}`);
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    // Stamp the modifier on every UPDATE — including no-data renames /
    // description-only edits.
    params.push(req.user.id);
    sets.push(`updated_by = $${params.length}`);
    params.push(req.params.id);
    const idIdx = params.length;
    params.push(req.user.workspaceId);
    const wsIdx = params.length;
    sets.push("updated_at = NOW()");
    try {
      // Update by id within the workspace — the visibility check above
      // already proved the row is accessible to this caller in either
      // layer. No need to filter on project_id here.
      await pool.query(
        `UPDATE configs SET ${sets.join(", ")}
          WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
        params,
      );
    } catch (e) {
      if (e.code === "23505") throw new ValidationError(`config name "${name}" already exists`);
      throw e;
    }
    await auditLog({
      req, action: "config.update",
      resource: { type: "config", id: req.params.id, name: name ?? existing.name },
      projectId: req.user.projectId,
    });

    // Side-effects: subscriptions / connection pools may now reference
    // stale URLs / credentials. Evict + resync.
    //
    //   1. For mqtt configs, drop any cached TCP client keyed to the OLD
    //      URL so the next subscribe creates a fresh socket.
    //   2. Force-restart every trigger in this workspace that references
    //      this config by name. Their config blob stores only the name,
    //      so the trigger manager has no other way to notice the change.
    //
    // Failures are soft-logged — we don't want a healthy DB write to be
    // reported as failed because a downstream connection didn't drop.
    queueMicrotask(async () => {
      try {
        if (existing.type === "mqtt") {
          // Decrypt the OLD row so we know what URL to evict. We tolerate
          // any decrypt error — eviction is best-effort.
          const oldPlain = await decryptSecrets(existing.type, existing.data || {}).catch(() => ({}));
          if (oldPlain?.url) {
            evictMqttClient({
              url:      oldPlain.url,
              username: oldPlain.username,
              clientId: oldPlain.clientId,
            });
          }
        }
        await resyncTriggersUsingConfig(name ?? existing.name, req.user.workspaceId);
      } catch (e) {
        log.warn("config-update side-effects failed", {
          configId: req.params.id, error: e.message,
        });
      }
    });

    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Rotate — re-encrypt this row with a fresh DEK.
//
// What it does:
//   1. Decrypts the row's current secret fields (legacy v1 or v2).
//   2. Calls KMS.GenerateDataKey for a brand-new DEK.
//   3. Re-encrypts every secret field with the new DEK and writes back.
//
// Use cases:
//   • Suspected DEK leak → rotate just that row, no global key change.
//   • Periodic per-row rotation policy (cron / on-demand from UI).
//   • Migrate a legacy v1 row to v2 without the user having to
//     re-enter the secret value.
//
// The KEK in KMS is NOT rotated by this call — that's a KMS-side
// operation and doesn't require touching any ciphertext (KMS handles
// version mapping internally; on AWS, automatic annual KEK rotation
// is a one-checkbox setting).
// ──────────────────────────────────────────────────────────────────────────
router.post("/:id/rotate", requireRole("admin"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM configs
        WHERE id=$1 AND workspace_id=$2
          AND (
                project_id = $3
             OR (project_id IS NULL AND shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (rows.length === 0) throw new NotFoundError("config");
    const existing = rows[0];
    if (existing.shared_at_workspace
        && !await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace-shared configs can only be rotated by workspace admins");
    }

    // Decrypt to plaintext using whatever scheme the row is currently on.
    const plaintext = await decryptSecrets(existing.type, existing.data || {});
    // The freeform __secret marker survives in `existing.data` separately
    // — re-attach it so encryptSecrets knows which keys to encrypt.
    if (TYPES[existing.type].freeform && existing.data?.__secret) {
      plaintext.__secret = existing.data.__secret;
    }

    // Re-encrypt with a fresh DEK.
    const { data: stored, encryption_version, kek_id } =
      await encryptSecrets(existing.type, plaintext);

    await pool.query(
      `UPDATE configs
          SET data = $2::jsonb,
              encryption_version = $3,
              kek_id = $4,
              updated_at = NOW(),
              updated_by = $6
        WHERE id = $1 AND workspace_id = $5`,
      [existing.id, JSON.stringify(stored), encryption_version, kek_id,
       req.user.workspaceId, req.user.id],
    );
    await auditLog({
      req, action: "config.rotate",
      resource: { type: "config", id: existing.id, name: existing.name },
      projectId: req.user.projectId,
      metadata: {
        from_version: existing.encryption_version,
        to_version:   encryption_version,
        kek_id,
      },
    });
    res.json({
      id: existing.id,
      rotated: true,
      from_version: existing.encryption_version,
      to_version:   encryption_version,
      kek_id,
    });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Delete
// ──────────────────────────────────────────────────────────────────────────
router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    // Capture the row BEFORE deleting so we know what to evict / resync.
    const { rows: pre } = await pool.query(
      `SELECT name, type, data, shared_at_workspace
         FROM configs
        WHERE id=$1 AND workspace_id=$2
          AND (
                project_id = $3
             OR (project_id IS NULL AND shared_at_workspace = true)
          )`,
      [req.params.id, req.user.workspaceId, req.user.projectId],
    );
    if (pre.length === 0) throw new NotFoundError("config");
    const existing = pre[0];
    if (existing.shared_at_workspace
        && !await isWorkspaceAdmin(req.user.id, req.user.workspaceId)) {
      throw new ForbiddenError("workspace-shared configs can only be deleted by workspace admins");
    }

    const { rowCount } = await pool.query(
      "DELETE FROM configs WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rowCount === 0) throw new NotFoundError("config");
    await auditLog({
      req, action: "config.delete",
      resource: { type: "config", id: req.params.id, name: existing.name },
      projectId: req.user.projectId,
    });

    // Same side-effects as PUT: triggers referencing this name need to
    // tear down (they'll raise "config not found" on their next subscribe,
    // which surfaces in the trigger list's last_error and stops them
    // attempting to use a phantom broker).
    queueMicrotask(async () => {
      try {
        if (existing.type === "mqtt") {
          const oldPlain = await decryptSecrets(existing.type, existing.data || {}).catch(() => ({}));
          if (oldPlain?.url) {
            evictMqttClient({
              url:      oldPlain.url,
              username: oldPlain.username,
              clientId: oldPlain.clientId,
            });
          }
        }
        await resyncTriggersUsingConfig(existing.name, req.user.workspaceId);
      } catch (e) {
        log.warn("config-delete side-effects failed", {
          configId: req.params.id, error: e.message,
        });
      }
    });

    res.status(200).json({ ok: true, id: req.params.id, deleted: "config" });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Strip the "***" sentinel sent back from list/get responses so it doesn't
 *  overwrite real ciphertext. Also re-attaches existing ciphertext if the
 *  caller is creating from a copied-and-edited list response. */
function stripMaskedSecrets(type, data) {
  const out = { ...(data || {}) };
  for (const k of Object.keys(out)) {
    if (out[k] === "***") delete out[k];
  }
  return out;
}

/**
 * Workspace-admin check. Mirrors the helper in projects.js — both
 * surfaces need to gate sharing-promotion actions on real workspace
 * admin rights, not just whatever role the caller happens to have in
 * their currently-active project.
 */
async function isWorkspaceAdmin(userId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT role FROM workspace_members
      WHERE user_id = $1 AND workspace_id = $2
      LIMIT 1`,
    [userId, workspaceId],
  );
  if (rows.length && rows[0].role === "admin") return true;
  const { rows: u } = await pool.query(
    `SELECT 1 FROM users
      WHERE id = $1 AND workspace_id = $2 AND role = 'admin'
      LIMIT 1`,
    [userId, workspaceId],
  );
  return u.length > 0;
}

/** Merge a PATCH-style partial onto the existing stored row. Secret fields
 *  whose incoming value is "***" or undefined are taken from the stored
 *  envelope (preserving the encrypted ciphertext). Anything else replaces. */
function mergeData(type, existing = {}, patch = {}) {
  const def = getType(type);
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === "***") continue;             // preserve existing secret
    if (k === "__secret") continue;        // handled separately
    out[k] = v;
  }
  // For typed configs, ensure secret fields that were omitted keep their
  // ciphertext rather than being wiped.
  if (!def.freeform) {
    for (const f of def.fields) {
      if (f.secret && (patch[f.name] === undefined || patch[f.name] === "***")) {
        if (existing[f.name] !== undefined) out[f.name] = existing[f.name];
      }
    }
  }
  return out;
}

export default router;
