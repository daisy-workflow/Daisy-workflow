// Feature — the in-tree `mock` ai.provider.
//
// Configures an ai.provider with provider="mock" + a rule set, runs a
// workflow whose agent node sends input, and asserts the agent's
// reply matches the rule that should fire. No outbound HTTP, no
// docker container — strictly in-process.
//
// This is the canonical "I want to build a workflow without LLM
// credits" recipe. Pair it with the prompt-template + RAG features
// to compose deterministic dev fixtures.

import { test, expect } from "@playwright/test";
import {
  login, uniq,
  createConfig, deleteConfig,
  createAgent, deleteAgent,
  createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
} from "../../helpers/api.js";

test("mock provider — first matching rule returns the configured response", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);
  const { token } = await login();

  const cfgName = uniq("mock-cfg");
  const cfg = await createConfig({
    token, name: cfgName, type: "ai.provider",
    data: {
      provider: "mock",
      model:    "mock-gpt",
      // mockRules is a JSON string per the config schema. First match
      // wins, so put the most-specific rule first.
      mockRules: JSON.stringify([
        { match: "weather",      response: "It is sunny and 72°F." },
        { match: "/^hi/i",       response: "Hello there!" },
        { match: "",             response: "[catch-all] I didn't understand." },
      ]),
      mockDefaultResponse: "fallback shouldn't be reached",
    },
  });

  const agentTitle = uniq("mock-agent");
  const agent = await createAgent({
    token, title: agentTitle, configName: cfgName,
    prompt: "You are a deterministic tester.",
  });

  const wf = await createWorkflow({
    token, name: uniq("mock-wf"),
    dsl: {
      name: "mock-wf", version: "1.0", data: {},
      nodes: [
        { name: "ask", action: "agent",
          inputs: {
            agent: agentTitle,
            input: "what is the weather today?",
          },
          outputs: { result: "answer" } },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 25_000 });
    expect(row.status).toBe("success");

    // The matching rule's `response` should surface somewhere on the
    // execution dump — either ctx.answer (via outputs mapping) or
    // ctx.nodes.ask.output. Be tolerant of where the agent plugin
    // puts the reply.
    const dump = JSON.stringify(row);
    expect(dump).toContain("It is sunny and 72°F.");
  } finally {
    await deleteWorkflow({ token, id: wf.id  }).catch(() => {});
    await deleteAgent({   token, id: agent.id }).catch(() => {});
    await deleteConfig({  token, id: cfg.id   }).catch(() => {});
  }
});

test("mock provider — defaultResponse fires when no rule matched", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);
  const { token } = await login();

  const cfgName = uniq("mock-default");
  const cfg = await createConfig({
    token, name: cfgName, type: "ai.provider",
    data: {
      provider: "mock",
      model:    "mock-gpt",
      mockRules: JSON.stringify([
        { match: "specific-phrase-that-wont-appear", response: "won't fire" },
      ]),
      mockDefaultResponse: "DEFAULT-RESPONSE-MARKER",
    },
  });
  const agentTitle = uniq("mock-default-agent");
  const agent = await createAgent({
    token, title: agentTitle, configName: cfgName,
    prompt: "You are a deterministic tester.",
  });
  const wf = await createWorkflow({
    token, name: uniq("mock-default-wf"),
    dsl: {
      name: "mock-default-wf", version: "1.0", data: {},
      nodes: [
        { name: "ask", action: "agent",
          inputs:  { agent: agentTitle, input: "this prompt won't match" },
          outputs: { result: "answer" } },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 25_000 });
    expect(row.status).toBe("success");
    expect(JSON.stringify(row)).toContain("DEFAULT-RESPONSE-MARKER");
  } finally {
    await deleteWorkflow({ token, id: wf.id  }).catch(() => {});
    await deleteAgent({   token, id: agent.id }).catch(() => {});
    await deleteConfig({  token, id: cfg.id   }).catch(() => {});
  }
});
