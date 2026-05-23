// MUST stay at the top — see comment in server.js. The auto-instrumentations
// only hook modules loaded AFTER sdk.start().
import "./telemetry.js";

import { Worker } from "bullmq";
import { EventEmitter } from "node:events";
import { trace, propagation, context, SpanStatusCode } from "@opentelemetry/api";
import { config } from "./config.js";
import { QUEUE_NAME, redisConnection } from "./queue/queue.js";
import { pool } from "./db/pool.js";
import { parseDag } from "./dsl/parser.js";
import { executeDag } from "./engine/executor.js";
import { executeBatch } from "./engine/batch.js";
import { loadBuiltins, registry, reportDeprecatedUsage } from "./plugins/registry.js";
import { startHealthcheck, stopHealthcheck } from "./plugins/healthcheck.js";
import { publish } from "./ws/broadcast.js";
import { log } from "./utils/logger.js";
import { logNodeEvent } from "./utils/eventLog.js";
import { loadTriggerBuiltins } from "./triggers/registry.js";
import { startTriggerManager, stopTriggerManager } from "./triggers/manager.js";
import { runIfRequested as bootstrapAdmin } from "./cli/createAdmin.js";
import { loadConfigsMap, buildConfigEnv } from "./configs/loader.js";
import {
  upsertNodeState,
  loadNodeStates,
  reapOrphanedExecutions,
} from "./engine/nodeStateStore.js";
import { loadKvForScope } from "./engine/memoryStore.js";
import {
  resolveWorkflowTimeoutMs,
  withTimeout,
  WorkflowTimeoutError,
} from "./engine/limits.js";
import { start as startRetention, stop as stopRetention } from "./retention/runner.js";
import { startWorkerProbe, stopWorkerProbe } from "./health/workerProbe.js";

await loadBuiltins();
await registry.loadAll();          // build in-memory cache from DB
// One log.warn per (workspace, deprecated plugin) pair — same as
// the API boot path. Helps operators see who's still wired to
// plugins on the way out. Fire-and-forget so it can't fail boot.
reportDeprecatedUsage().catch((e) => log.warn("deprecated-usage scan failed", { error: e.message }));
await loadTriggerBuiltins();
// Subscribe to all enabled triggers on worker boot. Errors per-trigger are
// logged but don't crash the worker.
startTriggerManager().catch(e => log.error("trigger manager start failed", { error: e.message }));

// One-shot admin bootstrap when BOOTSTRAP_ADMIN_AUTOCREATE=true and the
// DB has no users yet. No-op otherwise. Logs the outcome so you can
// see in the journal what credentials seeded the system. Errors here
// don't crash the worker — the operator can always run create-admin
// by hand against the same DB.
bootstrapAdmin()
  .then((res) => { if (res?.action === "created") log.info("admin bootstrapped", res); })
  .catch((e)  => log.error("admin bootstrap failed", { error: e.message }));

// Retention scheduler. No-op when RETENTION_ENABLED is unset/false.
// Opt-in so a dev environment doesn't quietly nuke local executions
// while engineers are debugging.
try { startRetention(); }
catch (e) { log.warn("retention start failed", { error: e.message }); }

// Plugin healthcheck loop — periodically probes /readyz on every
// http-transport plugin so the admin Plugins page renders fresh
// status. No-op when no http plugins are installed.
try { startHealthcheck(); }
catch (e) { log.warn("plugin healthcheck start failed", { error: e.message }); }

// Reap any execution rows left in `running` from a previous crash. We
// don't know what BullMQ has in flight at this exact moment, but a fresh
// worker process has yet to claim anything — so any RUNNING row is by
// definition stale until it's re-delivered to us as a job.
reapOrphanedExecutions().catch(e => log.warn("orphan reap failed", { error: e.message }));

const tracer = trace.getTracer("daisy-dag.engine");

/**
 * Wrap the actual execution work in a `workflow.run` root span. The
 * trace context attached to the BullMQ job (set by enqueueExecution) is
 * extracted as the parent so the span links back to whatever HTTP
 * request originally enqueued the run.
 *
 * Every nested operation — pg queries, plugin calls, downstream HTTP /
 * Redis / fetch — automatically becomes a child span via OTel's active
 * context propagation.
 */
async function processExecution(job) {
  const parentCtx = job.data?._otel
    ? propagation.extract(context.active(), job.data._otel)
    : context.active();

  return await tracer.startActiveSpan(
    "workflow.run",
    {
      attributes: {
        "workflow.id":       job.data?.graphId || "",
        "workflow.run_id":   job.data?.executionId || "",
        "workflow.trigger":  job.data?.trigger || "manual",
      },
    },
    parentCtx,
    async (span) => {
      try {
        const result = await processExecutionBody(job, span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        // OUTER rescue — covers everything inside processExecutionBody,
        // including the pool queries / parseDag / SELECT for ctx that
        // run BEFORE the inner try/catch around executeDag. Without
        // this, any throw between status='running' and the inner
        // catch left the row pinned at 'running' forever (BullMQ
        // marks the job failed but doesn't touch the executions row).
        // The HITL spec hit this when parseDag or loadConfigsMap
        // raised — status='running' was visible to the poll but
        // never advanced.
        log.warn("processExecutionBody threw — marking execution failed",
          { executionId: job?.data?.executionId, error: e?.message });
        if (job?.data?.executionId) {
          try {
            await pool.query(
              "UPDATE executions SET status='failed', finished_at=NOW(), error=$2 WHERE id=$1 AND status NOT IN ('success','partial','waiting','failed')",
              [job.data.executionId, e?.message || String(e)],
            );
          } catch {/* best effort — already in a failure path */}
        }
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message || String(e) });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

async function processExecutionBody(job, span) {
  const { executionId, graphId } = job.data;

  // Resume detection: a job that arrives with status='queued' but already
  // has node_states rows is a user-initiated resume (POST .../resume or
  // .../skip on the executions API). We want to skip the success rows and
  // re-run only what's pending; nothing else needs to know whether we're
  // on a fresh run or a resume.
  const initialNodeStates = await loadNodeStates(executionId);
  const isResume = Object.keys(initialNodeStates).length > 0;
  const inputsOverride = job.data.inputsOverride || {};

  log.info(isResume ? "execution resume" : "execution start", {
    executionId, graphId, resumedNodes: Object.keys(initialNodeStates).length,
  });

  await pool.query(
    "UPDATE executions SET status='running', started_at=COALESCE(started_at, NOW()) WHERE id=$1",
    [executionId],
  );

  const { rows } = await pool.query("SELECT dsl, parsed FROM graphs WHERE id=$1", [graphId]);
  if (rows.length === 0) throw new Error("graph not found");

  // Prefer the parsed-JSONB cache; fall back to re-parsing the dsl text.
  const parsed = rows[0].parsed || parseDag(rows[0].dsl);
  span?.setAttribute("workflow.name", parsed?.name || "");

  // Pull the user-supplied JSON input that was stashed when the execution row
  // was created. It overlays parsed.data and is exposed as ${data.*} / ${input.*}.
  // (Older rows may only have it in `context`; fall back if `inputs` is empty.)
  // Also pull workspace_id so we can scope config + memory loads to it.
  const { rows: ctxRows } = await pool.query(
    "SELECT inputs, context, workspace_id, project_id FROM executions WHERE id=$1", [executionId],
  );
  const inputsRow = ctxRows[0]?.inputs;
  const userContext =
    (inputsRow && (Array.isArray(inputsRow) || Object.keys(inputsRow).length > 0))
      ? inputsRow
      : (ctxRows[0]?.context || {});
  const workspaceId = ctxRows[0]?.workspace_id || null;
  const projectId   = ctxRows[0]?.project_id   || null;

  // Batch mode: if the user-supplied input is { items: [...] } OR a bare array,
  // run the whole DAG once per item. Otherwise treat it as a single-run object.
  const batchItems = Array.isArray(userContext) ? userContext
                   : Array.isArray(userContext?.items) ? userContext.items
                   : null;
  const isBatch = Array.isArray(batchItems);
  // Flat shape: user keys end up directly on ctx (e.g. ${ids}, ${url}).
  const initialData = isBatch ? {} : (userContext && typeof userContext === "object" ? userContext : {});

  // Centralised configurations — exposed two ways to suit different consumers:
  //   • ctx.config.<name>.<key>      → for ${config.<name>.<key>} expressions
  //                                     in plugin inputs / executeIf / batchOver
  //   • ctx.env.CONFIG_<NAME>_<KEY>  → for script-style plugins that expect
  //                                     env-var-flavoured access
  // Failure to load configs (DB down, missing table) leaves both as empty
  // objects so the rest of the run can still proceed.
  // RBAC v2: configs resolve in two layers — project-private wins on
  // a name collision, workspace-shared fills in the rest. Worker now
  // passes both ids; the loader does the SQL-level overlay.
  const configsMap = await loadConfigsMap(workspaceId, projectId).catch((e) => {
    log.warn("configs load failed; continuing with empty config", { error: e.message });
    return {};
  });
  initialData.config = configsMap;
  initialData.env    = { ...buildConfigEnv(configsMap) };

  // Workflow KV memory — preloaded once per execution so plugins and
  // expressions can read stored values via ${memory.<key>} without
  // hitting the DB per call. Stripped from persisted ctx below (same
  // treatment as ctx.config / ctx.env).
  initialData.memory = workspaceId
    ? await loadKvForScope({
        workspaceId, scope: "workflow", scopeId: graphId, namespace: "kv",
      }).catch((e) => {
        log.warn("memory load failed; continuing with empty memory", { error: e.message });
        return {};
      })
    : {};

  // Identity so plugins (e.g. memory plugins, the agent's history
  // helpers) know which workflow they're running under without
  // poking back at the queue payload.
  initialData.execution = { id: executionId, graphId, workspaceId, projectId };

  // Carry the parsed workflow header onto ctx so plugins can read
  // workflow-level overrides like maxTokens / maxIterations without
  // re-reading from the DB. Underscored so the redact() pass below
  // strips it before persistence.
  initialData._parsed = {
    maxTokens:      parsed?.maxTokens,
    maxIterations:  parsed?.maxIterations,
  };
  // Running counters (also redacted out of persisted ctx).
  initialData._tokens     = 0;
  initialData._fireCount  = 0;

  // Spawn-chain tracking for workflow.fire. Each fire pushes the parent
  // graph_id onto this list before enqueueing the child; the child
  // reads it back here so nested fires keep enforcing the depth + cycle
  // checks. Underscore-prefixed so it doesn't collide with user data.
  initialData._ancestors = Array.isArray(job.data?._ancestors)
    ? job.data._ancestors
    : [];

  // Wire engine events into the WebSocket broadcaster + the JSONL event log.
  // Per-node history is no longer persisted to Postgres — the post-execution
  // summary lives in executions.context.nodes (written below).
  const emitter = new EventEmitter();
  emitter.on("node:status", (evt) => {
    publish({ type: "node:status", executionId, ...evt }).catch(() => {});
    logNodeEvent({ type: "node:status", executionId, graphId, ...evt });
  });
  // Streaming chunks emitted by plugins via ctx hooks. Same WS channel
  // as status events, distinguished by `type`. The frontend's
  // InstanceViewer routes these into a Live-output buffer per node.
  emitter.on("node:stream", (evt) => {
    publish({ type: "node:stream", executionId, ...evt }).catch(() => {});
    logNodeEvent({ type: "node:stream", executionId, graphId, ...evt });
  });
  emitter.on("execution:start", (evt) => {
    publish({ type: "execution:start", ...evt }).catch(() => {});
    logNodeEvent({ type: "execution:start", executionId, graphId, ...evt });
  });
  emitter.on("execution:end", (evt) => {
    publish({ type: "execution:end", ...evt }).catch(() => {});
    logNodeEvent({ type: "execution:end", executionId, graphId, ...evt });
  });

  // Workflow-level wall-clock budget. Per-workflow `timeout` (in the
  // parsed DSL) wins; falls back to EXECUTION_DEFAULT_WORKFLOW_TIMEOUT.
  // null = no budget (operator disabled it via env="" + no DSL override).
  //
  // Caveat about pause/resume: a workflow waiting on a `user` plugin is
  // re-enqueued as a fresh job when /respond fires, so the timer resets
  // on each resume — we measure wall-clock per job, not per
  // logical-execution. That's the right behaviour because the "pause"
  // is intentional and the timer should only count active work.
  const workflowTimeoutMs = resolveWorkflowTimeoutMs(parsed);
  span?.setAttribute("workflow.timeout_ms", workflowTimeoutMs || 0);

  // Wrap upsertNodeState so the worker can track every fire-and-forget
  // persistNodeState promise the executor kicks off. The executor calls
  // its persistNodeState hook with Promise.resolve(fn).catch(()=>{}) —
  // it never awaits them. Under load, the final UPDATE below was
  // queueing behind both (a) the pool exhausted by in-flight INSERTs
  // and (b) the FK row lock the INSERT INTO node_states takes on the
  // executions row (FOR KEY SHARE; the UPDATE needs FOR NO KEY UPDATE,
  // they conflict). Draining these before the UPDATE releases the
  // locks + frees connections, so the UPDATE proceeds immediately.
  //
  // The HITL spec hit this hard: status='waiting' would land in the
  // executor + node_states would persist, but the executions row
  // never advanced past 'running' because the UPDATE was waiting on
  // locks the not-yet-completed INSERTs still held.
  const pendingPersists = [];
  const wrappedUpsert = (...args) => {
    const p = upsertNodeState(...args);
    pendingPersists.push(p);
    return p;
  };

  let result;
  try {
    const exec = isBatch
      ? executeBatch(parsed, {
          // Batch mode doesn't yet support per-item resume; the outer
          // executor's persistence still fires for non-batch nodes inside
          // the batch DAG, just not per-item.
          executionId, emitter, items: batchItems,
          concurrency: 4,
          persistNodeState: wrappedUpsert,
        })
      : executeDag(parsed, {
          executionId, emitter, initialData,
          // Step-1 of the durable-execution design: write state per node.
          persistNodeState:  wrappedUpsert,
          // Resume hooks — both no-ops on a fresh run.
          initialNodeStates,
          inputsOverride,
        });
    result = await withTimeout(
      exec,
      workflowTimeoutMs,
      () => new WorkflowTimeoutError(workflowTimeoutMs),
    );
    // Drain every in-flight node_states write. allSettled so a single
    // upsert failure can't keep the executions row pinned at 'running'.
    await Promise.allSettled(pendingPersists);
    // Trace-point — proves the executor returned. If this log appears
    // but the subsequent UPDATE doesn't land, the hang is between here
    // and the pool.query below (JSON.stringify on ctx, or pool blocked).
    // Logged at warn so it survives LOG_LEVEL=warn deploys — diagnostic
    // value here outweighs the "is this really a warning" semantic.
    log.warn("executeDag returned", { executionId, status: result?.status, persists: pendingPersists.length });
  } catch (e) {
    // Same rescue path as the surrounding processExecution wrapper —
    // if executeDag throws (timeout, engine bug, validateOutput
    // failure, plugin throw), land the row at 'failed' before
    // rethrowing so the e2e suite isn't waiting on a stuck 'running'.
    log.warn("executeDag threw — marking execution failed",
      { executionId, error: e.message });
    await pool.query(
      "UPDATE executions SET status='failed', finished_at=NOW(), error=$2 WHERE id=$1",
      [executionId, e.message],
    ).catch(() => {});
    throw e;
  }

  // Configs are encrypted in `configs.data` at rest, but the engine
  // injects DECRYPTED values into ctx.config / ctx.env so plugins can
  // use them. Those branches must NOT make it into executions.context —
  // anyone with read access to the executions table (or the
  // InstanceViewer) would otherwise see plaintext SMTP / DB / API
  // passwords. Strip them before persisting.
  function redact(ctx) {
    if (!ctx || typeof ctx !== "object") return ctx;
    // Strip transient/preloaded engine surfaces. memory + execution are
    // both rebuilt per run; _ancestors / _parsed / _tokens / _fireCount
    // are engine-internal runtime bookkeeping — none of these belong
    // in executions.context.
    const {
      config, env, memory, execution,
      _ancestors, _parsed, _tokens, _fireCount,
      ...rest
    } = ctx;
    return rest;
  }

  // For batch runs, persist the per-item summary instead of a single ctx.
  let finalContext;
  try {
    finalContext = isBatch
      ? { batch: true, items: (result.items || []).map(it => ({
          ...it,
          ctx:    redact(it.ctx),
          // Some batch implementations bubble up the per-item input under
          // `input` — that's user-supplied data, leave it alone.
        })) }
      : redact(result.ctx);

    // Stamp the workflow.run span's trace_id onto the persisted context
    // so the Grafana overview dashboard can deep-link from "executions
    // table row" → "trace in Tempo". Cheap (one struct lookup); the
    // worker already has the active span from startActiveSpan above.
    const otelCtx = trace.getActiveSpan()?.spanContext?.();
    if (otelCtx?.traceId) {
      finalContext._otel = { trace_id: otelCtx.traceId, span_id: otelCtx.spanId };
    }
  } catch (e) {
    // Building finalContext failed (circular ref, non-serialisable
    // value, etc.). Persist a minimal context so the row at least
    // gets its final status — without this rescue, the execution
    // would stay stuck at 'running' forever (no further code path
    // updates it once the inner executeDag try/catch is exited).
    log.warn("finalContext build failed; persisting minimal context",
      { executionId, error: e.message });
    finalContext = { __finalContextBuildError: e.message };
  }
  // Pre-stringify the context OUTSIDE the pool.query call. If
  // JSON.stringify throws on a hidden circular reference, the
  // pool.query never gets called — without this catch the row stayed
  // pinned at 'running' because the inner try/catch only runs once
  // pool.query is INVOKED. Stringifying ahead of time guarantees we
  // either get a string (UPDATE proceeds) or land in the catch
  // (UPDATE with '{}' proceeds). Either way the row's status flips.
  let contextJson;
  try {
    contextJson = JSON.stringify(finalContext);
  } catch (e) {
    log.warn("execution context JSON.stringify failed at pre-stringify; storing empty",
      { executionId, error: e.message });
    contextJson = "{}";
  }
  try {
    await pool.query(
      "UPDATE executions SET status=$2, finished_at=NOW(), context=$3::jsonb WHERE id=$1",
      [executionId, result.status, contextJson],
    );
    // warn so it shows under LOG_LEVEL=warn — pairs with the
    // "executeDag returned" log above to bracket the hang window.
    log.warn("execution row updated", { executionId, status: result.status });
  } catch (e) {
    log.warn("execution UPDATE failed; retrying with empty context",
      { executionId, error: e.message });
    await pool.query(
      "UPDATE executions SET status=$2, finished_at=NOW(), context='{}'::jsonb WHERE id=$1",
      [executionId, result.status],
    );
  }
  log.info("execution end", { executionId, status: result.status });
  span?.setAttribute("workflow.status", result.status);
  return { status: result.status };
}

const worker = new Worker(QUEUE_NAME, processExecution, {
  connection: redisConnection,
  concurrency: config.workerConcurrency,
});

worker.on("failed", (job, err) => {
  log.error("job failed", { id: job?.id, error: err.message });
});

worker.on("ready", () => log.info("worker ready", { concurrency: config.workerConcurrency }));

// Optional probe server — opt-in via WORKER_HEALTH_PORT so dev
// (where the worker runs in-process under server.js) doesn't try
// to bind a second port. In a real worker deployment set the env
// to whatever your platform's healthcheck expects (k8s default
// pattern is 3100 or 8081).
const probePort = parseInt(process.env.WORKER_HEALTH_PORT || "0", 10);
if (probePort > 0) {
  startWorkerProbe({ port: probePort, worker });
}

process.on("SIGTERM", async () => {
  stopWorkerProbe();
  stopHealthcheck();
  stopRetention();
  await stopTriggerManager();
  await worker.close();
  process.exit(0);
});
