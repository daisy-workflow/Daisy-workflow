// agent — run a stored LLM agent against an input text.
//
// Each agent row pairs a system prompt with a stored ai.provider config.
// This plugin sends that prompt + the workflow's `input` text to the
// configured provider and parses the response as JSON.
//
// Memory:
//   • When `conversationId` is set, the plugin loads the last
//     `historyLimit` turns from memories (namespace='history') and
//     replays them as `messages`. After the call, if
//     `storeConversation` is true (the default), the new user input
//     and the model's reply are appended to history.
//   • When `conversationId` is empty, the plugin runs stateless.
//
// Output shape (fixed wrapper):
//   {
//     result:     <parsed JSON object | array | null>,
//     confidence: <number 0–1 | null>,    // pulled from parsed.confidence if present
//     raw:        <full text response>,
//     usage:      { inputTokens, outputTokens }
//   }

import { loadAgent, callProvider, tryParseJson, extractConfidence } from "../agent/util.js";
import { loadHistory, appendHistory } from "../../engine/memoryStore.js";
import { chargeTokens } from "../../engine/limits.js";
import {
  loadProjectPolicy,
  mergePolicy,
  applyGuardrails,
} from "../../guardrails/apply.js";
import { render as renderPrompt } from "../../prompts/render.js";

export default {
  name: "agent",
  description:
    "Invoke a stored LLM agent. The `agent` input names a configured agent " +
    "(Home page → Agents). Set `conversationId` to enable per-conversation " +
    "memory; the plugin auto-loads prior turns and (when storeConversation " +
    "is true) auto-appends the new exchange. The response is JSON-parsed " +
    "into `result` along with confidence, raw text, and token usage.",

  inputSchema: {
    type: "object",
    required: ["agent", "input"],
    properties: {
      agent: {
        type: "string",
        title: "Agent",
        minLength: 1,
        description: "Title of a stored agent. Manage from the Home page → Agents.",
      },
      input: {
        type: "string",
        title: "Input",
        format: "textarea",
        description:
          "Text passed to the agent. Usually a `${var}` reference to an " +
          "upstream node's output.",
      },
      conversationId: {
        type: "string",
        title: "Conversation ID",
        description:
          "Optional. When set, this node's memory is grouped under this " +
          "key. Use ${userId} or any expression that's stable per " +
          "conversation. Leave empty for a stateless call.",
      },
      storeConversation: {
        type: "boolean",
        title: "Store this exchange in memory",
        default: true,
        description:
          "Only used when conversationId is set. Off = read-only " +
          "(prior turns are loaded into the prompt but the new exchange " +
          "is NOT appended to history).",
      },
      historyLimit: {
        type: "integer",
        title: "History turn limit",
        minimum: 0, maximum: 200, default: 20,
        description:
          "Number of past turns to load (0 = no history). Each turn is " +
          "one message. Older turns are discarded.",
      },
      maxTokens: {
        type: "integer",
        title: "Max output tokens",
        minimum: 1, maximum: 16000, default: 2048,
        description: "Upper bound on the model's response length.",
      },
      vars: {
        type: "object",
        title: "Template variables",
        description:
          "Object of values for `${var}` placeholders when the agent " +
          "is bound to a prompt template. Ignored for agents that use " +
          "an inline prompt.",
      },
      images: {
        type: "array",
        title: "Images",
        description:
          "Optional. Image inputs for vision-capable models. Each item " +
          "can be an https URL, a `data:image/...;base64,...` URL, or a " +
          "raw base64 body (PNG/JPEG/GIF/WebP). Skipped on models that " +
          "don't support vision — check the provider's docs first.",
        items: { type: "string" },
      },
    },
  },

  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "result",

  outputSchema: {
    type: "object",
    required: ["raw", "usage"],
    properties: {
      result:     {                        description: "Parsed JSON the agent emitted, or null if the response wasn't JSON." },
      confidence: { type: ["number","null"], description: "0–1 score the agent emitted under `confidence`, normalised. Null if absent." },
      raw:        { type: "string",        description: "Full text response from the model." },
      usage: {
        type: "object",
        properties: {
          inputTokens:  { type: "integer" },
          outputTokens: { type: "integer" },
        },
      },
    },
  },

  async execute(input, ctx, hooks) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);

    // Resolve the system prompt: when the agent is bound to a prompt
    // template, render it with the call's `vars` (and a few well-known
    // built-ins like `input` so the template can reference the user
    // text directly). Otherwise fall back to the inline prompt column.
    const systemPrompt = agent.template_body
      ? renderPrompt(agent.template_body, {
          ...(input.vars || {}),
          input: input.input,
          agent: agent.title,
        })
      : agent.prompt;

    let userText        = String(input.input ?? "");
    const convId        = input.conversationId ? String(input.conversationId) : null;
    const storeNew      = input.storeConversation !== false;
    const historyLimit  = input.historyLimit ?? 20;
    const scopeId       = ctx?.execution?.graphId || null;
    const workspaceId   = ctx?.execution?.workspaceId;
    const projectId     = ctx?.execution?.projectId;

    // ── Guardrails: input side ─────────────────────────────────
    // Load the project policy + merge the agent-level override on
    // top, then scan the user text. PII may be redacted (the userText
    // we pass to the LLM is the masked version); jailbreak / toxicity
    // in block mode throws GuardrailBlockedError which the executor
    // surfaces as a node failure.
    const guardrailCtx = {
      workspaceId,
      projectId,
      executionId: ctx?.execution?.id || null,
      node:        ctx?.node?.name || null,
      agentId:     agent.id,
      agentTitle:  agent.title,
    };
    const projectPolicy = await loadProjectPolicy(projectId);
    const policy = mergePolicy(projectPolicy, agent.guardrails_override);
    {
      const r = await applyGuardrails({
        text:   userText,
        side:   "input",
        policy,
        ctx:    guardrailCtx,
      });
      if (r.text !== userText) {
        userText = r.text;
        if (hooks?.stream?.log) {
          hooks.stream.log("warn",
            `guardrails redacted input (${r.violations.map(v => v.detector).join(", ")})`);
        }
      }
      // Non-redact violations (warn) are recorded inside applyGuardrails;
      // we surface them as a one-line note in the Live output panel.
      const warned = r.violations.filter(v => v.action_taken === "warned");
      if (warned.length && hooks?.stream?.log) {
        hooks.stream.log("warn",
          `guardrails flagged input: ${warned.map(v => v.detector).join(", ")}`);
      }
    }

    // Memory load: pull prior turns into a `messages` array. Empty when
    // conversationId is unset or historyLimit is 0.
    const history = (convId && historyLimit > 0 && workspaceId)
      ? await loadHistory({
          workspaceId,
          scope:          "workflow",
          scopeId,
          conversationId: convId,
          limit:          historyLimit,
        })
      : [];
    const messages = [...history, { role: "user", content: userText }];

    // RBAC v2 quota: refuse the call when the project has hit its
    // monthly token cap. This is a pre-call check; the post-call
    // increment lives below. Pre-call avoids spending tokens we know
    // we can't account for, even though "we exceeded slightly because
    // of races" is acceptable when several concurrent calls slip
    // through together. Same fire-and-late-import pattern as the
    // increment side to keep the boot path clean.
    if (projectId) {
      try {
        const { assertQuota } = await import("../../auth/quotas.js");
        await assertQuota(projectId, "tokens_per_month");
      } catch (e) {
        if (e.code === "QUOTA_EXCEEDED") {
          // Surface as a normal node-level error. The executor's
          // failure path will record it on the node + halt the run.
          throw e;
        }
        // Other errors (DB unreachable) are noisy; treat as
        // permissive — quota tracking shouldn't bring down the engine.
      }
    }

    const onText = hooks?.stream?.text ? (chunk) => hooks.stream.text(chunk) : null;
    if (hooks?.stream?.log) {
      hooks.stream.log(
        "info",
        `agent "${agent.title}" → ${cfg.provider}/${cfg.model}` +
        (convId ? ` (conversation=${convId}, history=${history.length} turn${history.length === 1 ? "" : "s"})` : "")
      );
      // One-shot warning when the model is a floating alias (e.g.
      // "gpt-4o" instead of "gpt-4o-2024-11-20"). Providers silently
      // roll new defaults; a pinned date keeps workflow behaviour
      // stable for compliance + regression-test reasons.
      try {
        const { pinningWarning } = await import("../agent/pricing.js");
        const warn = pinningWarning(cfg.model);
        if (warn) hooks.stream.log("warn", warn);
      } catch { /* pricing missing — non-fatal */ }
    }

    const maxTokens = input.maxTokens || 2048;

    // Prompt cache check — only when streaming is OFF (a cached
    // response can't honour an onText callback meaningfully). Same
    // cache key for the matching cache.set() below.
    const cacheMod = await import("../agent/cache.js");
    const cacheKey = onText ? null : cacheMod.keyFor({
      provider: cfg.provider,
      model:    cfg.model,
      // Use the resolved system prompt — templates render to
      // different bodies per call, so two calls with the same
      // template but different vars must NOT share a cache entry.
      system:   systemPrompt,
      messages,
      maxTokens,
      // Include images in the cache key so a vision call doesn't
      // serve a text-only cached response.
      images:   input.images,
    });
    let cached = cacheKey ? cacheMod.get(cacheKey) : null;

    let text, usage, latencyMs;
    if (cached) {
      text  = cached.text;
      usage = cached.usage;
      latencyMs = 0;
      if (hooks?.stream?.log) hooks.stream.log("info", `agent "${agent.title}" cache hit`);
    } else {
      const startedAt = Date.now();
      const out = await callProvider({
        cfg,
        system:    systemPrompt,
        messages,
        maxTokens,
        // Vision inputs — providers that support it attach images to
        // the last user message internally. Providers without vision
        // simply ignore the field.
        images:    input.images,
        onText,
      });
      text  = out.text;
      usage = out.usage;
      latencyMs = Date.now() - startedAt;
      if (cacheKey) cacheMod.set(cacheKey, { text, usage });
    }

    // Charge the run-wide token budget. Sum of input + output tokens
    // is accumulated on ctx._tokens by chargeTokens; if the running
    // total crosses EXECUTION_MAX_TOKENS (or the workflow's
    // maxTokens override on ctx._parsed) it throws
    // BudgetExhaustedError — caught by the executor's retry loop /
    // failure path as a terminal error.
    //
    // 0 / null usage (provider didn't return token counts) charges
    // nothing, which is the safer default — we'd rather under-count
    // than fail a successful call because of a missing field.
    const inTok  = Number(usage?.inputTokens)  || 0;
    const outTok = Number(usage?.outputTokens) || 0;
    chargeTokens(ctx, ctx?._parsed, inTok + outTok);

    // RBAC v2 quota + per-call event recording. Two writes:
    //   1. increment the rolled-up quota_usage counter (for
    //      enforcement on the next call)
    //   2. append a row to agent_token_events (for breakdowns by
    //      model / agent / time bucket on the admin page)
    //
    // Both are fire-and-forget — metering shouldn't slow the user's
    // response. Dynamic imports avoid the engine ↔ auth cycle.
    if (projectId) {
      try {
        const { incrementUsage } = await import("../../auth/quotas.js");
        // Cached calls don't double-count against the monthly token
        // quota — they didn't actually spend tokens this time.
        if (!cached) {
          incrementUsage(projectId, "tokens_per_month", inTok + outTok)
            .catch(() => { /* swallowed inside the helper */ });
        }
        const { recordAgentTokenEvent } = await import("../agent/usage.js");
        recordAgentTokenEvent({
          workspaceId,
          projectId,
          executionId: ctx?.execution?.id || null,
          agentId:     agent.id,
          agentTitle:  agent.title,
          provider:    cfg.provider,
          model:       cfg.model,
          inputTokens: inTok,
          outputTokens: outTok,
          cacheHit:    !!cached,
          latencyMs,
        }).catch(() => { /* metering best-effort */ });
      } catch { /* ignore — telemetry-grade */ }
    }

    // ── Guardrails: output side ────────────────────────────────
    // Runs BEFORE memory write so any PII redactions land in
    // conversation history too — otherwise the next call's history
    // replay would resurrect the unmasked text into the prompt.
    // Block mode throws GuardrailBlockedError which the executor's
    // failure path treats as a terminal node error.
    {
      const r = await applyGuardrails({
        text:   text,
        side:   "output",
        policy,
        ctx:    guardrailCtx,
      });
      if (r.text !== text) {
        text = r.text;
        if (hooks?.stream?.log) {
          hooks.stream.log("warn",
            `guardrails redacted output (${r.violations.map(v => v.detector).join(", ")})`);
        }
      }
      const warned = r.violations.filter(v => v.action_taken === "warned");
      if (warned.length && hooks?.stream?.log) {
        hooks.stream.log("warn",
          `guardrails flagged output: ${warned.map(v => v.detector).join(", ")}`);
      }
    }

    // Memory store: if conversationId is set AND storeConversation is true,
    // append both turns. Two rows so a future load reconstructs the
    // exchange in order. Uses the post-guardrail `userText` + `text`
    // so PII redactions persist into future conversation context.
    if (convId && storeNew && workspaceId) {
      try {
        await appendHistory({
          workspaceId,
          scope: "workflow", scopeId,
          conversationId: convId,
          role: "user", content: userText,
        });
        await appendHistory({
          workspaceId,
          scope: "workflow", scopeId,
          conversationId: convId,
          role: "assistant", content: text,
        });
      } catch (e) {
        // Memory write failures shouldn't lose a successful agent call.
        // Log it through the streaming hook so the user sees the issue
        // in the Live output panel; the plugin still returns success.
        if (hooks?.stream?.log) {
          hooks.stream.log("warn", `memory append failed: ${e.message}`);
        }
      }
    }

    const parsed     = tryParseJson(text);
    const confidence = extractConfidence(parsed);
    return {
      result:     parsed,
      confidence,
      raw:        text,
      usage,
    };
  },
};
