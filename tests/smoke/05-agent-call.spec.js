// Smoke — make ONE agent call against the mock LLM responder. Proves:
//   1. An ai.provider config can be created + decrypted.
//   2. The agent plugin's full path runs (loadAgent, callProvider,
//      tryParseJson, chargeTokens, guardrails) end-to-end against a
//      fake upstream.
//   3. The token rollup row lands (we don't read it here — Layer 2
//      will — but a successful run is enough for smoke).

import { test, expect } from "@playwright/test";
import {
  login, createConfig, createAgent,
  createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
} from "../helpers/api.js";
import { startMockLlm, stopMockLlm, MOCK_LLM_URL } from "../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });
test.afterAll(async  () => { await stopMockLlm();  });

test("agent — single LLM call against the mock provider succeeds", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);

  const { token } = await login();

  // 1. ai.provider config pointed at our mock URL. The model name
  //    is unused — the mock answers everything — but the field is
  //    required by the schema.
  const cfgName = `mock-openai-${Date.now()}`;
  await createConfig({
    token,
    name: cfgName,
    type: "ai.provider",
    data: {
      provider: "openai",
      model:    "gpt-4o-mini",
      apiKey:   "sk-mock-not-real",
      baseUrl:  MOCK_LLM_URL,
    },
  });

  // 2. An agent that uses the mock config.
  const agentTitle = `smoke-agent-${Date.now()}`;
  await createAgent({
    token,
    title:      agentTitle,
    configName: cfgName,
    prompt:     "You are a tester. Always reply with JSON: {\"result\":\"ok\"}.",
  });

  // 3. A workflow with one agent node.
  //
  // The user input embeds a per-run unique token so the agent's
  // in-process prompt cache (keyed on
  // {provider, model, system, messages, maxTokens}) doesn't return
  // a stale empty response from a previous run. Without this, the
  // mock LLM's reply gets cached on the first call; subsequent runs
  // skip the network entirely and replay whatever was cached —
  // including the empty body from a botched earlier run.
  const cacheBuster = `[${Date.now()}-${Math.random().toString(36).slice(2, 8)}]`;
  const wf = await createWorkflow({
    token,
    name: `smoke-agent-${Date.now()}`,
    dsl:  {
      name:    "smoke-agent",
      version: "1.0",
      data:    {},
      nodes: [
        {
          name:    "ask",
          action:  "agent",
          inputs:  { agent: agentTitle, input: `hello ${cacheBuster}` },
          outputs: { result: "answer" },
        },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });
    //console.log("Mock LLM :", MOCK_LLM_URL);
    //console.log("Execution finished — trace:", JSON.stringify(row, null, 2));
    expect(row.status).toBe("success");

    // Proof the agent actually reached the mock + parsed its response:
    //   • EITHER the mock's literal payload appears in the dump
    //     (i.e. the openai provider got our canned content), OR
    //   • the recorded usage shows non-zero input tokens (the mock
    //     advertised prompt_tokens: 12, which the provider records
    //     verbatim).
    // Either signal alone is enough to know the round-trip happened;
    // both fail only when the mock wasn't hit at all (network /
    // resolution / cache-hit-on-empty) — in which case the trace +
    // worker logs will show why.
    const dump = JSON.stringify(row);
    const askNode = row?.context?.nodes?.ask
                 || row?.node_states?.find(n => n.node_name === "ask")?.output;
    const inputTokens = askNode?.output?.usage?.inputTokens
                     || askNode?.usage?.inputTokens
                     || 0;
    expect(
      /mocked/.test(dump) || inputTokens > 0,
      `agent didn't reach the mock LLM — raw="${askNode?.output?.raw || askNode?.raw || ""}", ` +
      `inputTokens=${inputTokens}. The mock-llm sidecar should be reachable at ` +
      `http://mock-llm:9123/v1 from inside the worker container. Verify with:\n` +
      `  docker exec dag_worker_test wget -qO- http://mock-llm:9123/v1/chat/completions ` +
      `--post-data='{}' --header='content-type: application/json'\n` +
      `  docker logs dag_mock_llm_test --tail 20`,
    ).toBeTruthy();
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
