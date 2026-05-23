// Feature — an agent can be bound to a prompt template. When bound,
// the agent row carries prompt_template_id and the inline `prompt`
// column is allowed to be empty; the worker resolves the actual
// prompt from prompt_templates.body at call time.
//
// Smoke-level assertion that the binding round-trips:
//   1. Create a prompt template with a known body
//   2. Create an agent with prompt_template_id set
//   3. GET /agents/:id back, confirm the binding is persisted

import { test, expect } from "@playwright/test";
import {
  login, uniq,
  createConfig, deleteConfig,
  createPromptTemplate, deletePromptTemplate,
  createAgent, getAgent, deleteAgent,
} from "../../helpers/api.js";

test("agent — binds to a prompt template, binding round-trips", async ({}, testInfo) => {
  testInfo.setTimeout(30_000);
  const { token } = await login();

  // Agents require a config (LLM creds + provider). Type is
  // `ai.provider` — see backend/src/configs/registry.js. The provider
  // FIELD is what flips between openai / anthropic / etc; the config
  // TYPE is always `ai.provider`. Workspace-shared so the agent under
  // test can resolve it regardless of project.
  const cfg = await createConfig({
    token,
    name: uniq("bound-cfg"),
    type: "ai.provider",
    data: { provider: "openai", apiKey: "sk-test-not-real", model: "gpt-4o-mini" },
    sharedAtWorkspace: true,
  });

  const tmpl = await createPromptTemplate({
    token,
    title: uniq("bound-tmpl"),
    body:  "You are a helpful tester. The codeword is ${codeword}.",
    variables: [{ name: "codeword", required: true }],
    sharedAtWorkspace: true,
  });

  // Inline prompt is intentionally empty — the template provides it.
  const agent = await createAgent({
    token,
    title:            uniq("bound-agent"),
    configName:       cfg.name,
    prompt:           "",                  // empty allowed when templateId is set
    promptTemplateId: tmpl.id,
  });

  try {
    expect(agent.id).toBeTruthy();

    const got = await getAgent({ token, id: agent.id });
    // The agent row should carry the binding. Backend column name is
    // prompt_template_id (snake_case from the SELECT a.*).
    expect(got.prompt_template_id).toBe(tmpl.id);
    // And the inline prompt should be what we set (empty string).
    expect(got.prompt || "").toBe("");
  } finally {
    await deleteAgent({ token, id: agent.id }).catch(() => {});
    await deletePromptTemplate({ token, id: tmpl.id }).catch(() => {});
    await deleteConfig({ token, id: cfg.id }).catch(() => {});
  }
});
