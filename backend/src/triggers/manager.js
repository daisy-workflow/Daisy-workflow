// Trigger lifecycle manager.
//
//   - On startup: load all enabled triggers from DB, call subscribe() on each.
//   - On fire: insert an execution row with payload as `inputs`, enqueue it.
//   - On API CRUD: keep the in-memory subscription map in sync.
//
// The manager is meant to live inside the worker process so triggers and the
// queue worker share the same lifetime.

import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { enqueueExecution } from "../queue/queue.js";
import { triggerRegistry } from "./registry.js";
import { log } from "../utils/logger.js";
import { resolve as resolveExpressions } from "../dsl/expression.js";
import { loadConfigsMap } from "../configs/loader.js";
import { normalizeTags } from "../utils/tags.js";

// triggerId -> { row, subscription, lastError }
const active = new Map();

/** Load every enabled trigger and start subscriptions. Idempotent. */
export async function startTriggerManager() {
  const { rows } = await pool.query(
    "SELECT * FROM triggers WHERE enabled = TRUE",
  );
  for (const row of rows) {
    try { await startOne(row); }
    catch (e) {
      log.warn("trigger start failed", { id: row.id, type: row.type, error: e.message });
      await pool.query("UPDATE triggers SET last_error=$2, updated_at=NOW() WHERE id=$1", [row.id, e.message]);
    }
  }
  log.info("trigger manager ready", { active: active.size });
}

export async function stopTriggerManager() {
  for (const [id] of active) await stopOne(id);
}

/** Public: re-sync a single trigger by id (called by API on create/update/delete).
 *
 *  Pass `{ force: true }` to tear down and restart even when the trigger row's
 *  own config blob is unchanged — needed when an *underlying* configuration
 *  row that the trigger references by name has been edited (e.g. the user
 *  changed the broker URL on the mqtt config row). The trigger row's blob
 *  only stores the config NAME, not the URL, so the equality check below
 *  can't see that change on its own.
 */
export async function syncTrigger(triggerId, { force = false } = {}) {
  const { rows } = await pool.query("SELECT * FROM triggers WHERE id=$1", [triggerId]);
  const row = rows[0];

  // Deleted or disabled → stop.
  if (!row || !row.enabled) {
    await stopOne(triggerId);
    return;
  }
  const cur = active.get(triggerId);
  // Already running with the same config — nothing to do, unless caller
  // is forcing a restart because a referenced configuration row changed.
  if (
    !force &&
    cur &&
    JSON.stringify(cur.row.config) === JSON.stringify(row.config) &&
    cur.row.type === row.type
  ) {
    cur.row = row;   // refresh the cached row (for last_fired_at etc.)
    return;
  }
  // Restart with the new config.
  if (cur) await stopOne(triggerId);
  await startOne(row);
}

/**
 * Public: force-restart every trigger in a workspace that references a
 * given configuration by name. Called by the configs API after an edit
 * or rotate so subscriptions pick up the new URL / credentials without
 * a worker restart.
 *
 * "References by name" means the trigger's config blob contains the
 * config name as a value at any depth (e.g. `{ config: "myBroker" }` or
 * `{ smtp: "myMailer" }`). We do this by JSON-stringifying the blob and
 * looking for the literal value — cheap and good enough; false positives
 * just cost an extra restart.
 */
export async function resyncTriggersUsingConfig(configName, workspaceId) {
  if (!configName || !workspaceId) return 0;
  const { rows } = await pool.query(
    "SELECT id, config FROM triggers WHERE workspace_id = $1 AND enabled = TRUE",
    [workspaceId],
  );
  const needle = JSON.stringify(configName);            // includes quotes; matches "myBroker" as a value
  const matches = rows.filter(r => {
    try { return JSON.stringify(r.config).includes(needle); }
    catch { return false; }
  });
  let restarted = 0;
  for (const r of matches) {
    try {
      await syncTrigger(r.id, { force: true });
      restarted++;
    } catch (e) {
      log.warn("trigger force-resync failed", { id: r.id, error: e.message });
    }
  }
  if (restarted > 0) {
    log.info("triggers resynced after config change", {
      configName, workspaceId, restarted,
    });
  }
  return restarted;
}

async function startOne(row) {
  // Triggers can reference saved configs via ${config.<name>.<key>}, so the
  // user can wire e.g. an MQTT trigger to a stored broker config instead of
  // re-typing host/credentials in every trigger. We resolve the expressions
  // up-front and hand the driver a fully-substituted config blob.
  // Configs are scoped to the trigger's workspace so a config in one
  // workspace can't leak into another's trigger.
  const resolvedConfig = await resolveTriggerConfig(row.config, row.workspace_id);
  const onFire = (payload) => fireTrigger(row, payload).catch(e => {
    log.warn("trigger fire failed", { id: row.id, error: e.message });
  });
  const subscription = await triggerRegistry.subscribe(
    row.type,
    resolvedConfig,
    onFire,
    { workspaceId: row.workspace_id, triggerId: row.id, graphId: row.graph_id },
  );
  active.set(row.id, { row, subscription, lastError: null });
  await pool.query("UPDATE triggers SET last_error=NULL, updated_at=NOW() WHERE id=$1", [row.id]);
  log.info("trigger started", { id: row.id, type: row.type, name: row.name });
}

/**
 * Walk a trigger's config blob and substitute any ${config.<name>.<key>}
 * placeholders with the live values from the configs table. Anything not
 * matching a placeholder is returned unchanged (the resolver's contract).
 *
 * If loading configs fails the original config is returned — the trigger
 * driver will then surface a more specific error if the missing field
 * mattered.
 */
async function resolveTriggerConfig(config, workspaceId) {
  if (!config || typeof config !== "object") return config;
  let configsMap;
  try { configsMap = await loadConfigsMap(workspaceId); }
  catch (e) {
    log.warn("trigger config resolve: configs load failed", { error: e.message });
    return config;
  }
  try {
    return resolveExpressions(config, { config: configsMap });
  } catch (e) {
    log.warn("trigger config resolve failed; using raw config", { error: e.message });
    return config;
  }
}

async function stopOne(triggerId) {
  const cur = active.get(triggerId);
  if (!cur) return;
  try { await cur.subscription.stop(); }
  catch (e) { log.warn("trigger stop error", { id: triggerId, error: e.message }); }
  active.delete(triggerId);
  log.info("trigger stopped", { id: triggerId });
}

/** Insert an execution row (status=queued, inputs=payload) and enqueue it.
 *  Inherits the trigger's workspace_id onto the execution row so every
 *  downstream lookup (configs, memory, listing) stays scoped. */
async function fireTrigger(row, payload) {
  const execId = uuid();
  // No tag source on auto-fired triggers in v1 — cron/mqtt/email fire
  // without a caller-supplied list, so the execution starts with [].
  // Manual-run via fireTriggerById supports tags below.
  await pool.query(
    `INSERT INTO executions (id, graph_id, status, inputs, context, workspace_id, tags)
     VALUES ($1,$2,'queued',$3,'{}'::jsonb,$4,$5)`,
    [execId, row.graph_id, JSON.stringify(payload), row.workspace_id, []],
  );
  await pool.query(
    `UPDATE triggers
       SET last_fired_at = NOW(),
           fire_count = fire_count + 1,
           updated_at = NOW()
     WHERE id = $1`,
    [row.id],
  );
  await enqueueExecution({ executionId: execId, graphId: row.graph_id });
  log.info("trigger fired", { id: row.id, type: row.type, executionId: execId });
}

export function activeCount() { return active.size; }

/**
 * Public: fire a trigger once on demand from the API. Inserts an
 * execution row + enqueues, bypassing the live subscription. The
 * trigger does NOT need to be enabled — this is the "Run now" path
 * from the FlowInspector page.
 *
 * Returns { executionId } so the caller can deep-link the user to
 * the InstanceViewer.
 */
export async function fireTriggerById(triggerId, { payload = {}, workspaceId, tags } = {}) {
  const params = [triggerId];
  let sql = "SELECT * FROM triggers WHERE id = $1";
  if (workspaceId) {
    params.push(workspaceId);
    sql += ` AND workspace_id = $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`trigger ${triggerId} not found`);
  const execId = uuid();
  // Tags arrive on the manual "Run now" path. Normalise once at the
  // boundary so the DB sees a clean string[] regardless of whether the
  // caller passed a list, comma-string, or something junk.
  const cleanTags = normalizeTags(tags);
  await pool.query(
    `INSERT INTO executions (id, graph_id, status, inputs, context, workspace_id, tags)
     VALUES ($1,$2,'queued',$3,'{}'::jsonb,$4,$5)`,
    [execId, row.graph_id, JSON.stringify(payload), row.workspace_id, cleanTags],
  );
  await pool.query(
    `UPDATE triggers
       SET last_fired_at = NOW(),
           fire_count    = fire_count + 1,
           updated_at    = NOW()
     WHERE id = $1`,
    [row.id],
  );
  await enqueueExecution({ executionId: execId, graphId: row.graph_id });
  log.info("trigger fired manually", { id: row.id, type: row.type, executionId: execId });
  return { executionId: execId, graphId: row.graph_id };
}
