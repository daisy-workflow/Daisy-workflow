// Project-plugins API — per-project enablement of installed plugins.
//
// The workspace admin installs plugins globally (see /plugins). This
// page lets a project admin decide which of the installed non-core
// plugins their workflows may use.
//
// Endpoints:
//   GET  /project-plugins                — list installed plugins
//                                          + per-project enablement
//                                          for the active project.
//   PUT  /project-plugins/:pluginName    — set enabled true / false
//                                          for the active project.
//   DELETE /project-plugins/:pluginName  — remove the explicit grant
//                                          (falls back to "not granted").
//
// Permission:
//   service_account.create is a project-admin perm in permissions.js,
//   but we want this gated on the project's own admin role rather than
//   the SA-management perm. Add a dedicated permission name — see
//   `auth/permissions.js` for the integration.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { setProjectPluginEnabled } from "../auth/pluginGrants.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireProject);

// ────────────────────────────────────────────────────────────────────
// GET /project-plugins
//
// Returns one row per installed plugin in the workspace, with the
// enablement state in the active project:
//   { name, version, source, category, manifest_title, status,
//     core: bool, enabled_in_project: bool, granted_by_email }
//
// Core plugins always come back with `enabled_in_project = true` so
// the UI can render them as always-on (greyed-out toggle).
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission("plugin.list"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.name,
                p.version,
                p.source,
                p.manifest,
                p.status,
                (p.source = 'core')               AS core,
                COALESCE(g.enabled, p.source = 'core') AS enabled_in_project,
                g.granted_by                       AS granted_by_user,
                COALESCE(u.display_name, u.email)  AS granted_by_email,
                g.created_at                       AS granted_at
           FROM plugins p
           LEFT JOIN project_plugin_grants g
                  ON g.plugin_name = p.name AND g.project_id = $1
           LEFT JOIN users u ON u.id = g.granted_by
          WHERE p.enabled = true
          ORDER BY core DESC, p.name`,
        [req.user.projectId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// PUT /project-plugins/:pluginName  — toggle enablement for this project.
//
// Body: { enabled: boolean }
//
// Refuses to mutate core plugins (they're always-on by policy) — the
// API returns 400 in that case rather than silently no-opping so the
// UI can surface the constraint.
// ────────────────────────────────────────────────────────────────────
router.put("/:pluginName",
  requirePermission("plugin.invoke"),  // project admin / editor — anyone authoring workflows
  async (req, res, next) => {
    try {
      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean") {
        throw new ValidationError("body.enabled must be true or false");
      }

      // The plugin must exist + be installed at workspace level.
      const { rows: p } = await pool.query(
        `SELECT source FROM plugins WHERE name = $1 AND enabled = true`,
        [req.params.pluginName],
      );
      if (p.length === 0) throw new NotFoundError("plugin");
      if (p[0].source === "core") {
        throw new ValidationError(`plugin "${req.params.pluginName}" is core — always enabled, cannot be toggled per project`);
      }

      await setProjectPluginEnabled({
        projectId:  req.user.projectId,
        pluginName: req.params.pluginName,
        enabled,
        grantedBy:  req.user.id,
      });
      await auditLog({
        req, action: enabled ? "project_plugin.enable" : "project_plugin.disable",
        resource:  { type: "plugin", id: req.params.pluginName, name: req.params.pluginName },
        projectId: req.user.projectId,
      });
      res.json({ pluginName: req.params.pluginName, enabled });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// DELETE /project-plugins/:pluginName — drop the explicit grant.
// Same end result as setting enabled = false but the row vanishes
// from the table entirely. Useful for "reset to default state."
// ────────────────────────────────────────────────────────────────────
router.delete("/:pluginName",
  requirePermission("plugin.invoke"),
  async (req, res, next) => {
    try {
      await setProjectPluginEnabled({
        projectId:  req.user.projectId,
        pluginName: req.params.pluginName,
        enabled:    null,
        grantedBy:  req.user.id,
      });
      await auditLog({
        req, action: "project_plugin.unset",
        resource:  { type: "plugin", id: req.params.pluginName, name: req.params.pluginName },
        projectId: req.user.projectId,
      });
      res.json({ pluginName: req.params.pluginName, removed: true });
    } catch (e) { next(e); }
  },
);

export default router;
