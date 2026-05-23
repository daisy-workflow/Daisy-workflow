import { EventEmitter } from "node:events";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { buildDag } from "./scheduler.js";
import { resolve, evalCondition } from "../dsl/expression.js";
import { registry } from "../plugins/registry.js";
import {
  resolveNodeTimeoutMs,
  resolveMaxRetries,
  withTimeout,
  assertIterationCap,
  NodeTimeoutError,
} from "./limits.js";

const tracer = trace.getTracer("daisy-dag.engine");

/** Node statuses surfaced through events + persistence. */
export const NodeStatus = Object.freeze({
  PENDING:  "pending",
  RUNNING:  "running",
  RETRYING: "retrying",
  SUCCESS:  "success",
  FAILED:   "failed",
  SKIPPED:  "skipped",
  // Plugin signalled "stop here, wait for an external response".
  // The `user` plugin uses this to pause a workflow until a human (or
  // an external system) POSTs JSON to /executions/:id/nodes/:name/respond.
  WAITING:  "waiting",
});

/**
 * Sentinel marker a plugin can return to signal "pause this branch
 * until an external responder calls POST /executions/:id/nodes/:name/respond".
 *
 * Plugins return:
 *
 *     { [WAITING_MARKER]: true, prompt: "...", schema?: {…} }
 *
 * The executor:
 *   • marks the node WAITING with the rest of the object as its output
 *     (so the InstanceViewer can render the prompt);
 *   • does NOT decrement successor indegrees (so descendants stay
 *     pending until the human responds);
 *   • lets the rest of the DAG continue running its other branches.
 *
 * When the responder posts JSON, the API rewrites node_states.output to
 * that JSON, flips the row to success, re-enqueues the execution, and
 * the worker's resume path replays outputs into ctx so descendants run.
 */
export const WAITING_MARKER = "__dag_waiting__";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Execute a parsed DAG.
 *
 * @param {object} parsed   Parsed DSL (already validated).
 * @param {object} opts
 *   - executionId       string (for event payloads + persistence keys)
 *   - initialData       object merged into ctx.data
 *   - emitter           optional EventEmitter; if omitted, a fresh one is created
 *   - initialNodeStates optional { <nodeName>: { status, output, error, reason, ...} }
 *                       used by the resume path to pre-populate already-completed
 *                       nodes; the scheduler treats them as "done" without re-running.
 *   - inputsOverride    optional { <nodeName>: <inputs object> } — when a resume
 *                       supplies a fixed input map for a specific node, those
 *                       inputs are used verbatim instead of re-resolving from ctx.
 *   - persistNodeState  optional async (executionId, nodeName, partial) => void.
 *                       Called on every lifecycle transition. The worker wires
 *                       this to a node_states upsert; tests pass nothing.
 * @returns Promise<{status, ctx, nodes}>
 */
export async function executeDag(parsed, opts = {}) {
  const emitter = opts.emitter || new EventEmitter();
  const executionId = opts.executionId || null;
  const initialNodeStates = opts.initialNodeStates || {};
  const inputsOverride = opts.inputsOverride || {};
  const persistNodeState = typeof opts.persistNodeState === "function"
    ? opts.persistNodeState
    : null;

  const { adj, indegree, byName, roots } = buildDag(parsed);
  const remaining = new Map(indegree);                 // mutable copy

  // Reverse adjacency list — each node → its direct parents. Built once at
  // start so the runtime skip-cascade check below is O(1) per parent.
  const parents = new Map([...byName.keys()].map(n => [n, []]));
  for (const e of parsed.edges || []) {
    if (parents.has(e.to)) parents.get(e.to).push(e.from);
  }

  // Slim context:
  //   - parsed.data fields and user input are merged flat at the root, so
  //     expressions like ${url} resolve directly.
  //   - Each node's outputs:[{pluginField: ctxVar}] writes ctxVar at the root
  //     (e.g. ${weatherResult}).
  //   - The full per-node record (status / output / timings / attempts) lives
  //     under nodes.<name> for introspection (${nodes.fetch.output.body.id}).
  const ctx = {
    ...(parsed.data || {}),
    ...(opts.initialData || {}),
    nodes: {},
  };
  const nodeResults = {};                             // status per node
  let aborted = false;
  let aborting = null;                                // { reason }

  function emit(event, payload) {
    emitter.emit(event, { executionId, ...payload, at: new Date().toISOString() });
  }

  // Single source of truth for "this node finished with status X" — keeps
  // nodeResults (engine-internal) and ctx.nodes (persisted to executions.context
  // and read by the UI) in lockstep. Without this, several failure paths used
  // to update nodeResults only, leaving ctx.nodes missing entries — which made
  // the GraphView render the affected nodes as "pending" forever.
  //
  // Also fires the persistNodeState hook so the worker can incrementally
  // upsert the row to Postgres. Errors from the hook are logged but don't
  // abort the run — durable state is best-effort and never breaks execution.
  function recordOutcome(name, record) {
    nodeResults[name] = record;
    ctx.nodes[name] = {
      status: record.status,
      output: record.output ?? null,
      error: record.error ?? null,
      reason: record.reason ?? null,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      attempts: record.attempts ?? null,
    };
    if (persistNodeState) {
      Promise.resolve(persistNodeState(executionId, name, ctx.nodes[name]))
        .catch(() => { /* swallow — see hook contract above */ });
    }
  }

  // Re-hydrate already-completed nodes from a previous attempt (resume mode).
  // We only hydrate TERMINAL statuses (success / failed / skipped); rows
  // marked `pending` are deliberately left alone so the scheduler runs
  // them fresh. (The skip endpoint resets cascaded descendants back to
  // pending so they get re-evaluated against the new parent state.)
  //
  // For each hydrated node:
  //   • the scheduler treats it as already done (skips its runOne call);
  //   • on success we replay outputs:/outputVar bindings so downstream
  //     ${var} expressions resolve to the same values they did originally;
  //   • indegrees of successors are decremented so the ready-set rolls
  //     forward to the first node that still needs to run.
  if (Object.keys(initialNodeStates).length) {
    const pluginPrimary = (action) => registry.get(action)?.primaryOutput;
    // WAITING is intentionally *not* in this set — a still-waiting row
    // means the user hasn't responded yet. We hydrate it into
    // nodeResults so the scheduler skips it and we don't decrement its
    // successors (preserving their pending status), without trying to
    // replay a non-existent output.
    const TERMINAL = new Set([NodeStatus.SUCCESS, NodeStatus.FAILED, NodeStatus.SKIPPED]);
    for (const [name, prev] of Object.entries(initialNodeStates)) {
      const node = byName.get(name);
      if (!node) continue;
      if (prev.status === NodeStatus.WAITING) {
        // Still waiting — record locally so the scheduler skips it, but
        // do NOT decrement successor indegrees. Descendants stay pending
        // until the responder turns this into SUCCESS via the API.
        nodeResults[name] = { ...prev };
        ctx.nodes[name]   = { ...prev };
        continue;
      }
      if (!TERMINAL.has(prev.status)) continue;     // pending / running → run fresh
      if (prev.status === NodeStatus.SUCCESS && prev.output != null) {
        applyOutputMapping(prev.output, node.outputs, ctx);
        if (node.outputVar) {
          const primary = pluginPrimary(node.action);
          ctx[node.outputVar] =
            primary && prev.output && typeof prev.output === "object" && primary in prev.output
              ? prev.output[primary]
              : prev.output;
        }
      }
      // Mirror the prior outcome locally; do NOT re-fire persistNodeState
      // because the row is already authoritative on disk.
      nodeResults[name] = { ...prev };
      ctx.nodes[name]   = { ...prev };
      // Roll the scheduler's ready-set forward by one indegree per successor.
      for (const next of adj.get(name) || []) {
        remaining.set(next, Math.max(0, remaining.get(next) - 1));
      }
    }
  }

  // Aborted runs (onError=terminate) bail out before reaching every node.
  // We DO NOT mark the unreached nodes as skipped — that's a meaningful
  // signal reserved for executeIf=false / upstream-skipped / user-skip.
  // Instead they stay PENDING so the InstanceViewer can show "this work
  // didn't happen" and Resume can pick them up later. Persisted explicitly
  // (rather than just left out of ctx.nodes) so the UI has a row per
  // declared node and can render its terminate-state correctly.
  function markRestPending(reason) {
    for (const name of byName.keys()) {
      if (!nodeResults[name]) {
        recordOutcome(name, { status: NodeStatus.PENDING, reason });
        emit("node:status", { node: name, status: NodeStatus.PENDING, reason });
      }
    }
  }

  // Each node's execution lives inside a `node.execute` child span of
  // the active workflow.run span. The span's status mirrors the node's
  // outcome at end-of-runOne (success / skipped → OK; failed → ERROR).
  async function runOne(node) {
    return tracer.startActiveSpan(
      "node.execute",
      {
        attributes: {
          "node.name":   node.name,
          "node.action": node.action,
          "execution.id": executionId || "",
        },
      },
      async (span) => {
        try {
          await runOneInner(node);
          const r = nodeResults[node.name];
          span.setAttribute("node.status",   r?.status   || "unknown");
          span.setAttribute("node.attempts", r?.attempts || 0);
          if (r?.status === "failed") {
            span.setStatus({ code: SpanStatusCode.ERROR, message: r.error || "node failed" });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } catch (e) {
          // runOneInner is supposed to swallow errors via recordOutcome;
          // anything that escapes here is an engine bug. Record + rethrow.
          span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message || String(e) });
          throw e;
        } finally {
          span.end();
        }
      },
    );
  }

  async function runOneInner(node) {
    // 0. Skip-cascade. If any parent ended up SKIPPED, this node inherits
    //    that status — the "all_success" semantic familiar from
    //    Airflow / Prefect: gating one branch short-circuits the whole
    //    subtree below it. This applies to both system skips
    //    (executeIf=false / upstream-skipped) and user-initiated skips
    //    via the InstanceViewer (the user said "abandon this branch").
    //
    //    A FAILED parent under onError=continue is a "keep going"
    //    signal, so its downstream still runs. (FAILED with
    //    onError=terminate aborts the run elsewhere.)
    const skippedParent = (parents.get(node.name) || []).find(
      p => nodeResults[p]?.status === NodeStatus.SKIPPED
    );
    if (skippedParent) {
      const reason = `upstream "${skippedParent}" was skipped`;
      recordOutcome(node.name, { status: NodeStatus.SKIPPED, reason });
      emit("node:status", { node: node.name, status: NodeStatus.SKIPPED, reason });
      return;
    }

    // 1. Resolve `executeIf`.
    if (node.executeIf) {
      let cond = false;
      try { cond = evalCondition(node.executeIf, ctx); }
      catch (e) {
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: `executeIf eval failed: ${e.message}` });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
        return;
      }
      if (!cond) {
        recordOutcome(node.name, { status: NodeStatus.SKIPPED, reason: "executeIf=false" });
        emit("node:status", { node: node.name, status: NodeStatus.SKIPPED, reason: "executeIf=false" });
        return;
      }
    }

    // 2. Resolve inputs once (for non-batch). Resume mode can supply a
    //    pre-baked input object (the user edited the failed inputs through
    //    the InstanceViewer) — in that case skip resolution and pass the
    //    map verbatim so the user's edits aren't smashed by the resolver.
    const rawInputs = node.inputs || {};
    let resolvedInputs;
    if (Object.prototype.hasOwnProperty.call(inputsOverride, node.name)) {
      resolvedInputs = inputsOverride[node.name];
    } else {
      try { resolvedInputs = resolve(rawInputs, ctx); }
      catch (e) {
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: `input resolve failed: ${e.message}` });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
        return handleFailure(node, e);
      }
    }

    // 3. Batch handling — fan out over an array.
    let batchItems = null;
    if (node.batchOver) {
      try { batchItems = resolve(node.batchOver, ctx); }
      catch (e) {
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: `batchOver eval failed: ${e.message}` });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
        return handleFailure(node, e);
      }
      if (!Array.isArray(batchItems)) {
        const err = new Error(`batchOver did not resolve to an array (got ${typeof batchItems})`);
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: err.message });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: err.message });
        return handleFailure(node, err);
      }
    }

    const startedAt = new Date().toISOString();
    emit("node:status", { node: node.name, status: NodeStatus.RUNNING, input: resolvedInputs });
    // Mark RUNNING in the durable state with the resolved inputs attached.
    // If the worker crashes mid-plugin, the InstanceViewer will see this
    // row + the user can edit `resolved_inputs` and resume.
    if (persistNodeState) {
      Promise.resolve(persistNodeState(executionId, node.name, {
        status:         NodeStatus.RUNNING,
        startedAt,
        resolvedInputs,
      })).catch(() => { /* see persistNodeState contract */ });
    }

    // Streaming hooks — plugins use `hooks.stream.*` to emit incremental
    // updates that the worker forwards to subscribed WebSocket clients.
    // Plugins that don't touch hooks behave exactly as before.
    //
    // Three flavours of stream message:
    //   • text  — short string deltas (LLM token-by-token, agent chatter)
    //   • log   — leveled diagnostic message (level: debug|info|warn|error)
    //   • data  — arbitrary structured payload (per-row SQL, partial JSON)
    //
    // Each emit fans out as a `node:stream` event with the node name +
    // kind + payload. The frontend subscribes via the existing WebSocket
    // and renders a Live-output panel.
    const hooks = {
      stream: {
        text: (chunk) => emit("node:stream", { node: node.name, kind: "text", chunk: String(chunk ?? "") }),
        log:  (level, message) => emit("node:stream", {
          node: node.name, kind: "log",
          level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
          message: String(message ?? ""),
        }),
        data: (payload) => emit("node:stream", { node: node.name, kind: "data", payload }),
      },
    };

    const attemptOnce = async (input) => {
      // resolveMaxRetries clamps to EXECUTION_MAX_RETRIES (default 10).
      // A workflow that ships `retry: 9999` no longer torches the queue.
      const maxRetries = resolveMaxRetries(node.retry);
      const delayMs    = parseDuration(node.retryDelay) || 0;
      // Per-node timeout overrides workflow-level overrides env default.
      // null = no wall-clock budget for this node (caller opted out).
      const nodeTimeoutMs = resolveNodeTimeoutMs(node, parsed);
      let attempt = 0;
      let lastErr;
      while (attempt <= maxRetries) {
        attempt++;
        // Fresh AbortController per attempt — the timer that fires
        // NodeTimeoutError also aborts the signal, so plugins that
        // honor it (fetch, pg query, etc.) can shut down their
        // sockets immediately instead of leaking until the OS
        // timeout. Plugins that ignore the signal still get killed
        // at the engine layer.
        const ac = new AbortController();
        let timeoutHandle = null;
        if (nodeTimeoutMs && Number.isFinite(nodeTimeoutMs) && nodeTimeoutMs > 0) {
          timeoutHandle = setTimeout(
            () => ac.abort(new NodeTimeoutError(node.name, nodeTimeoutMs)),
            nodeTimeoutMs,
          );
          if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
        }
        try {
          // Race the plugin call against the timeout. If the timer
          // wins, NodeTimeoutError is thrown and the retry loop
          // decides whether to try again.
          const out = await withTimeout(
            registry.invoke(node.action, input, ctx, hooks, { signal: ac.signal }),
            nodeTimeoutMs,
            () => new NodeTimeoutError(node.name, nodeTimeoutMs),
          );
          return { ok: true, output: out, attempts: attempt };
        } catch (e) {
          lastErr = e;
          emit("node:status", {
            node: node.name, status: NodeStatus.RETRYING, attempt, error: e.message,
          });
          if (attempt > maxRetries) break;
          if (delayMs) await sleep(delayMs);
        } finally {
          // Cancel the abort timer if the call resolved naturally
          // (timer ref'd or not, no point letting it fire later).
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
      return { ok: false, error: lastErr, attempts: attempt };
    };

    let output, attempts;
    try {
      if (batchItems) {
        // Node-level batch fan-out is subject to the same iteration
        // cap as executeBatch. A node with batch:true + batchOver
        // resolving to a 50k-element array fails up-front instead of
        // mid-run.
        assertIterationCap(parsed, batchItems.length, `node "${node.name}" batch`);
        const results = await Promise.all(
          batchItems.map(async (item, i) => {
            const itemCtx = { ...ctx, item, index: i };
            const itemInputs = resolve(rawInputs, itemCtx);
            const r = await attemptOnce(itemInputs);
            if (!r.ok) throw r.error;
            return r.output;
          }),
        );
        output = { items: results, count: results.length };
        attempts = 1;
      } else {
        const r = await attemptOnce(resolvedInputs);
        // Capture attempts up-front so the catch path below still has
        // it on the recordOutcome call when r.ok=false. Without this,
        // a failed node's node_states row ended up with attempts=NULL
        // and consumers (InstanceViewer, retries-and-errors spec)
        // couldn't tell whether the retry budget was exercised at all.
        attempts = r.attempts;
        if (!r.ok) throw r.error;
        output = r.output;
      }
    } catch (e) {
      recordOutcome(node.name, {
        status: NodeStatus.FAILED, error: e.message,
        attempts,                                 // see capture above
        startedAt, finishedAt: new Date().toISOString(),
      });
      emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
      return handleFailure(node, e);
    }

    // 3.5 Waiting branch — the plugin is asking us to pause until
    //     someone POSTs a response. Mark the node WAITING with its
    //     prompt/schema as the output (handy for the InstanceViewer)
    //     and return WITHOUT propagating outputs to ctx. The scheduler
    //     loop further down knows to NOT decrement successor indegrees
    //     when a node ends WAITING, so descendants stay pending.
    const isWaiting = output && typeof output === "object" && output[WAITING_MARKER] === true;
    if (isWaiting) {
      const finishedAt = new Date().toISOString();
      recordOutcome(node.name, {
        status: NodeStatus.WAITING, output, attempts, startedAt, finishedAt,
      });
      emit("node:status", {
        node: node.name, status: NodeStatus.WAITING, output, attempts, startedAt, finishedAt,
      });
      return;
    }

    // 4. Surface the node's outputs into ctx.
    //   - Each `outputs: { pluginField: ctxVar }` mapping writes the named
    //     subfield to the ROOT of ctx (so downstream nodes do `${ctxVar}`).
    //   - `node.outputVar` (when set) is the new ergonomic shortcut: the
    //     engine drops the plugin's "primary" output (or the whole output
    //     object as a fallback) at ctx[outputVar].
    //   - Full raw plugin output is also kept on ctx.nodes[name].output via
    //     recordOutcome below.
    const finishedAt = new Date().toISOString();
    applyOutputMapping(output, node.outputs, ctx);
    if (node.outputVar) {
      const plugin = registry.get(node.action);
      const primary = plugin?.primaryOutput;
      ctx[node.outputVar] =
        primary && output && typeof output === "object" && primary in output
          ? output[primary]
          : output;
    }
    recordOutcome(node.name, {
      status: NodeStatus.SUCCESS, output, attempts, startedAt, finishedAt,
    });
    const nodeOutput = output;
    emit("node:status", {
      node: node.name, status: NodeStatus.SUCCESS, output: nodeOutput, attempts, startedAt, finishedAt,
    });
  }

  function handleFailure(node) {
    if ((node.onError || "terminate") === "terminate") {
      aborted = true;
      aborting = { reason: `node ${node.name} failed` };
    }
  }

  // Layer-by-layer scheduler.
  emit("execution:start", { graph: parsed.name });
  // Build the initial ready-set:
  //   • normally that's just the DAG's natural roots,
  //   • on resume some of those roots are already nodeResults[]'d, so we
  //     skip them and pick up any node whose remaining indegree is now 0
  //     after the rehydration loop above.
  const ready = [];
  for (const name of byName.keys()) {
    if (nodeResults[name]) continue;          // already done (resumed)
    if ((remaining.get(name) || 0) === 0) ready.push(name);
  }
  while (ready.length && !aborted) {
    const layer = ready.splice(0, ready.length);
    await Promise.all(layer.map(name => runOne(byName.get(name))));
    if (aborted) break;
    for (const name of layer) {
      // A node that ended WAITING is asking us to pause its branch.
      // Don't decrement its successors' indegrees — they stay pending
      // until a responder POSTs JSON and the resumed run replays the
      // node as success.
      if (nodeResults[name]?.status === NodeStatus.WAITING) continue;
      for (const next of adj.get(name) || []) {
        const r = remaining.get(next) - 1;
        remaining.set(next, r);
        if (r === 0 && !nodeResults[next]) ready.push(next);
      }
    }
  }

  if (aborted) markRestPending(aborting?.reason || "aborted");

  // Final reconciliation: any declared node that still hasn't been
  // recorded (e.g. engine bug, unexpected throw, or just because the
  // run aborted) gets marked PENDING. That guarantees ctx.nodes has a
  // row per declared node so the UI can render every node's status,
  // and "pending" means "didn't run yet" — perfectly meaningful for
  // resume / skip.
  for (const name of byName.keys()) {
    if (!nodeResults[name]) {
      recordOutcome(name, { status: NodeStatus.PENDING, reason: "not reached" });
    }
  }

  // Aggregate status.
  // - any failed node + onError=terminate → 'failed' (set above by aborted)
  // - any failed node otherwise           → 'partial'
  // - any waiting node (with no failures) → 'waiting' (resume later)
  // - everything else                     → 'success'
  const statuses = Object.values(nodeResults).map(r => r.status);
  let overall;
  if (aborted) overall = "failed";
  else if (statuses.some(s => s === NodeStatus.FAILED))  overall = "partial";
  else if (statuses.some(s => s === NodeStatus.WAITING)) overall = "waiting";
  else overall = "success";

  emit("execution:end", { status: overall, nodes: nodeResults });
  return { status: overall, ctx, nodes: nodeResults };
}

/**
 * Apply a node's `outputs:` mapping.
 *
 * DSL form:
 *     outputs:
 *       - json: weatherResult        # take pluginOutput.json -> ctx.weatherResult
 *
 * After parsing this becomes  outputs: { json: "weatherResult" }.
 * For each pair (pluginField -> ctxVar), copy raw[pluginField] into ctx[ctxVar].
 * Falls back to dot-paths in the plugin field name (e.g. "body.id").
 */
function applyOutputMapping(raw, mapping, ctx) {
  if (!mapping || Object.keys(mapping).length === 0) return;
  for (const [pluginField, ctxVar] of Object.entries(mapping)) {
    if (!ctxVar) continue;
    ctx[ctxVar] = getPath(raw, pluginField);
  }
}

function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

/** Accept either a number (ms) or a duration string like "500ms", "2s". */
function parseDuration(d) {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  const m = String(d).match(/^(\d+)\s*(ms|s|m)?$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  switch (m[2] || "ms") {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60000;
    default:   return n;
  }
}
