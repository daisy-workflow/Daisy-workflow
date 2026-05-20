// SAML config admin API — per workspace.
//
// One row per workspace (PK = workspace_id). Workspace admins manage
// it; the LoginPage and the SAML callback consume it. Operators can
// either fill in the IdP fields manually or paste an IdP metadata
// XML blob — we parse the SSO URL, entity ID, and cert out of it
// for them.
//
// Endpoints:
//   GET    /saml-config             current config for caller's workspace
//                                   (404 when none set)
//   PUT    /saml-config             upsert
//   DELETE /saml-config             remove entirely
//   POST   /saml-config/import      body: { metadataXml }
//                                   parses an IdP-supplied metadata
//                                   XML blob into form fields the
//                                   admin can then save normally

import { Router } from "express";
import { pool } from "../db/pool.js";
import {
  ValidationError, NotFoundError, ForbiddenError,
} from "../utils/errors.js";
import { requireUser } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";
import { invalidateSamlCache, isSamlConfiguredAtSpLevel } from "../auth/saml.js";

const router = Router();
router.use(requireUser);

// All SAML-config mutations are workspace-level — gate on a
// workspace-admin permission. We reuse workspace.update since adding
// a `saml.write` permission for one endpoint is heavier than the
// payoff. Anyone who can rename the workspace can also configure its
// SSO.
const PERM = "workspace.update";

// ────────────────────────────────────────────────────────────────────
// GET — current config + SP-level readiness flag so the UI can
// surface "your server admin needs to set SAML_SP_* env vars first"
// before a workspace admin tries to fill the form.
// ────────────────────────────────────────────────────────────────────
router.get("/",
  requirePermission(PERM),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT workspace_id, enabled,
                idp_entity_id, idp_sso_url, idp_slo_url, idp_cert,
                attribute_email, attribute_name, attribute_groups,
                auto_provision, default_role,
                created_at, updated_at
           FROM saml_configs
          WHERE workspace_id = $1`,
        [req.user.workspaceId],
      );
      res.json({
        spReady: isSamlConfiguredAtSpLevel(),
        config:  rows[0] || null,
      });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// PUT — upsert. Whole-row replace; the UI sends every field the user
// has on screen. Validates IdP fields are well-formed strings; cert
// is checked at SAML-init time (we don't reach for x509 parsing here).
// ────────────────────────────────────────────────────────────────────
router.put("/",
  requirePermission(PERM),
  async (req, res, next) => {
    try {
      if (!isSamlConfiguredAtSpLevel()) {
        throw new ForbiddenError(
          "SAML SP keypair is not configured on this server. Ask your operator " +
          "to set SAML_SP_ENTITY_ID, SAML_SP_ACS_URL, SAML_SP_PRIVATE_KEY, SAML_SP_CERT.",
        );
      }
      const {
        enabled = false,
        idp_entity_id,
        idp_sso_url,
        idp_slo_url,
        idp_cert,
        attribute_email   = "email",
        attribute_name    = "displayName",
        attribute_groups,
        auto_provision    = true,
        default_role      = "editor",
      } = req.body || {};

      if (!idp_entity_id || typeof idp_entity_id !== "string") {
        throw new ValidationError("idp_entity_id is required");
      }
      if (!idp_sso_url || !/^https?:\/\//i.test(idp_sso_url)) {
        throw new ValidationError("idp_sso_url must be an http(s) URL");
      }
      if (!idp_cert || !/-----BEGIN CERTIFICATE-----/.test(idp_cert)) {
        throw new ValidationError("idp_cert must be a PEM x509 certificate (BEGIN CERTIFICATE block)");
      }
      if (!["admin", "editor", "viewer"].includes(default_role)) {
        throw new ValidationError("default_role must be admin, editor, or viewer");
      }

      await pool.query(
        `INSERT INTO saml_configs
            (workspace_id, enabled, idp_entity_id, idp_sso_url, idp_slo_url, idp_cert,
             attribute_email, attribute_name, attribute_groups,
             auto_provision, default_role, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (workspace_id) DO UPDATE SET
            enabled          = EXCLUDED.enabled,
            idp_entity_id    = EXCLUDED.idp_entity_id,
            idp_sso_url      = EXCLUDED.idp_sso_url,
            idp_slo_url      = EXCLUDED.idp_slo_url,
            idp_cert         = EXCLUDED.idp_cert,
            attribute_email  = EXCLUDED.attribute_email,
            attribute_name   = EXCLUDED.attribute_name,
            attribute_groups = EXCLUDED.attribute_groups,
            auto_provision   = EXCLUDED.auto_provision,
            default_role     = EXCLUDED.default_role,
            updated_at       = NOW()`,
        [
          req.user.workspaceId, !!enabled, idp_entity_id, idp_sso_url, idp_slo_url || null, idp_cert,
          attribute_email, attribute_name, attribute_groups || null,
          !!auto_provision, default_role, req.user.id,
        ],
      );
      // Bust the in-process @node-saml client cache so the next
      // login picks up these changes without a restart.
      invalidateSamlCache(req.user.workspaceId);
      await auditLog({
        req, action: "saml_config.upsert",
        resource: { type: "workspace", id: req.user.workspaceId },
        metadata: { enabled: !!enabled, idp_entity_id, autoProvision: !!auto_provision, defaultRole: default_role },
      });
      res.json({ ok: true, enabled: !!enabled });
    } catch (e) { next(e); }
  },
);

router.delete("/",
  requirePermission(PERM),
  async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM saml_configs WHERE workspace_id = $1`,
        [req.user.workspaceId],
      );
      invalidateSamlCache(req.user.workspaceId);
      await auditLog({
        req, action: "saml_config.delete",
        resource: { type: "workspace", id: req.user.workspaceId },
      });
      res.json({ removed: rowCount > 0 });
    } catch (e) { next(e); }
  },
);

// ────────────────────────────────────────────────────────────────────
// POST /saml-config/import — parse an IdP metadata XML to pre-fill
// the form. We don't auto-save; the admin sees the parsed fields and
// hits Save when happy. Catches the common case of "Okta gave me a
// 2000-line XML, I don't want to hand-extract three fields."
// ────────────────────────────────────────────────────────────────────
router.post("/import",
  requirePermission(PERM),
  async (req, res, next) => {
    try {
      const xml = req.body?.metadataXml;
      if (!xml || typeof xml !== "string") {
        throw new ValidationError("body.metadataXml is required");
      }
      // Tiny regex parser. The IdP metadata spec is verbose XML but
      // the three fields we want are predictable. Avoids pulling in
      // a full XML parser dep when this is the only spot that needs
      // one. If it ever proves brittle, swap to `fast-xml-parser`.
      const entityId   = match(/entityID="([^"]+)"/, xml);
      // Prefer HTTP-POST binding URL when present; fall back to
      // HTTP-Redirect. Most IdPs publish both.
      const ssoUrl = match(/Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-POST"\s+Location="([^"]+)"/, xml)
                  || match(/SingleSignOnService[^>]*Location="([^"]+)"/, xml);
      // Pull the first signing certificate. Strip whitespace inside;
      // wrap in PEM headers because IdP metadata usually ships it
      // bare (base64 only, no markers).
      const certBody = match(/<(?:ds:)?X509Certificate[^>]*>\s*([^<]+?)\s*<\/(?:ds:)?X509Certificate>/, xml);
      const cert = certBody
        ? `-----BEGIN CERTIFICATE-----\n${certBody.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`
        : null;
      const sloUrl = match(/SingleLogoutService[^>]*Location="([^"]+)"/, xml);

      res.json({
        idp_entity_id: entityId || null,
        idp_sso_url:   ssoUrl   || null,
        idp_slo_url:   sloUrl   || null,
        idp_cert:      cert     || null,
        warnings: [
          entityId ? null : "entityID not found in metadata",
          ssoUrl   ? null : "no SingleSignOnService Location found",
          cert     ? null : "no X509Certificate found",
        ].filter(Boolean),
      });
    } catch (e) { next(e); }
  },
);

function match(re, s) {
  const m = re.exec(s);
  return m ? m[1] : null;
}

export default router;
