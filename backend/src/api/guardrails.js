// Guardrails REST API.
//
// Endpoints (all project-scoped):
//
//   GET    /guardrails/detectors            — catalog (drives the policy editor)
//   GET    /guardrails/policy               — current project policy (with defaults filled in)
//   PUT    /guardrails/policy               — upsert project policy; evicts the cache
//   GET    /guardrails/violations           — paginated audit log
//   POST   /guardrails/test                 — try a string against a policy without persisting
//
// Permissions:
//   guardrails.read   — list policy, list violations, run test (editors + admins)
//   guardrails.write  — upsert policy (project admins + workspace admins)
//
// The agent-level override is part of the agents row (column
// `guardrails_override`) — managed by the existing /agents PUT, not
// here.

import { Router } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../db/pool.js";
import { ValidationError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

import { listDetectors } from "../guardrails/detectors/index.js";
import {
  DEFAULT_POLICY,
  loadProjectPolicy,
  evictPolicyCache,
  applyGuardrails,
} from "../guardrails/apply.js";

const router = Router();
router.use(requireUser);

// Catalog endpoint — public to authenticated users. The editor UI
// hits it once on open and uses it to render each detector's fields.
router.get("/detectors", (_req, res) => {
  res.json({
    detectors: listDetectors(),
    defaultPolicy: DEFAULT_POLICY,
    applyToOptions: ["input", "output", "both", "none"],
  });
});

router.use(requireProject);

const APPLY_TO_VALUES = new Set(["input", "output", "both", "none"]);
const DETECTOR_MODES  = {
  pii:       new Set(["redact", "block", "warn"]),
  toxicity:  new Set(["block", "warn"]),     // redact degrades to warn (see apply.js)
  jailbreak: new Set(["block", "warn"]),
};

// ─────────────────────────────────────────────────────────────
// GET /guardrails/policy — returns the resolved policy. If no row
// exists yet, returns DEFAULT_POLICY so the UI has something to
// edit. Marker `_isDefault` lets the UI render a "not saved yet"
// state.
// ─────────────────────────────────────────────────────────────
router.get(
  "/policy",
  requirePermission("guardrails.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, apply_to, config, updated_by, updated_at
           FROM guardrail_policies
          WHERE workspace_id = $1 AND project_id = $2`,
        [req.user.workspaceId, req.user.projectId],
      );
      if (!rows[0]) {
        return res.json({ ...DEFAULT_POLICY, _isDefault: true });
      }
      res.json({
        id:         rows[0].id,
        apply_to:   rows[0].apply_to,
        config:     rows[0].config || {},
        updated_at: rows[0].updated_at,
        updated_by: rows[0].updated_by,
        _isDefault: false,
      });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// PUT /guardrails/policy — upsert. Body:
//   { apply_to: "both"|"input"|"output"|"none",
//     config:   { pii: {...}, toxicity: {...}, jailbreak: {...} } }
// ─────────────────────────────────────────────────────────────
router.put(
  "/policy",
  requirePermission("guardrails.write"),
  async (req, res, next) => {
    try {
      const body     = req.body || {};
      const applyTo  = String(body.apply_to || "both");
      if (!APPLY_TO_VALUES.has(applyTo)) {
        throw new ValidationError(`apply_to must be one of ${[...APPLY_TO_VALUES].join(", ")}`);
      }
      const config = sanitiseConfig(body.config);

      // Phase F: compliance floor. Modes like HIPAA require certain
      // detectors to be enabled at certain modes (PII redact ON).
      // Refuse a save that drops below the floor.
      {
        const { loadWorkspaceCompliance, assertGuardrailFloor }
          = await import("../compliance/enforce.js");
        const ws = await loadWorkspaceCompliance(req.user.workspaceId);
        try { assertGuardrailFloor(ws, config); }
        catch (e) {
          if (e.code === "COMPLIANCE_BLOCKED") throw new ValidationError(e.message);
          throw e;
        }
      }

      // Insert-or-update. The unique constraint
      // (workspace_id, project_id) guarantees a single row per project.
      const id = randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO guardrail_policies
           (id, workspace_id, project_id, apply_to, config, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,NOW())
         ON CONFLICT (workspace_id, project_id) DO UPDATE
            SET apply_to   = EXCLUDED.apply_to,
                config     = EXCLUDED.config,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
         RETURNING id, apply_to, config, updated_at, updated_by`,
        [
          id, req.user.workspaceId, req.user.projectId,
          applyTo, JSON.stringify(config), req.user.id || null,
        ],
      );

      // Cached policy is now stale — force the next agent call to
      // re-load. Without this an operator's "PII redact ON" change
      // wouldn't take effect for 30 s.
      evictPolicyCache(req.user.projectId);

      await auditLog({
        req, action: "guardrails.policy.set",
        resource: { type: "guardrail_policy", id: rows[0].id },
        projectId: req.user.projectId,
        metadata: { apply_to: applyTo, enabled: enabledList(config) },
      });

      res.json({ ...rows[0], _isDefault: false });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// GET /guardrails/violations — paginated audit feed for the
// project. ?limit=… (default 100, max 500), ?cursor=… is the
// created_at of the last seen row (keyset pagination).
// ─────────────────────────────────────────────────────────────
router.get(
  "/violations",
  requirePermission("guardrails.read"),
  async (req, res, next) => {
    try {
      const limit  = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const cursor = req.query.cursor ? new Date(req.query.cursor) : null;
      const detector = req.query.detector || null;
      const side     = req.query.side || null;

      const params = [req.user.workspaceId, req.user.projectId];
      const where  = [`workspace_id = $1`, `project_id = $2`];
      if (cursor)   { params.push(cursor);   where.push(`created_at < $${params.length}`); }
      if (detector) { params.push(detector); where.push(`detector = $${params.length}`); }
      if (side)     { params.push(side);     where.push(`side = $${params.length}`); }

      params.push(limit);
      const { rows } = await pool.query(
        `SELECT id, execution_id, node, agent_id, agent_title,
                side, detector, mode, action_taken, details, created_at
           FROM guardrail_violations
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      // Next cursor = the timestamp of the last row in the page, so
      // the client can fetch the next page with ?cursor=<ts>.
      const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;
      res.json({ rows, nextCursor });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// POST /guardrails/test — try a string against the current policy
// (or an explicit policy passed in the body). Used by the editor's
// "Try it" panel so admins can sanity-check a rule before saving.
// ─────────────────────────────────────────────────────────────
router.post(
  "/test",
  requirePermission("guardrails.read"),
  async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const side = (req.body?.side === "output") ? "output" : "input";
      // Prefer the explicit policy when supplied (the editor sends
      // the in-progress form so the user sees results from unsaved
      // changes); otherwise load the persisted policy.
      const policy = req.body?.policy
        ? { apply_to: req.body.policy.apply_to || "both", config: sanitiseConfig(req.body.policy.config) }
        : await loadProjectPolicy(req.user.projectId);

      let result;
      try {
        result = await applyGuardrails({ text, side, policy });
      } catch (e) {
        if (e.code === "GUARDRAIL_BLOCKED") {
          return res.json({
            blocked:    true,
            detector:   e.detector,
            details:    e.details,
            text:       null,
            violations: [{ detector: e.detector, side: e.side, mode: "block", action_taken: "blocked" }],
          });
        }
        throw e;
      }
      res.json({ blocked: false, text: result.text, violations: result.violations });
    } catch (e) { next(e); }
  },
);

// ─── helpers ────────────────────────────────────────────────────

/**
 * Normalise the per-detector config the API receives. Anything outside
 * the known detectors is dropped; unknown modes are rejected.
 *
 * We deliberately don't reject "extra" fields inside a detector's
 * config (e.g. `types` for PII) — those let users tune the detector
 * without us having to chase schema changes here.
 */
function sanitiseConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const name of ["pii", "toxicity", "jailbreak"]) {
    const d = raw[name];
    if (!d || typeof d !== "object") continue;
    const mode = d.mode || (DETECTOR_MODES[name].has("warn") ? "warn" : "block");
    if (!DETECTOR_MODES[name].has(mode)) {
      throw new ValidationError(`detector "${name}": mode "${mode}" not valid; choose ${[...DETECTOR_MODES[name]].join(", ")}`);
    }
    out[name] = {
      enabled: !!d.enabled,
      mode,
      // Detector-specific fields — pass through verbatim.
      ...(name === "pii"      && Array.isArray(d.types)      ? { types: d.types } : {}),
      ...(name === "toxicity" && Array.isArray(d.categories) ? { categories: d.categories } : {}),
      ...(name === "toxicity" && d.model                     ? { model: String(d.model) } : {}),
      ...((name === "toxicity" || name === "jailbreak") && d.threshold != null
                                                            ? { threshold: clamp01(d.threshold) } : {}),
    };
  }
  return out;
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function enabledList(config) {
  return Object.entries(config).filter(([, v]) => v?.enabled).map(([k]) => k);
}

export default router;
