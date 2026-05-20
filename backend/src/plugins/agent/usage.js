// Per-call agent usage recording — feeds the agent_token_events
// table that backs the per-model / per-agent breakdowns on the
// Quotas page.
//
// Append-only; failures are swallowed because metering must not
// fail user workflows. The agent plugin calls this via dynamic
// import from inside its post-call block — late binding keeps the
// boot-time dependency graph clean.

import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool.js";
import { costMicros } from "./pricing.js";
import { log } from "../../utils/logger.js";

/**
 * Insert one row into agent_token_events.
 *
 * @param {object} ev
 * @param {string} ev.workspaceId
 * @param {string} ev.projectId
 * @param {string} [ev.executionId]
 * @param {string} [ev.agentId]
 * @param {string} [ev.agentTitle]
 * @param {string} ev.provider
 * @param {string} ev.model
 * @param {number} ev.inputTokens
 * @param {number} ev.outputTokens
 * @param {boolean} [ev.cacheHit]
 * @param {number} [ev.latencyMs]
 */
export async function recordAgentTokenEvent(ev) {
  if (!ev?.workspaceId || !ev?.projectId) return;
  try {
    // Cache hits cost zero — the row records what would have been
    // spent (so admins can see "you saved $X this month from the
    // cache") via the input/output token counts, but cost_micros is
    // explicitly 0.
    const cost = ev.cacheHit ? 0 : costMicros({
      provider:     ev.provider,
      model:        ev.model,
      inputTokens:  ev.inputTokens,
      outputTokens: ev.outputTokens,
    });
    await pool.query(
      `INSERT INTO agent_token_events
         (id, workspace_id, project_id, execution_id, agent_id, agent_title,
          provider, model, input_tokens, output_tokens, cost_micros,
          cache_hit, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        randomUUID(),
        ev.workspaceId, ev.projectId, ev.executionId || null,
        ev.agentId || null, ev.agentTitle || null,
        ev.provider, ev.model,
        Number(ev.inputTokens)  || 0,
        Number(ev.outputTokens) || 0,
        cost,
        !!ev.cacheHit,
        Number.isFinite(ev.latencyMs) ? ev.latencyMs : null,
      ],
    );
  } catch (e) {
    log.warn("agent_token_events insert failed (swallowed)", { error: e.message });
  }
}
