// API client used by Playwright tests to seed fixtures + drive the
// backend faster than clicking through the UI. Two principles:
//
//   1. Fixtures via the API, never via the UI. Tests should test the
//      UI, not seed data through it (slow + flaky).
//   2. Re-use the SAME endpoints the Vue app talks to so the
//      contract drift is automatic — if the API changes, both the UI
//      and these helpers feel it.
//
// Login flow:
//   • POST /auth/login → { accessToken, ... }   + sets refresh cookie
//   • Every subsequent call sends `Authorization: Bearer <accessToken>`
//
// The accessToken is short-lived; for the smoke suite (a few minutes)
// we don't bother refreshing — one login per test file is plenty.

const API_URL = process.env.TEST_API_URL || "http://localhost:3001";

export const TEST_ADMIN = {
  email:    process.env.TEST_ADMIN_EMAIL    || "admin@test.local",
  password: process.env.TEST_ADMIN_PASSWORD || "Test12345!Test",
};

/**
 * Log in as the bootstrap admin (seeded by the worker-test container
 * on first boot). Returns { token, user }.
 */
export async function login({ email, password } = TEST_ADMIN) {
  const res = await fetch(`${API_URL}/auth/login`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`api.login failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const body  = await res.json();
  // The API returns { accessToken, user } today; absorb either name
  // for forward-compat.
  const token = body.accessToken || body.token;
  if (!token) throw new Error("api.login: response missing accessToken");
  return { token, user: body.user || null };
}

/**
 * Convenience wrapper that does GET / POST / PUT / DELETE against the
 * backend with the supplied bearer token. Returns the parsed JSON body
 * on 2xx, throws on anything else.
 */
async function call({ token, method = "GET", path, body }) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`api ${method} ${path} → ${res.status} ${txt.slice(0, 300)}`);
  }
  // 204 No Content shows up on some DELETE paths.
  if (res.status === 204) return null;
  return res.json();
}

// ── Workflow fixtures ────────────────────────────────────────────

export async function createWorkflow({ token, name, dsl }) {
  return call({
    token, method: "POST", path: "/graphs",
    body: { name, dsl: dsl || EMPTY_DSL },
  });
}

export async function deleteWorkflow({ token, id }) {
  return call({ token, method: "DELETE", path: `/graphs/${id}` });
}

export async function executeWorkflow({ token, id, inputs = {} }) {
  return call({
    token, method: "POST", path: `/graphs/${id}/execute`,
    body: { inputs },
  });
}

export async function getExecution({ token, id }) {
  return call({ token, method: "GET", path: `/executions/${id}` });
}

/** Poll the execution endpoint until the run leaves the running/queued
 *  state. Returns the final execution row. */
export async function waitForExecution({ token, id, timeoutMs = 30_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getExecution({ token, id });
    if (row && row.status && !["running", "queued", "waiting"].includes(row.status)) {
      return row;
    }
    await sleep(intervalMs);
  }
  throw new Error(`execution ${id} did not finish within ${timeoutMs}ms`);
}

// ── Config + agent fixtures ──────────────────────────────────────

export async function createConfig({ token, name, type, data, sharedAtWorkspace = true }) {
  return call({
    token, method: "POST", path: "/configs",
    body: { name, type, data, sharedAtWorkspace },
  });
}

export async function createAgent({ token, title, configName, prompt }) {
  return call({
    token, method: "POST", path: "/agents",
    body: { title, config_name: configName, prompt },
  });
}

// ── Plugin catalog ───────────────────────────────────────────────

export async function listPlugins({ token }) {
  return call({ token, method: "GET", path: "/plugins" });
}

// ── Auth / current user ─────────────────────────────────────────

export async function getMe({ token }) {
  return call({ token, method: "GET", path: "/auth/me" });
}

// ── Workflow extras ─────────────────────────────────────────────

export async function listWorkflows({ token }) {
  return call({ token, method: "GET", path: "/graphs" });
}

export async function updateWorkflow({ token, id, name, dsl }) {
  return call({ token, method: "PUT", path: `/graphs/${id}`,
    body: { name, dsl } });
}

// ── Agent fixtures ──────────────────────────────────────────────

export async function listAgents({ token }) {
  return call({ token, method: "GET", path: "/agents" });
}

export async function deleteAgent({ token, id }) {
  return call({ token, method: "DELETE", path: `/agents/${id}` });
}

// ── Config helpers ──────────────────────────────────────────────

export async function listConfigs({ token }) {
  return call({ token, method: "GET", path: "/configs" });
}

export async function deleteConfig({ token, id }) {
  return call({ token, method: "DELETE", path: `/configs/${id}` });
}

// ── Prompt templates ────────────────────────────────────────────

export async function createPromptTemplate({ token, title, body, description, variables, sharedAtWorkspace = true }) {
  return call({ token, method: "POST", path: "/prompt-templates",
    body: { title, body, description, variables: variables || [], sharedAtWorkspace } });
}

export async function listPromptTemplates({ token }) {
  return call({ token, method: "GET", path: "/prompt-templates" });
}

export async function deletePromptTemplate({ token, id }) {
  return call({ token, method: "DELETE", path: `/prompt-templates/${id}` });
}

export async function previewPromptTemplate({ token, body, vars }) {
  return call({ token, method: "POST", path: "/prompt-templates/preview",
    body: { body, vars: vars || {} } });
}

// ── Projects (workspace admin) ──────────────────────────────────

export async function listProjects({ token }) {
  return call({ token, method: "GET", path: "/projects" });
}

export async function createProject({ token, name, slug, description }) {
  return call({ token, method: "POST", path: "/projects",
    body: { name, slug, description } });
}

export async function deleteProject({ token, id }) {
  return call({ token, method: "DELETE", path: `/projects/${id}` });
}

/**
 * Unique-suffix helper used by every Layer-2 spec — tests in parallel
 * shouldn't clash on names. Pair with cleanup in `finally` blocks.
 */
export function uniq(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// ── Knowledge bases ─────────────────────────────────────────────

export async function createKb({ token, title, embeddingProvider = "openai", embeddingModel = "text-embedding-3-small", chunkSize = 800, chunkOverlap = 100 }) {
  return call({ token, method: "POST", path: "/knowledge-bases",
    body: { title, embeddingProvider, embeddingModel, chunkSize, chunkOverlap, kbBackend: "pgvector" } });
}

export async function listKbs({ token }) {
  return call({ token, method: "GET", path: "/knowledge-bases" });
}

export async function deleteKb({ token, id }) {
  return call({ token, method: "DELETE", path: `/knowledge-bases/${id}` });
}

/** Ingest a text document directly (no file upload). The KB API
 *  exposes /knowledge-bases/:id/documents (POST text payload). */
export async function ingestKbText({ token, kbId, title, text }) {
  return call({ token, method: "POST", path: `/knowledge-bases/${kbId}/documents`,
    body: { title, text, sourceType: "inline" } });
}

export async function queryKb({ token, kbId, query, topK = 5 }) {
  return call({ token, method: "POST", path: `/knowledge-bases/${kbId}/query`,
    body: { query, topK } });
}

// ── Guardrails ──────────────────────────────────────────────────

export async function getGuardrailPolicy({ token }) {
  return call({ token, method: "GET", path: "/guardrails/policy" });
}

export async function setGuardrailPolicy({ token, apply_to = "both", config = {} }) {
  return call({ token, method: "PUT", path: "/guardrails/policy",
    body: { apply_to, config } });
}

/** Probe an arbitrary string against the active policy + an
 *  optional in-progress policy override. Returns
 *  { blocked, text, violations } or the 403/blocked shape. */
export async function testGuardrails({ token, text, side = "input", policy }) {
  return call({ token, method: "POST", path: "/guardrails/test",
    body: { text, side, ...(policy ? { policy } : {}) } });
}

// ── Eval suites + cases + runs ──────────────────────────────────

export async function createEvalSuite({ token, title, description, agent_id }) {
  return call({ token, method: "POST", path: "/evals/suites",
    body: { title, description, agent_id } });
}

export async function deleteEvalSuite({ token, id }) {
  return call({ token, method: "DELETE", path: `/evals/suites/${id}` });
}

export async function createEvalCase({ token, suiteId, title, inputs, expected, scorers, position }) {
  return call({ token, method: "POST", path: `/evals/suites/${suiteId}/cases`,
    body: { title, inputs, expected, scorers, position } });
}

export async function runEvalSuite({ token, suiteId }) {
  return call({ token, method: "POST", path: `/evals/suites/${suiteId}/runs`, body: {} });
}

// ── Model routes ────────────────────────────────────────────────

export async function createModelRoute({ token, title, strategy, config }) {
  return call({ token, method: "POST", path: "/model-routes",
    body: { title, strategy, config } });
}

export async function listModelRoutes({ token }) {
  return call({ token, method: "GET", path: "/model-routes" });
}

export async function deleteModelRoute({ token, id }) {
  return call({ token, method: "DELETE", path: `/model-routes/${id}` });
}

// ── Audit + workflow metrics ────────────────────────────────────

export async function listAudit({ token, action, from, to, limit = 50 }) {
  const q = new URLSearchParams();
  if (action) q.set("action", action);
  if (from)   q.set("from",   from);
  if (to)     q.set("to",     to);
  if (limit)  q.set("limit",  String(limit));
  return call({ token, method: "GET", path: `/audit?${q}` });
}

export async function listWorkflowMetrics({ token, name, executionId, limit = 50 }) {
  const q = new URLSearchParams();
  if (name)        q.set("name",        name);
  if (executionId) q.set("executionId", executionId);
  if (limit)       q.set("limit",       String(limit));
  return call({ token, method: "GET", path: `/workflow-metrics?${q}` });
}

// ── Plugin install from catalog ─────────────────────────────────

export async function getPluginCatalog({ token }) {
  return call({ token, method: "GET", path: "/plugins/catalog" });
}

// ── Service accounts ────────────────────────────────────────────

export async function createServiceAccount({ token, name, description, role = "editor" }) {
  return call({ token, method: "POST", path: "/service-accounts",
    body: { name, description, role } });
}

export async function listServiceAccounts({ token }) {
  return call({ token, method: "GET", path: "/service-accounts" });
}

export async function deleteServiceAccount({ token, id }) {
  return call({ token, method: "DELETE", path: `/service-accounts/${id}` });
}

export async function mintServiceAccountKey({ token, id, label }) {
  return call({ token, method: "POST", path: `/service-accounts/${id}/keys`,
    body: { label } });
}

export async function revokeServiceAccountKey({ token, id, keyId }) {
  return call({ token, method: "POST", path: `/service-accounts/${id}/keys/${keyId}/revoke` });
}

// ── Custom roles ────────────────────────────────────────────────

export async function listCustomRoleCatalog({ token }) {
  return call({ token, method: "GET", path: "/custom-roles/catalog" });
}

export async function createCustomRole({ token, name, description, permissions }) {
  return call({ token, method: "POST", path: "/custom-roles",
    body: { name, description, permissions } });
}

export async function listCustomRoles({ token }) {
  return call({ token, method: "GET", path: "/custom-roles" });
}

export async function deleteCustomRole({ token, id }) {
  return call({ token, method: "DELETE", path: `/custom-roles/${id}` });
}

// ── Cross-project grants ────────────────────────────────────────

export async function listCrossProjectGrants({ token }) {
  return call({ token, method: "GET", path: "/cross-project-grants" });
}

export async function grantCrossProject({ token, callerProjectId, calleeProjectId }) {
  return call({ token, method: "POST", path: "/cross-project-grants",
    body: { callerProjectId, calleeProjectId } });
}

export async function revokeCrossProject({ token, callerProjectId, calleeProjectId }) {
  return call({ token, method: "DELETE", path: "/cross-project-grants",
    body: { callerProjectId, calleeProjectId } });
}

// ── JIT elevation ───────────────────────────────────────────────

export async function createJitGrant({ token, userId, scopeType, scopeId, role, reason, durationMinutes }) {
  return call({ token, method: "POST", path: "/jit-grants",
    body: { userId, scopeType, scopeId, role, reason, durationMinutes } });
}

export async function listJitGrants({ token }) {
  return call({ token, method: "GET", path: "/jit-grants" });
}

export async function listMyJitGrants({ token }) {
  return call({ token, method: "GET", path: "/jit-grants/mine" });
}

export async function revokeJitGrant({ token, id }) {
  return call({ token, method: "POST", path: `/jit-grants/${id}/revoke`, body: {} });
}

// ── Quotas ──────────────────────────────────────────────────────

export async function listQuotas({ token }) {
  return call({ token, method: "GET", path: "/quotas" });
}

export async function setQuota({ token, kind, limit }) {
  return call({ token, method: "PUT", path: `/quotas/${kind}`,
    body: { limit } });
}

export async function deleteQuota({ token, kind }) {
  return call({ token, method: "DELETE", path: `/quotas/${kind}` });
}

// ── SAML config ─────────────────────────────────────────────────

export async function getSamlConfig({ token }) {
  return call({ token, method: "GET", path: "/saml-configs" });
}

export async function setSamlConfig({ token, ...body }) {
  return call({ token, method: "PUT", path: "/saml-configs", body });
}

export async function deleteSamlConfig({ token }) {
  return call({ token, method: "DELETE", path: "/saml-configs" });
}

// ── Compliance + residency ──────────────────────────────────────

export async function getComplianceSettings({ token }) {
  return call({ token, method: "GET", path: "/compliance" });
}

export async function setComplianceSettings({ token, mode, residency, settings }) {
  return call({ token, method: "PUT", path: "/compliance",
    body: { mode, residency, settings } });
}

export async function exportUserData({ token, userId }) {
  return call({ token, method: "GET", path: `/compliance/users/${userId}/export` });
}

export async function eraseUser({ token, userId }) {
  return call({ token, method: "DELETE", path: `/compliance/users/${userId}` });
}

// ── Execution control (HITL resume) ─────────────────────────────

export async function respondToWaitingNode({ token, executionId, nodeName, data }) {
  return call({ token, method: "POST",
    path: `/executions/${executionId}/nodes/${nodeName}/respond`,
    body: { data } });
}

// ── Helpers ──────────────────────────────────────────────────────

// The DSL validator rejects DAGs with zero nodes (schema requires
// `nodes` minItems: 1). "Empty" here means "as minimal as the
// validator allows" — a single `log` node that does nothing
// observable. Use this whenever a spec just needs *a* workflow row.
export const EMPTY_DSL = {
  name:    "smoke-empty",
  version: "1.0",
  data:    {},
  nodes: [
    { name: "noop", action: "log", inputs: { message: "noop" } },
  ],
  edges: [],
};

/** Minimal DSL that runs a single `transform` node with a literal
 *  expression. Used by the run-workflow smoke test. */
export const ONE_TRANSFORM_DSL = {
  name:    "smoke-one-transform",
  version: "1.0",
  data:    {},
  nodes: [
    {
      name:    "compute",
      action:  "transform",
      inputs:  { expression: "1 + 1" },
      outputs: { value: "answer" },
    },
  ],
  edges: [],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
