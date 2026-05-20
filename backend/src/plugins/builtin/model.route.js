// model.route — dispatch an agent call via a named route.
//
// A model_routes row tells the dispatcher which agent to actually
// invoke. The route is named — workflows reference the title rather
// than baking in a specific agent, so swapping models for an entire
// project is a one-row edit on the Model Routes page instead of a
// search-and-replace across every workflow.
//
// Three strategies (schema in src/routing/dispatcher.js):
//   static    — always one agent
//   tier      — cheap / balanced / strong; caller picks (or default)
//   fallback  — try the chain in order on error
//
// Output is the underlying agent plugin's output verbatim, plus a
// small `route` block recording which agent actually answered.

import { loadRoute, dispatch } from "../../routing/dispatcher.js";

export default {
  name: "model.route",
  description:
    "Call an agent through a named route (static / tier / fallback). " +
    "Routes are configured under Home → Model routes; the agent itself " +
    "is selected at call time per the route's strategy.",

  inputSchema: {
    type: "object",
    required: ["route", "input"],
    properties: {
      route: {
        type: "string",
        title: "Route title",
        description: "Title of a model_routes row in the active project.",
      },
      input: {
        type: "string",
        title: "Input",
        format: "textarea",
        description: "Text passed to the underlying agent.",
      },
      tier: {
        type: "string",
        title: "Tier",
        description:
          "For strategy=tier only. Overrides the route's default tier " +
          "(typically: cheap | balanced | strong).",
      },
      vars: {
        type: "object",
        title: "Template variables",
        description:
          "Forwarded to the underlying agent (used when its prompt " +
          "template has ${var} placeholders).",
      },
      images: {
        type: "array",
        title: "Images",
        description:
          "Optional. Image inputs (urls, data URLs, or base64) — passed " +
          "through to the agent for vision-capable models.",
        items: { type: "string" },
      },
      conversationId: {
        type: "string",
        title: "Conversation ID",
        description: "Forwarded to the agent for per-conversation memory.",
      },
      maxTokens: {
        type: "integer",
        title: "Max output tokens",
        minimum: 1, maximum: 16000, default: 2048,
      },
    },
  },

  // Same primary output as the agent plugin — keeps downstream nodes
  // structurally identical whether they call agent.* or model.route.
  primaryOutput: "result",

  outputSchema: {
    type: "object",
    required: ["raw", "usage", "route"],
    properties: {
      result:     { description: "Parsed JSON the agent emitted." },
      confidence: { type: ["number", "null"] },
      raw:        { type: "string" },
      usage: {
        type: "object",
        properties: {
          inputTokens:  { type: "integer" },
          outputTokens: { type: "integer" },
        },
      },
      route: {
        type: "object",
        properties: {
          strategy: { type: "string" },
          picked:   { type: "string", description: "Agent that actually answered." },
          tried:    { type: "array", items: { type: "string" }, description: "Fallback only — chain attempted before success." },
        },
      },
    },
  },

  async execute(input, ctx, hooks) {
    const workspaceId = ctx?.execution?.workspaceId;
    const projectId   = ctx?.execution?.projectId;
    if (!workspaceId || !projectId) {
      throw new Error("model.route: execution must run inside a workspace + project");
    }
    const route = await loadRoute({ workspaceId, projectId, title: String(input.route || "") });
    if (!route) {
      throw new Error(`model.route: unknown route "${input.route}"`);
    }

    if (hooks?.stream?.log) {
      hooks.stream.log("info",
        `route "${route.title}" (${route.strategy}) → resolving`);
    }

    const agentInput = {
      input:          input.input,
      vars:           input.vars,
      images:         input.images,
      conversationId: input.conversationId,
      maxTokens:      input.maxTokens,
    };
    return dispatch({
      route, agentInput, tier: input.tier, ctx, hooks,
    });
  },
};
