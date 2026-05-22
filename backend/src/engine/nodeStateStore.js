// Postgres-backed durable per-node state.
//
// One row per (executionId, nodeName). The executor calls upsertNodeState
// on every lifecycle transition through its persistNodeState hook; the
// resume path reads loadNodeStates back to rehydrate ctx.nodes.

import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

/**
 * Upsert the node's current durable state. Partial updates are supported:
 * COALESCE preserves whatever was already in the row, so calling with
 * `{status:"running", startedAt}` followed later by `{status:"success",
 * output}` correctly accumulates.
 *
 * resolvedInputs is intentionally captured at RUNNING (not at SUCCESS) so
 * the InstanceViewer's "Edit data and resume" flow can read what the
 * plugin was actually given on the failing attempt.
 */
export async function upsertNodeState(executionId, nodeName, partial) {
  if (!executionId || !nodeName) return;
  const status      = partial.status         ?? null;
  const attempts    = partial.attempts       ?? null;
  const inputs      = partial.resolvedInputs !== undefined ? JSON.stringify(partial.resolvedInputs) : null;
  const output      = partial.output !== undefined && partial.output !== null
                        ? JSON.stringify(partial.output) : null;
  const error       = partial.error          ?? null;
  const reason      = partial.reason         ?? null;
  const startedAt   = partial.startedAt      ?? null;
  const finishedAt  = partial.finishedAt     ?? null;

  // attempts is nullable on the table (see migration 011) so this passes
  // even when the caller didn't supply one. Each lifecycle write uses the
  // same upsert; COALESCE ensures partial writes (RUNNING with no
  // attempts, then FAILED with attempts) compose correctly without
  // wiping prior fields.
  //
  // project_id was made NOT NULL by migration 021 but the callers of
  // upsertNodeState don't all have it handy. We source it from the
  // existing executions row via a scalar subquery — the executions
  // row is always inserted + enqueued before any node ever runs, so
  // the subquery resolves to a real value on the first INSERT. On
  // CONFLICT the column is left untouched (it never changes mid-run).
  await pool.query(
    `INSERT INTO node_states
        (execution_id, node_name, project_id, status, attempts, resolved_inputs,
         output, error, reason, started_at, finished_at, updated_at)
     VALUES (
        $1, $2,
        (SELECT project_id FROM executions WHERE id = $1),
        $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, NOW()
     )
     ON CONFLICT (execution_id, node_name) DO UPDATE SET
        status          = COALESCE(EXCLUDED.status,          node_states.status),
        attempts        = COALESCE(EXCLUDED.attempts,        node_states.attempts),
        resolved_inputs = COALESCE(EXCLUDED.resolved_inputs, node_states.resolved_inputs),
        output          = COALESCE(EXCLUDED.output,          node_states.output),
        error           = COALESCE(EXCLUDED.error,           node_states.error),
        reason          = COALESCE(EXCLUDED.reason,          node_states.reason),
        started_at      = COALESCE(node_states.started_at,   EXCLUDED.started_at),
        finished_at     = COALESCE(EXCLUDED.finished_at,     node_states.finished_at),
        updated_at      = NOW()`,
    [executionId, nodeName, status, attempts, inputs, output, error, reason, startedAt, finishedAt],
  );
}

/**
 * Read every node_states row for an execution and return them as a map
 * the executor's `initialNodeStates` opt expects.
 */
export async function loadNodeStates(executionId) {
  const { rows } = await pool.query(
    `SELECT node_name, status, attempts, resolved_inputs, output,
            error, reason, started_at, finished_at
       FROM node_states
       WHERE execution_id = $1`,
    [executionId],
  );
  const out = {};
  for (const r of rows) {
    out[r.node_name] = {
      status:     r.status,
      attempts:   r.attempts,
      output:     r.output,
      error:      r.error,
      reason:     r.reason,
      startedAt:  r.started_at ? new Date(r.started_at).toISOString()  : null,
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      // resolved_inputs is exposed via a separate fetcher used by the
      // resume API; the executor doesn't need it back for already-success
      // nodes (it only reads it when the user edits + resumes).
    };
  }
  return out;
}

/**
 * Read the resolved inputs the plugin saw on its last attempt. Used by
 * the InstanceViewer's "Edit data" surface so the user starts from the
 * inputs that actually failed, not the unresolved ${...} template.
 */
export async function loadResolvedInputs(executionId, nodeName) {
  const { rows } = await pool.query(
    "SELECT resolved_inputs FROM node_states WHERE execution_id=$1 AND node_name=$2",
    [executionId, nodeName],
  );
  return rows[0]?.resolved_inputs ?? null;
}

/**
 * Reset a single node back to "pending" so the next executor pass picks
 * it up. Used by both the resume path (failed → pending) and the skip
 * path (failed → skipped) — `targetStatus` chooses which.
 */
export async function resetNodeForReplay(executionId, nodeName, targetStatus = "pending") {
  await pool.query(
    `UPDATE node_states
        SET status      = $3,
            output      = NULL,
            error       = NULL,
            reason      = CASE WHEN $3 = 'skipped' THEN 'skipped via resume' ELSE NULL END,
            finished_at = NULL,
            updated_at  = NOW()
      WHERE execution_id = $1 AND node_name = $2`,
    [executionId, nodeName, targetStatus],
  );
}

/**
 * Worker boot housekeeping: any execution row left in `running` is by
 * definition orphaned (no live worker is processing it), because the
 * worker queue has just started and hasn't picked up anything yet. Mark
 * them failed so the UI doesn't show a stuck spinner forever, and so
 * the user can resume them deliberately through the InstanceViewer.
 *
 * Exception: executions still listed by BullMQ as active jobs are
 * legitimately in flight (e.g. another worker on the same Redis is
 * processing them). The caller passes those ids in `activeExecutionIds`
 * to spare them.
 */
export async function reapOrphanedExecutions(activeExecutionIds = []) {
  const params = [];
  let exclude = "";
  if (activeExecutionIds.length) {
    params.push(activeExecutionIds);
    exclude = `AND id <> ALL($1::uuid[])`;
  }
  // 'waiting' executions are deliberately paused until a responder
  // POSTs JSON; we leave them alone. Only 'running' rows orphaned by a
  // worker crash should be marked failed.
  const { rows } = await pool.query(
    `UPDATE executions
        SET status      = 'failed',
            finished_at = NOW(),
            error       = COALESCE(error, 'worker crashed before completion (auto-reaped on boot)')
      WHERE status = 'running' ${exclude}
      RETURNING id`,
    params,
  );
  if (rows.length) {
    log.warn("reaped orphaned executions", { count: rows.length });
    // Also mark each lingering RUNNING node as FAILED so the resume UX
    // has a single failed node to attach the Resume / Skip buttons to.
    await pool.query(
      `UPDATE node_states
          SET status      = 'failed',
              error       = COALESCE(error, 'worker crashed mid-node'),
              finished_at = NOW(),
              updated_at  = NOW()
        WHERE status = 'running'
          AND execution_id = ANY($1::uuid[])`,
      [rows.map(r => r.id)],
    );
  }
  return rows.map(r => r.id);
}
