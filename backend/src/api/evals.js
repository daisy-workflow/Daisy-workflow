// Evals REST API.
//
// Endpoints (project-scoped):
//
//   GET    /evals/scorers                       — scorer catalog
//
//   Suites:
//   GET    /evals/suites                         — list suites
//   POST   /evals/suites                         — create
//   GET    /evals/suites/:id                     — fetch one (+ case count)
//   PUT    /evals/suites/:id                     — update
//   DELETE /evals/suites/:id                     — delete (cascades cases + runs)
//
//   Cases (nested under suite):
//   GET    /evals/suites/:suiteId/cases          — list
//   POST   /evals/suites/:suiteId/cases          — create
//   PUT    /evals/suites/:suiteId/cases/:caseId  — update
//   DELETE /evals/suites/:suiteId/cases/:caseId  — delete
//
//   Runs:
//   POST   /evals/suites/:suiteId/runs           — start a run (synchronous, returns the finished run)
//   GET    /evals/suites/:suiteId/runs           — list runs for the suite
//   GET    /evals/runs/:runId                    — fetch one run
//   GET    /evals/runs/:runId/results            — per-case results
//
// Permissions:
//   eval.read   — list / get
//   eval.write  — create / update / delete suites + cases, and start runs

import { Router } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

import { listScorers, getScorer } from "../evals/scorers/index.js";
import { runSuite } from "../evals/runner.js";

const router = Router();
router.use(requireUser);

// Scorer catalog — project-agnostic.
router.get("/scorers", (_req, res) => {
  res.json(listScorers());
});

router.use(requireProject);

// ─── Suites CRUD ───────────────────────────────────────────────
router.get("/suites",
  requirePermission("eval.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.title, s.description, s.agent_id,
                a.title AS agent_title,
                COUNT(c.id)::int AS case_count,
                s.created_at, s.updated_at
           FROM eval_suites s
           LEFT JOIN agents a    ON a.id = s.agent_id
           LEFT JOIN eval_cases c ON c.suite_id = s.id
          WHERE s.workspace_id = $1 AND s.project_id = $2
          GROUP BY s.id, a.title
          ORDER BY s.title`,
        [req.user.workspaceId, req.user.projectId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post("/suites",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      const { title, description, agent_id } = req.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        throw new ValidationError("title is required");
      }
      const id = randomUUID();
      try {
        await pool.query(
          `INSERT INTO eval_suites (id, workspace_id, project_id, title, description, agent_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, req.user.workspaceId, req.user.projectId,
           title.trim(), description || null, agent_id || null, req.user.id || null],
        );
      } catch (e) {
        if (e.code === "23505") throw new ValidationError(`an eval suite titled "${title}" already exists`);
        throw e;
      }
      await auditLog({
        req, action: "eval.suite.create",
        resource: { type: "eval_suite", id, name: title.trim() },
        projectId: req.user.projectId,
      });
      res.status(201).json({ id });
    } catch (e) { next(e); }
  },
);

router.get("/suites/:id",
  requirePermission("eval.read"),
  async (req, res, next) => {
    try {
      const suite = await loadSuiteAndAuth(req);
      res.json(suite);
    } catch (e) { next(e); }
  },
);

router.put("/suites/:id",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuth(req);
      const { title, description, agent_id } = req.body || {};
      const updates = [], params = [req.params.id, req.user.workspaceId, req.user.projectId];
      if (title !== undefined) {
        if (!String(title).trim()) throw new ValidationError("title cannot be blank");
        params.push(String(title).trim()); updates.push(`title = $${params.length}`);
      }
      if (description !== undefined) {
        params.push(description || null); updates.push(`description = $${params.length}`);
      }
      if (agent_id !== undefined) {
        params.push(agent_id || null); updates.push(`agent_id = $${params.length}`);
      }
      if (!updates.length) return res.json({ ok: true });
      updates.push("updated_at = NOW()");
      const r = await pool.query(
        `UPDATE eval_suites SET ${updates.join(", ")}
          WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        params,
      );
      if (!r.rowCount) throw new NotFoundError("eval suite");
      await auditLog({
        req, action: "eval.suite.update",
        resource: { type: "eval_suite", id: req.params.id },
        projectId: req.user.projectId,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

router.delete("/suites/:id",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuth(req);
      await pool.query(
        `DELETE FROM eval_suites WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        [req.params.id, req.user.workspaceId, req.user.projectId],
      );
      await auditLog({
        req, action: "eval.suite.delete",
        resource: { type: "eval_suite", id: req.params.id },
        projectId: req.user.projectId,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─── Cases CRUD (nested under suite) ──────────────────────────
router.get("/suites/:suiteId/cases",
  requirePermission("eval.read"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuthBySuiteId(req);
      const { rows } = await pool.query(
        `SELECT id, title, inputs, expected, scorers, position, created_at, updated_at
           FROM eval_cases
          WHERE suite_id = $1
          ORDER BY position, created_at`,
        [req.params.suiteId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post("/suites/:suiteId/cases",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuthBySuiteId(req);
      const { title, inputs, expected, scorers, position } = req.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        throw new ValidationError("title is required");
      }
      validateScorerList(scorers);

      const id = randomUUID();
      await pool.query(
        `INSERT INTO eval_cases
           (id, suite_id, title, inputs, expected, scorers, position)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)`,
        [
          id, req.params.suiteId, title.trim(),
          JSON.stringify(inputs   || {}),
          JSON.stringify(expected || {}),
          JSON.stringify(scorers  || []),
          Number.isFinite(position) ? position : 0,
        ],
      );
      res.status(201).json({ id });
    } catch (e) { next(e); }
  },
);

router.put("/suites/:suiteId/cases/:caseId",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuthBySuiteId(req);
      const { title, inputs, expected, scorers, position } = req.body || {};
      if (scorers !== undefined) validateScorerList(scorers);

      const updates = [], params = [req.params.caseId, req.params.suiteId];
      if (title    !== undefined) { params.push(String(title).trim());  updates.push(`title = $${params.length}`); }
      if (inputs   !== undefined) { params.push(JSON.stringify(inputs));   updates.push(`inputs = $${params.length}::jsonb`); }
      if (expected !== undefined) { params.push(JSON.stringify(expected)); updates.push(`expected = $${params.length}::jsonb`); }
      if (scorers  !== undefined) { params.push(JSON.stringify(scorers));  updates.push(`scorers = $${params.length}::jsonb`); }
      if (position !== undefined) { params.push(Number(position) || 0);    updates.push(`position = $${params.length}`); }
      if (!updates.length) return res.json({ ok: true });
      updates.push("updated_at = NOW()");
      const r = await pool.query(
        `UPDATE eval_cases SET ${updates.join(", ")}
          WHERE id=$1 AND suite_id=$2`,
        params,
      );
      if (!r.rowCount) throw new NotFoundError("eval case");
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

router.delete("/suites/:suiteId/cases/:caseId",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuthBySuiteId(req);
      const r = await pool.query(
        `DELETE FROM eval_cases WHERE id=$1 AND suite_id=$2`,
        [req.params.caseId, req.params.suiteId],
      );
      if (!r.rowCount) throw new NotFoundError("eval case");
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─── Runs ──────────────────────────────────────────────────────
router.post("/suites/:suiteId/runs",
  requirePermission("eval.write"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuthBySuiteId(req);
      // Synchronous — the API blocks until the suite finishes. For
      // long-running suites the future move is an async job + poll,
      // but for the typical "20-100 cases" suite this stays under
      // a few minutes and avoids the polling UI.
      const result = await runSuite({
        suiteId:     req.params.suiteId,
        userId:      req.user.id,
        workspaceId: req.user.workspaceId,
        projectId:   req.user.projectId,
      });
      await auditLog({
        req, action: "eval.run.start",
        resource: { type: "eval_run", id: result.runId },
        projectId: req.user.projectId,
        metadata: { suiteId: req.params.suiteId, totals: result.totals },
      });
      res.status(201).json(result);
    } catch (e) { next(e); }
  },
);

router.get("/suites/:suiteId/runs",
  requirePermission("eval.read"),
  async (req, res, next) => {
    try {
      await loadSuiteAndAuthBySuiteId(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const { rows } = await pool.query(
        `SELECT id, status, totals, started_at, finished_at, error
           FROM eval_runs
          WHERE suite_id = $1
          ORDER BY started_at DESC
          LIMIT $2`,
        [req.params.suiteId, limit],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.get("/runs/:runId",
  requirePermission("eval.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.*, s.title AS suite_title, a.title AS agent_title
           FROM eval_runs r
           JOIN eval_suites s ON s.id = r.suite_id
           LEFT JOIN agents a ON a.id = r.agent_id
          WHERE r.id = $1 AND r.workspace_id = $2 AND r.project_id = $3`,
        [req.params.runId, req.user.workspaceId, req.user.projectId],
      );
      if (!rows[0]) throw new NotFoundError("eval run");
      res.json(rows[0]);
    } catch (e) { next(e); }
  },
);

router.get("/runs/:runId/results",
  requirePermission("eval.read"),
  async (req, res, next) => {
    try {
      // Auth via the run row itself.
      const { rows: run } = await pool.query(
        `SELECT 1 FROM eval_runs
          WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        [req.params.runId, req.user.workspaceId, req.user.projectId],
      );
      if (!run[0]) throw new NotFoundError("eval run");
      const { rows } = await pool.query(
        `SELECT id, case_id, case_title, status, output_text,
                scorer_results, score, latency_ms,
                input_tokens, output_tokens, cost_micros, error, created_at
           FROM eval_results
          WHERE run_id = $1
          ORDER BY created_at`,
        [req.params.runId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

// ─── helpers ───────────────────────────────────────────────────

async function loadSuiteAndAuth(req) {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.description, s.agent_id,
            a.title AS agent_title, s.created_at, s.updated_at
       FROM eval_suites s
       LEFT JOIN agents a ON a.id = s.agent_id
      WHERE s.id = $1 AND s.workspace_id = $2 AND s.project_id = $3`,
    [req.params.id, req.user.workspaceId, req.user.projectId],
  );
  if (!rows[0]) throw new NotFoundError("eval suite");
  return rows[0];
}

async function loadSuiteAndAuthBySuiteId(req) {
  const { rows } = await pool.query(
    `SELECT id FROM eval_suites
      WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
    [req.params.suiteId, req.user.workspaceId, req.user.projectId],
  );
  if (!rows[0]) throw new NotFoundError("eval suite");
}

function validateScorerList(scorers) {
  if (scorers === undefined) return;
  if (!Array.isArray(scorers)) throw new ValidationError("scorers must be an array");
  for (const s of scorers) {
    if (!s?.type) throw new ValidationError("each scorer must carry a `type`");
    try { getScorer(s.type); }
    catch (e) { throw new ValidationError(e.message); }
  }
}

export default router;
