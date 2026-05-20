// Model route dispatcher.
//
// Three strategies, all narrow:
//
//   static    — config.agent → call that agent, done.
//   tier      — caller passes `tier` (or the route's default is used);
//                config.tiers[tier] resolves to the target agent.
//   fallback  — iterate config.chain in order; on a non-fatal
//                provider error (and not a GuardrailBlockedError),
//                try the next link. Returns the first success.
//
// The dispatcher does NOT re-implement the agent call — it loads the
// `agent` plugin definition and invokes its execute() so guardrails,
// quotas, prompt cache, memory, and template rendering all kick in
// exactly as if the workflow had called the agent directly.

import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

// Errors we treat as "try the next link" in fallback chains.
// Guardrail blocks are intentional outcomes — never retried.
function isRetryable(err) {
  if (!err) return false;
  if (err.code === "GUARDRAIL_BLOCKED") return false;
  if (err.code === "QUOTA_EXCEEDED")    return false;
  return true;
}

/**
 * Load a route row by title.
 * Returns null when not found in the active (workspace, project).
 */
export async function loadRoute({ workspaceId, projectId, title }) {
  const { rows } = await pool.query(
    `SELECT id, title, strategy, config
       FROM model_routes
      WHERE workspace_id = $1 AND project_id = $2 AND title = $3`,
    [workspaceId, projectId, title],
  );
  return rows[0] || null;
}

/**
 * Pick the target agent title given a route + caller-supplied tier.
 *
 * Returns:
 *   For static/tier → { kind: "single", agent: "<title>" }
 *   For fallback    → { kind: "chain",  chain: ["<title>", ...] }
 *
 * Throws when the config is malformed (missing agent / tier not in
 * config / empty chain). Caller surfaces these as node errors.
 */
export function planRoute(route, { tier } = {}) {
  const cfg = route.config || {};
  if (route.strategy === "static") {
    if (!cfg.agent) throw new Error(`route "${route.title}": static.agent is required`);
    return { kind: "single", agent: cfg.agent };
  }
  if (route.strategy === "tier") {
    const tiers = cfg.tiers || {};
    const wanted = tier || cfg.default || "balanced";
    const target = tiers[wanted];
    if (!target) {
      throw new Error(
        `route "${route.title}": tier "${wanted}" not defined ` +
        `(have: ${Object.keys(tiers).join(", ") || "none"}).`,
      );
    }
    return { kind: "single", agent: target };
  }
  if (route.strategy === "fallback") {
    const chain = Array.isArray(cfg.chain) ? cfg.chain.filter(Boolean) : [];
    if (!chain.length) throw new Error(`route "${route.title}": fallback.chain is empty`);
    return { kind: "chain", chain };
  }
  throw new Error(`route "${route.title}": unknown strategy "${route.strategy}"`);
}

/**
 * Run the underlying agent invocation through the registered `agent`
 * plugin so the entire side-effect chain (guardrails, quotas,
 * memory, prompt cache, agent_token_events) runs identically to a
 * direct agent call.
 *
 * `agentInput`  — the same shape the agent plugin accepts: { agent,
 *                  input, vars, images, conversationId, … }
 * `ctx, hooks`  — passed through from the workflow runner.
 */
export async function callAgentByTitle({ agentTitle, agentInput, ctx, hooks }) {
  // Dynamic import — avoids a worker-startup cycle with builtin
  // plugin discovery.
  const mod = await import("../plugins/builtin/agent.js");
  const plugin = mod.default;
  return plugin.execute({ ...agentInput, agent: agentTitle }, ctx, hooks);
}

/**
 * Top-level dispatch. Routes are by-name. Returns the agent plugin's
 * output verbatim plus a small `route` block carrying which agent
 * actually answered (handy for downstream nodes that want to log it).
 */
export async function dispatch({ route, agentInput, tier, ctx, hooks }) {
  const plan = planRoute(route, { tier });

  if (plan.kind === "single") {
    const out = await callAgentByTitle({
      agentTitle: plan.agent, agentInput, ctx, hooks,
    });
    return { ...out, route: { strategy: route.strategy, picked: plan.agent } };
  }

  // Fallback chain. We log each attempt through the streaming hook so
  // operators can see the retry trail in the Live output panel.
  let lastErr;
  const tried = [];
  for (const candidate of plan.chain) {
    if (hooks?.stream?.log && tried.length) {
      hooks.stream.log("warn",
        `route "${route.title}" falling back to "${candidate}" after ${lastErr?.message || "no result"}`);
    }
    tried.push(candidate);
    try {
      const out = await callAgentByTitle({
        agentTitle: candidate, agentInput, ctx, hooks,
      });
      return {
        ...out,
        route: {
          strategy: "fallback",
          picked:   candidate,
          tried,
        },
      };
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e)) throw e;
      log.warn("route fallback retry", {
        route: route.title, agent: candidate, error: e.message,
      });
    }
  }
  // Exhausted the chain — rethrow the last error with a wrapper
  // message so it's clear in the failure log this was a route, not a
  // direct agent call.
  const err = new Error(
    `route "${route.title}": all agents in the fallback chain failed. ` +
    `Last error: ${lastErr?.message || "unknown"}`,
  );
  err.code  = "ROUTE_EXHAUSTED";
  err.tried = tried;
  throw err;
}
