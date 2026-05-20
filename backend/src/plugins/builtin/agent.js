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

    const userText      = String(input.input ?? "");
    const convId        = input.conversationId ? String(input.conversationId) : null;
    const storeNew      = input.storeConversation !== false;
    const historyLimit  = input.historyLimit ?? 20;
    const scopeId       = ctx?.execution?.graphId || null;
    const workspaceId   = ctx?.execution?.workspaceId;
    const projectId     = ctx?.execution?.projectId;

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
    }

    const { text, usage } = await callProvider({
      cfg,
      system:    agent.prompt,
      messages,
      maxTokens: input.maxTokens || 2048,
      onText,
    });

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

    // RBAC v2 quota: charge the project's monthly token budget.
    // Fire-and-forget on the increment — quota tracking shouldn't
    // delay the user's response. The next agent call (or workflow
    // enqueue) re-reads the running total before deciding to proceed.
    if (projectId) {
      // Dynamic import avoids the engine ↔ auth dependency cycle: this
      // plugin file is loaded inside the worker boot path, and pulling
      // auth/quotas at module-init pulls all of auth which itself
      // touches DB pool init. Late import is cheap (cached) and keeps
      // boot ordering deterministic.
      try {
        const { incrementUsage } = await import("../../auth/quotas.js");
        incrementUsage(projectId, "tokens_per_month", inTok + outTok)
          .catch(() => { /* swallowed inside the helper */ });
      } catch { /* ignore — telemetry-grade */ }
    }

    // Memory store: if conversationId is set AND storeConversation is true,
    // append both turns. Two rows so a future load reconstructs the
    // exchange in order.
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
