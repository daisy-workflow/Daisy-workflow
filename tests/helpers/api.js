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

// 127.0.0.1 instead of localhost because Node 22's fetch resolves
// "localhost" to ::1 (IPv6) first, and Docker's port mapping on
// macOS/Linux binds only on IPv4 by default. The browser-side requests
// (via Vite) are unaffected because the browser hits the dev server
// directly; only the Node-side test fetches in this helper would trip.
const API_URL = process.env.TEST_API_URL || "http://127.0.0.1:3001";

export const TEST_ADMIN = {
  email:    process.env.TEST_ADMIN_EMAIL    || "admin@test.local",
  password: process.env.TEST_ADMIN_PASSWORD || "Test12345!Test",
};

// Module-level default context. login() populates it; subsequent call()s
// read from it so tests don't need to thread the project id everywhere.
// Resetting it (e.g. between tests that use different identities) is
// done by calling login() again with different credentials.
let _defaultContext = { token: null, projectId: null };

/**
 * Log in as the bootstrap admin (seeded by the worker-test container
 * on first boot). Returns { token, user, projectId }.
 *
 * If the user doesn't have an active project yet (the createAdmin
 * bootstrap only creates a workspace, not a project), this helper
 * creates a "Default" project once and pins it as the active project
 * for the rest of the run. Every subsequent call() automatically
 * includes the X-Project-Id header so project-scoped endpoints
 * (graphs / configs / agents / KBs / …) work without the caller
 * having to remember.
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
  const token = body.accessToken || body.token;
  if (!token) throw new Error("api.login: response missing accessToken");

  // Resolve the active project: the JWT may already carry one
  // (payload.proj — set when the admin had a project assigned at
  // creation), or we have to create one ourselves. We bypass call()
  // here because call() depends on _defaultContext.projectId, which
  // we're in the middle of populating.
  let projectId = body.user?.projectId || null;
  if (!projectId) {
    projectId = await ensureDefaultProject(token);
  }

  _defaultContext = { token, projectId };
  return { token, user: body.user || null, projectId };
}

/** First-run helper: list projects; if none, create "Default".
 *
 *   GET /projects returns `{ active, projects: [...], isWorkspaceAdmin }`,
 *   not a bare array. We pull the list out of `.projects`, prefer a
 *   row literally named "Default", and fall back to the first live row.
 *
 *   The create path runs only when the workspace truly has zero
 *   projects. On 409 (e.g. a previous run created a Default project
 *   the current admin isn't a member of) we re-list with the workspace
 *   admin path to recover the id — the bootstrap admin is always a
 *   workspace admin, so they'll see every project regardless of
 *   project_members rows. */
async function ensureDefaultProject(token) {
  const headers = { "authorization": `Bearer ${token}` };

  const pickFromList = (body) => {
    const projects = Array.isArray(body?.projects)
      ? body.projects
      : (Array.isArray(body) ? body : []);
    const live = projects.filter(p => !p.deleted_at);
    return (live.find(p => p.name === "Default")
         || live.find(p => p.slug === "default")
         || live[0]
         || null);
  };

  const listRes = await fetch(`${API_URL}/projects`, { headers });
  if (listRes.ok) {
    const row = pickFromList(await listRes.json());
    if (row) return row.id;
  }

  // No project yet — create one. The bootstrap admin is a workspace
  // admin, so this is allowed.
  const createRes = await fetch(`${API_URL}/projects`, {
    method:  "POST",
    headers: { ...headers, "content-type": "application/json" },
    body:    JSON.stringify({ name: "Default" }),
  });
  if (createRes.ok) {
    return (await createRes.json()).id;
  }

  // 409 = slug taken by a project that exists in the workspace but
  // didn't show up in the list above. Re-list (the workspace admin
  // sees every project) and pick the live "default" row.
  if (createRes.status === 409) {
    const retryRes = await fetch(`${API_URL}/projects`, { headers });
    if (retryRes.ok) {
      const row = pickFromList(await retryRes.json());
      if (row) return row.id;
    }
  }
  const txt = await createRes.text().catch(() => "");
  throw new Error(`api.login: couldn't bootstrap default project (${createRes.status} ${txt.slice(0, 200)})`);
}

/**
 * Convenience wrapper that does GET / POST / PUT / DELETE against the
 * backend with the supplied bearer token. Returns the parsed JSON body
 * on 2xx, throws on anything else.
 *
 * Token + projectId default to the values stashed by the last
 * successful login() call, so most callers don't need to pass them.
 */
async function call({ token, projectId, method = "GET", path, body }) {
  const useToken     = token     ?? _defaultContext.token;
  const useProjectId = projectId ?? _defaultContext.projectId;
  const headers = { "content-type": "application/json" };
  if (useToken)     headers["authorization"] = `Bearer ${useToken}`;
  // X-Project-Id is the explicit override the auth middleware checks
  // first; including it on every request keeps project-scoped
  // endpoints (graphs / configs / agents / KBs / …) working even
  // when the bootstrap admin's JWT didn't carry a project id.
  if (useProjectId) headers["x-project-id"] = useProjectId;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
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
  // The execute endpoint returns { executionId, status: "queued" } —
  // older revisions returned { id }. Normalize both shapes into a
  // single `id` field so test code never has to care.
  const r = await call({
    token, method: "POST", path: `/graphs/${id}/execute`,
    body: { context: inputs },
  });
  return { ...r, id: r.executionId || r.id };
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

export async function createAgent({ token, title, configName, prompt, promptTemplateId, sharedAtWorkspace }) {
  // `prompt` is allowed to be empty when a promptTemplateId is set —
  // the server renders the body from prompt_templates at call time.
  // Matches the backend's validatePayload rule.
  const body = { title, config_name: configName, prompt: prompt || "" };
  if (promptTemplateId)        body.prompt_template_id  = promptTemplateId;
  if (sharedAtWorkspace != null) body.sharedAtWorkspace = sharedAtWorkspace;
  return call({ token, method: "POST", path: "/agents", body });
}

export async function getAgent({ token, id }) {
  return call({ token, method: "GET", path: `/agents/${id}` });
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
  // The preview endpoint is per-template (`POST /prompt-templates/:id/preview`)
  // — it loads the stored row and renders against `vars`. There's no
  // "stateless preview" endpoint, so to test a body the helper creates
  // an ephemeral template, previews it, deletes it. Net: caller
  // experience matches what they'd expect — pass body + vars, get
  // { rendered, missing }.
  const created = await createPromptTemplate({
    token,
    title: uniq("preview"),
    body,
    sharedAtWorkspace: false,
  });
  try {
    return await call({ token, method: "POST",
      path: `/prompt-templates/${created.id}/preview`,
      body: { vars: vars || {} } });
  } finally {
    await deletePromptTemplate({ token, id: created.id }).catch(() => {});
  }
}

// ── Projects (workspace admin) ──────────────────────────────────

export async function listProjects({ token }) {
  // GET /projects returns { active, projects:[], isWorkspaceAdmin } —
  // unwrap so callers can do `.some()` / `.find()` directly on an
  // array as they'd intuitively expect.
  const body = await call({ token, method: "GET", path: "/projects" });
  return Array.isArray(body) ? body : (body?.projects || []);
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

export async function createKb({ token, title, embeddingProvider = "openai", embeddingModel = "text-embedding-3-small", chunkSize = 800, chunkOverlap = 100, kbBackend = "pgvector", kbBackendConfigId, kbBackendCollection }) {
  const body = { title, embeddingProvider, embeddingModel, chunkSize, chunkOverlap, kbBackend };
  if (kbBackendConfigId)   body.kbBackendConfigId   = kbBackendConfigId;
  if (kbBackendCollection) body.kbBackendCollection = kbBackendCollection;
  return call({ token, method: "POST", path: "/kbs", body });
}

export async function getKb({ token, id }) {
  return call({ token, method: "GET", path: `/kbs/${id}` });
}

export async function listKbs({ token }) {
  return call({ token, method: "GET", path: "/kbs" });
}

export async function deleteKb({ token, id }) {
  return call({ token, method: "DELETE", path: `/kbs/${id}` });
}

/** Ingest a text document directly (no file upload). The KB API
 *  exposes /kbs/:id/documents (POST text payload). */
export async function ingestKbText({ token, kbId, title, text }) {
  return call({ token, method: "POST", path: `/kbs/${kbId}/documents`,
    body: { title, text, sourceType: "inline" } });
}

export async function queryKb({ token, kbId, query, topK = 5 }) {
  return call({ token, method: "POST", path: `/kbs/${kbId}/query`,
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

export async function listAudit({ token, action, actor, resourceType, resourceId, outcome, from, to, limit = 50 }) {
  const q = new URLSearchParams();
  if (action)       q.set("action",       action);
  if (actor)        q.set("actor",        actor);
  if (resourceType) q.set("resourceType", resourceType);
  if (resourceId)   q.set("resourceId",   resourceId);
  if (outcome)      q.set("outcome",      outcome);
  if (from)         q.set("from",         from);
  if (to)           q.set("to",           to);
  if (limit)        q.set("limit",        String(limit));
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
  return call({ token, method: "GET", path: "/saml-config" });
}

export async function setSamlConfig({ token, ...body }) {
  return call({ token, method: "PUT", path: "/saml-config", body });
}

export async function deleteSamlConfig({ token }) {
  return call({ token, method: "DELETE", path: "/saml-config" });
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
