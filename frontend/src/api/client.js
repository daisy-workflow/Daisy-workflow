import axios from "axios";
import { auth } from "../stores/auth.js";
import { router } from "../routes.js";

const api = axios.create({
  baseURL: "/api",
  withCredentials: true,    // sends the daisy_rt cookie on /auth/refresh
});

// Request interceptor — attach the in-memory access token to every
// outbound call. We don't read from localStorage on purpose; refresh
// tokens (httpOnly cookie) handle persistence across reloads.
api.interceptors.request.use((cfg) => {
  if (auth.token) {
    cfg.headers = cfg.headers || {};
    cfg.headers.Authorization = `Bearer ${auth.token}`;
  }
  return cfg;
});

// Response interceptor — when the API answers 401, try one silent
// /auth/refresh round-trip and re-issue the original request. If the
// refresh itself fails, redirect the user to /login.
//
// The `_retried` flag prevents an infinite loop if the retried
// request also 401s (e.g. clock skew, manual revoke).
api.interceptors.response.use(
  (resp) => resp,
  async (err) => {
    const original = err.config || {};
    const status   = err.response?.status;
    if (status !== 401 || original._retried) {
      throw err;
    }
    original._retried = true;
    const user = await auth.tryRefresh();
    if (!user) {
      // Refresh path failed — bounce to login, preserving the page
      // we were on so the post-login redirect lands the user back
      // where they were.
      const target = router.currentRoute.value.fullPath;
      if (router.currentRoute.value.name !== "login") {
        router.replace({ name: "login", query: { next: target } });
      }
      throw err;
    }
    // Re-fire the original request with the new token attached by
    // the request interceptor.
    return api(original);
  },
);

// `dsl` is the JSON-serialised DAG (formerly YAML). The backend keeps a
// `yaml` alias on its request handlers for back-compat, but new clients
// should always use `dsl`.
//
// Workflows are now single-row — the `id` is stable across saves and
// PUT updates the same row in place. Snapshots are explicit via the
// archive endpoints below.
export const Graphs = {
  list:     () => api.get("/graphs").then(r => r.data),
  get:      (id) => api.get(`/graphs/${id}`).then(r => r.data),
  create:   (dsl) => api.post("/graphs", { dsl }).then(r => r.data),
  update:   (id, dsl) => api.put(`/graphs/${id}`, { dsl }).then(r => r.data),
  remove:   (id) => api.delete(`/graphs/${id}`).then(r => r.data),
  validate: (dsl) => api.post("/graphs/validate", { dsl }).then(r => r.data),
  // `tags` are stamped onto the executions.tags row so the user can
  // filter the Instances table by them later. Backend normalises
  // (trim/lower/dedupe), so any shape is fine to send.
  execute:  (id, context = {}, tags = []) =>
    api.post(`/graphs/${id}/execute`, { context, tags }).then(r => r.data),

  // Archives — explicit snapshots of the live workflow.
  archive:    (id, reason) => api.post(`/graphs/${id}/archives`, { reason }).then(r => r.data),
  archives:   (id) => api.get(`/graphs/${id}/archives`).then(r => r.data),
  archiveGet: (id, archiveId) => api.get(`/graphs/${id}/archives/${archiveId}`).then(r => r.data),
  restore:    (id, archiveId) =>
    api.post(`/graphs/${id}/archives/${archiveId}/restore`).then(r => r.data),
};

export const Executions = {
  // Optional filters: { graphId, status (CSV: "running,queued"),
  // tags (CSV or array), limit }.
  // Legacy callers pass a bare graphId string — still supported.
  list: (filterOrGraphId) => {
    const params = (typeof filterOrGraphId === "string" || filterOrGraphId == null)
      ? (filterOrGraphId ? { graphId: filterOrGraphId } : {})
      : { ...filterOrGraphId };
    // Backend's tag parser expects CSV. Accept arrays at the call site
    // for ergonomics and stringify here so axios doesn't emit
    // `?tags[]=a&tags[]=b` (which the parser doesn't understand).
    if (Array.isArray(params.tags)) params.tags = params.tags.join(",");
    return api.get("/executions", { params }).then(r => r.data);
  },
  get:    (id) => api.get(`/executions/${id}`).then(r => r.data),
  remove: (id) => api.delete(`/executions/${id}`),

  // Resume from a failed node. `node` defaults to the only/first failed
  // node; `inputs` (optional) supplies an edited input map that the
  // engine will use verbatim on the resume run.
  resume: (id, payload = {}) => api.post(`/executions/${id}/resume`, payload).then(r => r.data),

  // Skip a failed node — marks it `skipped` (so descendants cascade)
  // and re-enqueues. Body must include `{ node: "<name>" }`.
  skip:   (id, node) => api.post(`/executions/${id}/skip`, { node }).then(r => r.data),

  // Resolve a `user` plugin node that's currently in WAITING status.
  // `data` becomes the node's output.data; the execution re-enqueues
  // and the worker's resume path replays outputs so downstream nodes
  // can read it as ${<var>}.
  respond: (id, node, data) =>
    api.post(`/executions/${id}/nodes/${encodeURIComponent(node)}/respond`, { data }).then(r => r.data),

  // Self-heal diagnosis (PR A). Returns { cached, diagnosis }.
  // Pass `force` to regenerate even when a cached diagnosis exists.
  diagnose: (id, { force = false } = {}) =>
    api.post(`/executions/${id}/diagnose${force ? "?force=1" : ""}`).then(r => r.data),
};

export const Plugins = {
  // List every plugin known to the engine (in-memory snapshot + DB
  // metadata: enabled, source, transport, status). Open to any
  // signed-in user (the FlowDesigner palette needs it).
  list: () => api.get("/plugins").then(r => r.data),

  // Admin-only. Install an HTTP-transport plugin by pointing at its
  // running container's /manifest endpoint.
  //
  //   payload = { endpoint, source? }
  install: (payload) => api.post("/plugins/install", payload).then(r => r.data),

  // Admin-only. Re-read the plugins table into the engine's
  // in-memory registry. Useful after a direct DB edit or to pick
  // up a freshly-installed plugin without a worker restart.
  refresh:   ()     => api.post("/plugins/refresh").then(r => r.data),
  enable:    (name) => api.post(`/plugins/${encodeURIComponent(name)}/enable`).then(r => r.data),
  disable:   (name) => api.post(`/plugins/${encodeURIComponent(name)}/disable`).then(r => r.data),

  // Phase 3 — uninstall a specific (name, version). Falls back to
  // the legacy all-versions delete when no version is provided.
  uninstall:        (name)          => api.delete(`/plugins/${encodeURIComponent(name)}`).then(r => r.data),
  uninstallVersion: (name, version) =>
    api.delete(`/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}`).then(r => r.data),

  setDefault: (name, version) =>
    api.post(`/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}/set-default`)
       .then(r => r.data),

  // Marketplace browse — fetches the catalog (cached on the server
  // for 5 minutes; force=true bypasses).
  catalog: ({ force = false } = {}) =>
    api.get("/plugins/catalog", { params: force ? { refresh: 1 } : {} }).then(r => r.data),

  // Install from a catalog entry. The catalog provides the manifest
  // URL + (optionally) the SHA-256 the server verifies on download.
  // `endpoint` is where the operator has the plugin container running.
  installFromCatalog: ({ catalogEntryUrl, manifestUrl, manifestSha256, endpoint, source }) =>
    api.post("/plugins/install-from-catalog", {
      catalogEntryUrl, manifestUrl, manifestSha256, endpoint, source,
    }).then(r => r.data),

  // Plugin-generator agent (admin only). Returns:
  //   { name, version, summary, files: [{path, content}], deployInstructions }
  askAgent: ({ prompt, transport = "http" }) =>
    api.post("/plugins/agent/generate", { prompt, transport }).then(r => r.data),

  // Download the generated bundle as a zip. The browser receives a Blob
  // we trigger a save-as on.
  downloadAgentZip: async ({ name, files }) => {
    const r = await api.post("/plugins/agent/download",
      { name, files }, { responseType: "blob" });
    return r.data;        // Blob
  },
};

export const AI = {
  // { configured, provider, model }
  status: () => api.get("/ai/status").then(r => r.data),
  // messages: [{ role: "user"|"assistant", content: string }]
  chat:   (messages) => api.post("/ai/chat", { messages }).then(r => r.data),

  // Tool-using workflow agent. The backend runs a multi-turn tool-use
  // loop (Anthropic/OpenAI) over: get_current_graph, update_graph,
  // list_triggers, create_trigger, list_configs.
  //
  // Args:
  //   messages       — the chat history so far (same shape as `chat`)
  //   graphId        — id of the saved graph the editor is on (null for new)
  //   currentGraph   — the editor's working draft DSL (so the agent sees
  //                    unsaved edits via get_current_graph)
  //
  // Returns:
  //   {
  //     message:        { role: "assistant", content },
  //     proposedGraph?: <DSL object>           // present when the agent ran update_graph
  //     triggerCreated?: { id, name, type }    // present when create_trigger fired
  //     traces: [{ tool, input, summary }]     // ordered tool calls
  //   }
  agent: ({ messages, graphId = null, currentGraph = null }) =>
    api.post("/ai/agent/chat", { messages, graphId, currentGraph }).then(r => r.data),
};

export const Configs = {
  // [{ type, label, description, fields, freeform }]
  types:  () => api.get("/configs/types").then(r => r.data),
  // Lists secrets masked. Use update flow to rotate a secret.
  list:   () => api.get("/configs").then(r => r.data),
  get:    (id) => api.get(`/configs/${id}`).then(r => r.data),
  create: (payload) => api.post("/configs", payload).then(r => r.data),
  update: (id, patch) => api.put(`/configs/${id}`, patch).then(r => r.data),
  remove: (id) => api.delete(`/configs/${id}`).then(r => r.data),
};

export const Memory = {
  // List rows. Filters: { scope, scopeId, namespace, prefix, limit }.
  list:    (params = {}) => api.get("/memory", { params }).then(r => r.data),
  get:     (id) => api.get(`/memory/${id}`).then(r => r.data),
  // Upsert a KV row. payload: { scope, scopeId, namespace, key, value }.
  set:     (payload) => api.post("/memory", payload).then(r => r.data),
  // Remove by row id (UI-friendly) or by composite key (programmatic).
  remove:  (id) => api.delete(`/memory/${id}`).then(r => r.data),
  removeKey: (payload) => api.delete("/memory", { data: payload }).then(r => r.data),
  // Conversation history.
  loadHistory:  ({ conversationId, scope = "workflow", scopeId, limit = 20 }) =>
    api.post("/memory/history/load", { conversationId, scope, scopeId, limit }).then(r => r.data),
  clearHistory: ({ conversationId, scope = "workflow", scopeId }) =>
    api.post("/memory/history/clear", { conversationId, scope, scopeId }).then(r => r.data),
};

export const Agents = {
  list:   () => api.get("/agents").then(r => r.data),
  get:    (id) => api.get(`/agents/${id}`).then(r => r.data),
  create: (payload) => api.post("/agents", payload).then(r => r.data),
  update: (id, patch) => api.put(`/agents/${id}`, patch).then(r => r.data),
  remove: (id) => api.delete(`/agents/${id}`).then(r => r.data),
};

export const Triggers = {
  list:   (graphId) => api.get("/triggers", graphId ? { params: { graphId } } : undefined).then(r => r.data),
  types:  () => api.get("/triggers/types").then(r => r.data),
  get:    (id) => api.get(`/triggers/${id}`).then(r => r.data),
  create: (data) => api.post("/triggers", data).then(r => r.data),
  update: (id, patch) => api.put(`/triggers/${id}`, patch).then(r => r.data),
  remove: (id) => api.delete(`/triggers/${id}`).then(r => r.data),
  // Manual "Run now" — fire the trigger once on demand. Returns
  // { executionId, graphId } so the caller can deep-link the user.
  // Works whether the trigger is enabled or not.
  fire:   (id, payload = {}) =>
    api.post(`/triggers/${id}/fire`, { payload }).then(r => r.data),
};

// Admin user management. All endpoints are admin-only on the server.
export const Users = {
  list:           ()              => api.get("/users").then(r => r.data),
  create:         (payload)       => api.post("/users", payload).then(r => r.data),
  update:         (id, patch)     => api.put(`/users/${id}`, patch).then(r => r.data),
  setPassword:    (id, password)  => api.post(`/users/${id}/password`, { password }).then(r => r.data),
  disable:        (id)            => api.delete(`/users/${id}`).then(r => r.data),
};

// Audit log — admin-only on the server. `list` returns
// { rows, nextBefore }. Pass `nextBefore` from a previous call as
// `params.before` to paginate.
export const Audit = {
  list: (params = {}) => api.get("/audit", { params }).then(r => r.data),
};

// Workspaces — the listing endpoint is open to any signed-in user
// (returns just the workspaces they belong to). Mutating endpoints
// are admin-only on the server.
export const Workspaces = {
  list:    ()                       => api.get("/workspaces").then(r => r.data),
  get:     (id)                     => api.get(`/workspaces/${id}`).then(r => r.data),
  members: (id)                     => api.get(`/workspaces/${id}/members`).then(r => r.data),
  rename:  (id, name)               => api.put(`/workspaces/${id}`, { name }).then(r => r.data),
  switch:  (id)                     => api.post(`/workspaces/${id}/switch`).then(r => r.data),
};

/** Open the live-execution WebSocket. Includes the auth token as a
 *  query-string parameter — browsers can't set Authorization headers
 *  on the WS upgrade, so this is the standard workaround. The backend
 *  validates the token on connect and refuses cross-workspace
 *  subscribers. If the access token is expired by the time the WS
 *  upgrades, the server closes with code 4001 — the caller can
 *  optionally re-call openLiveExecution() after the next API request
 *  has refreshed the token. */
export function openLiveExecution(executionId, onMessage) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const t = auth.token ? `&access_token=${encodeURIComponent(auth.token)}` : "";
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?executionId=${executionId}${t}`
  );
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  return ws;
}
