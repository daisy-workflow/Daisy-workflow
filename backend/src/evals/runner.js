// Eval suite runner.
//
// Reads a suite + its cases, calls the suite's bound agent once per
// case, runs each case's configured scorers against the output, and
// persists per-case eval_results plus a final aggregated eval_runs
// row.
//
// Direct provider invocation:
//   We call util.callProvider() rather than the `agent` workflow plugin
//   so the runner stays decoupled from the executor — no synthetic
//   ctx wiring, no streaming hooks, no quota pre-check (the eval is
//   intentionally a separate "test" mode). Embedding the call here
//   also lets us measure per-case latency cleanly.
//
// Cost rollup:
//   Same agent_token_events table the production agent calls write to,
//   so eval spend shows up alongside live spend on the Quotas page.
//   The agent_title carries an "[eval] " prefix so admins can split
//   it out at a glance.

import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

import { loadAgent, callProvider, tryParseJson } from "../plugins/agent/util.js";
import { loadConfigsMap } from "../configs/loader.js";
import { render as renderPrompt } from "../prompts/render.js";
import { getScorer } from "./scorers/index.js";
import { recordAgentTokenEvent } from "../plugins/agent/usage.js";
import { costMicros } from "../plugins/agent/pricing.js";

const MAX_OUTPUT_TEXT_BYTES = 64 * 1024;

/**
 * Run a suite. Synchronous from the API caller's point of view:
 * the POST /eval-suites/:id/runs blocks until all cases finish.
 *
 * For very large suites the future move is to push onto BullMQ and
 * have the API return a run id immediately, but the synchronous
 * model is enough for the typical "20-100 cases" suite.
 */
export async function runSuite({ suiteId, userId, workspaceId, projectId }) {
  const suite = await loadSuite(suiteId, workspaceId, projectId);
  if (!suite) throw new Error(`eval suite not found: ${suiteId}`);
  if (!suite.agent_title) throw new Error(`eval suite ${suiteId} is not bound to an agent`);

  const cases = await loadCases(suite.id);
  if (cases.length === 0) throw new Error(`eval suite "${suite.title}" has no cases`);

  // Build a configs map so loadAgent + the llm_judge scorer can
  // resolve provider credentials by name. Same shape the worker
  // produces for live executions.
  const configsMap = await loadConfigsMap(workspaceId, projectId);
  const ctx = {
    config: configsMap,
    execution: { id: null, workspaceId, projectId, graphId: null },
  };

  const runId = randomUUID();
  await pool.query(
    `INSERT INTO eval_runs
       (id, workspace_id, project_id, suite_id, agent_id, status, created_by)
     VALUES ($1,$2,$3,$4,$5,'running',$6)`,
    [runId, workspaceId, projectId, suite.id, suite.agent_id, userId || null],
  );

  const startedAt = Date.now();
  let passed = 0, failed = 0, totalTokensIn = 0, totalTokensOut = 0, totalCostMicros = 0;
  let scoreSum = 0, scoreWeight = 0;

  try {
    for (const c of cases) {
      // We catch per-case so one failure doesn't abort the suite.
      try {
        const r = await runOneCase({ suite, kase: c, ctx, runId, workspaceId, projectId });
        if (r.status === "passed") passed++; else failed++;
        totalTokensIn   += r.input_tokens  || 0;
        totalTokensOut  += r.output_tokens || 0;
        totalCostMicros += r.cost_micros   || 0;
        scoreSum        += (r.score ?? 0) * (r.totalWeight || 1);
        scoreWeight     += (r.totalWeight || 1);
      } catch (e) {
        failed++;
        // Persist a sentinel result so the UI shows the case errored
        // (and the reason) instead of silently disappearing from the
        // run.
        await pool.query(
          `INSERT INTO eval_results
             (id, run_id, case_id, case_title, status, output_text,
              scorer_results, score, error)
           VALUES ($1,$2,$3,$4,'errored',NULL,'[]'::jsonb,NULL,$5)`,
          [randomUUID(), runId, c.id, c.title, e.message.slice(0, 1000)],
        );
        log.warn("eval case errored", { runId, caseId: c.id, error: e.message });
      }
    }

    const totals = {
      passed,
      failed,
      score:           scoreWeight > 0 ? Number((scoreSum / scoreWeight).toFixed(4)) : 0,
      totalTokens:     totalTokensIn + totalTokensOut,
      totalInputTokens: totalTokensIn,
      totalOutputTokens: totalTokensOut,
      totalCostMicros,
      durationMs:      Date.now() - startedAt,
    };
    await pool.query(
      `UPDATE eval_runs
          SET status='complete', totals=$2::jsonb, finished_at=NOW()
        WHERE id=$1`,
      [runId, JSON.stringify(totals)],
    );
    return { runId, totals };
  } catch (e) {
    await pool.query(
      `UPDATE eval_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
      [runId, e.message.slice(0, 1000)],
    );
    throw e;
  }
}

// ─── one case ────────────────────────────────────────────────────

async function runOneCase({ suite, kase, ctx, runId, workspaceId, projectId }) {
  const { input: inputText, vars } = normaliseCaseInputs(kase.inputs);

  // Re-use the live agent plumbing — load the agent + cfg, optionally
  // render its template, then call the provider.
  const { agent, cfg } = await loadAgent(ctx, suite.agent_title);
  const systemPrompt = agent.template_body
    ? renderPrompt(agent.template_body, { ...(vars || {}), input: inputText, agent: agent.title })
    : agent.prompt;

  const t0 = Date.now();
  let providerOut;
  try {
    providerOut = await callProvider({
      cfg,
      system:    systemPrompt,
      messages:  [{ role: "user", content: String(inputText ?? "") }],
      maxTokens: kase.inputs?.maxTokens || 2048,
    });
  } catch (e) {
    // Provider failure → record the result row as errored, don't
    // attempt to score, surface back to the caller for run totals.
    await pool.query(
      `INSERT INTO eval_results
         (id, run_id, case_id, case_title, status, output_text,
          scorer_results, score, latency_ms, error)
       VALUES ($1,$2,$3,$4,'errored',NULL,'[]'::jsonb,NULL,$5,$6)`,
      [randomUUID(), runId, kase.id, kase.title, Date.now() - t0,
       `provider call failed: ${e.message}`.slice(0, 1000)],
    );
    return { status: "errored", input_tokens: 0, output_tokens: 0, cost_micros: 0 };
  }
  const latencyMs = Date.now() - t0;
  const outputText = String(providerOut.text ?? "");
  const inTok      = providerOut.usage?.inputTokens  || 0;
  const outTok     = providerOut.usage?.outputTokens || 0;
  const cost       = costMicros({
    provider: cfg.provider, model: cfg.model,
    inputTokens: inTok, outputTokens: outTok,
  });

  // Mirror the spend in agent_token_events so the Quotas page picks
  // up eval runs alongside live calls. The "[eval]" prefix on the
  // agent_title makes them easy to filter out for production charts.
  recordAgentTokenEvent({
    workspaceId, projectId,
    executionId: null,
    agentId:     agent.id,
    agentTitle:  `[eval] ${agent.title}`,
    provider:    cfg.provider,
    model:       cfg.model,
    inputTokens: inTok,
    outputTokens: outTok,
    cacheHit:    false,
    latencyMs,
  }).catch(() => {});

  // Run the scorers. Each scorer returns { passed, score, details };
  // we collapse the array to a weighted average for the case score.
  const scorerResults = [];
  let totalScore = 0, totalWeight = 0;
  for (const sc of kase.scorers || []) {
    const def = getScorerSafe(sc.type);
    if (!def) {
      scorerResults.push({ type: sc.type, passed: false, score: 0, weight: sc.weight || 1, details: { error: `unknown scorer "${sc.type}"` } });
      continue;
    }
    let res;
    try {
      // Pre-parse `output` for the json scorer if the agent returned
      // valid JSON — saves the scorer from re-parsing + makes "json"
      // work on agents whose `tryParseJson` already worked at the
      // workflow level.
      const outForScorer = sc.type === "json" ? (tryParseJson(outputText) ?? outputText) : outputText;
      res = await def.score({
        output:   outForScorer,
        expected: pickExpected(kase.expected, sc.type),
        config:   sc.config || {},
        ctx,
      });
    } catch (e) {
      res = { passed: false, score: 0, details: { error: e.message } };
    }
    const weight = sc.weight ?? 1;
    scorerResults.push({ type: sc.type, weight, ...res });
    totalScore  += (res.score || 0) * weight;
    totalWeight += weight;
  }

  // Pass = ALL scorers passed. Strict but matches what "regression
  // test" usually means in eval land.
  const passedCase = scorerResults.length > 0
    && scorerResults.every(r => r.passed);
  const caseScore  = totalWeight > 0 ? Number((totalScore / totalWeight).toFixed(4)) : 0;

  await pool.query(
    `INSERT INTO eval_results
       (id, run_id, case_id, case_title, status, output_text,
        scorer_results, score, latency_ms, input_tokens, output_tokens, cost_micros)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
    [
      randomUUID(), runId, kase.id, kase.title,
      passedCase ? "passed" : "failed",
      truncate(outputText, MAX_OUTPUT_TEXT_BYTES),
      JSON.stringify(scorerResults),
      caseScore, latencyMs, inTok, outTok, cost,
    ],
  );

  return {
    status: passedCase ? "passed" : "failed",
    score: caseScore,
    totalWeight,
    input_tokens: inTok, output_tokens: outTok, cost_micros: cost,
  };
}

// ─── helpers ───────────────────────────────────────────────────

async function loadSuite(id, workspaceId, projectId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.agent_id, s.workspace_id, s.project_id,
            a.title AS agent_title
       FROM eval_suites s
       LEFT JOIN agents a ON a.id = s.agent_id
      WHERE s.id = $1 AND s.workspace_id = $2 AND s.project_id = $3`,
    [id, workspaceId, projectId],
  );
  return rows[0] || null;
}

async function loadCases(suiteId) {
  const { rows } = await pool.query(
    `SELECT id, title, inputs, expected, scorers, position
       FROM eval_cases
      WHERE suite_id = $1
      ORDER BY position, created_at`,
    [suiteId],
  );
  return rows;
}

/** A case's `inputs` can be either a string (treated as the agent
 *  input text) or an object { input, vars, maxTokens }. */
function normaliseCaseInputs(raw) {
  if (typeof raw === "string") return { input: raw, vars: {} };
  if (raw && typeof raw === "object") {
    return {
      input: raw.input ?? "",
      vars:  raw.vars  ?? {},
    };
  }
  return { input: "", vars: {} };
}

/** Pick the per-scorer expected blob from the case's `expected`
 *  field. Two layouts accepted:
 *    1. flat:  { exact: "...", contains: [...], regex: "..." }   ← per-type
 *    2. nested: { reference: "...", criteria: "...", requiredKeys: [...] } ← shared blob
 *  We try the per-type key first, fall back to the whole blob. */
function pickExpected(expectedBlob, type) {
  if (!expectedBlob || typeof expectedBlob !== "object") return undefined;
  return expectedBlob[type] !== undefined ? expectedBlob[type] : expectedBlob;
}

function getScorerSafe(name) {
  try { return getScorer(name); }
  catch { return null; }
}

function truncate(s, limit) {
  if (!s) return s;
  return s.length > limit ? s.slice(0, limit) + "\n…[truncated]" : s;
}
