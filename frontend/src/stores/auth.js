// Auth state for the frontend.
//
// Implementation choice: plain Vue reactive() instead of Pinia. The
// app didn't have Pinia as a dep before this work, and the auth
// surface is small (a token + a user object + four actions). Keeping
// it dependency-free saves ~30 KB and one decision point.
//
// What lives here:
//   • state.token          access JWT, in memory only (NOT localStorage —
//                          xss-resistant; the refresh-token cookie
//                          handles persistence across reloads).
//   • state.user           { id, email, role, workspaceId, status }
//   • state.ready          true once we've tried at least one /auth/me
//                          (used by router guards to wait for boot).
//   • login / logout / fetchMe / tryRefresh — async methods.
//
// Boot sequence:
//   On app load there's no token in memory. We hit POST /auth/refresh
//   blindly — the browser will send the daisy_rt httpOnly cookie if
//   one exists. If refresh succeeds, we land in `ready` with a token
//   and user object; if not, `ready` flips with `user=null` and the
//   router redirects to /login.

import { reactive } from "vue";
import axios from "axios";

// A bare axios for /auth/* — separate instance so the request
// interceptor on the main `api` client can't recurse through it
// (e.g. a refresh fetch triggering its own 401-refresh dance).
const authApi = axios.create({
  baseURL: "/api",
  withCredentials: true,    // send the daisy_rt cookie on /auth/refresh
});

// RBAC v2: persist the active project id across reloads. We can't put
// it in the JWT alone because the JWT lives in memory — the browser
// reload would lose it. localStorage survives reloads; the request
// interceptor reads `auth.activeProjectId` to attach X-Project-Id.
const PROJECT_LS_KEY = "daisy.activeProjectId";
function readActiveProject() {
  try { return localStorage.getItem(PROJECT_LS_KEY) || null; }
  catch { return null; }
}
function writeActiveProject(id) {
  try {
    if (id) localStorage.setItem(PROJECT_LS_KEY, id);
    else    localStorage.removeItem(PROJECT_LS_KEY);
  } catch { /* private mode — preference won't survive */ }
}

export const auth = reactive({
  token: null,
  user:  null,
  // Currently-active project id. The request interceptor reads this
  // and emits X-Project-Id on every API call. Persisted to
  // localStorage so reloads land on the same project.
  activeProjectId: readActiveProject(),
  // RBAC v2: cached workspace-admin flag for the active workspace.
  // Populated by ensureActiveProject() during boot. Pages and menu
  // items read this synchronously instead of waiting on a fresh API
  // round-trip — which would otherwise hide the "Projects" link
  // (and bounce admins out of /service-accounts) during the
  // few-hundred-ms window after login.
  isWorkspaceAdmin: false,
  ready: false,             // boot probe complete

  /** True iff a logged-in user is loaded. */
  get isAuthenticated() {
    return !!(this.token && this.user);
  },

  /**
   * Switch the active project. Issues a new JWT with `proj` pointing
   * at the target project, persists the choice to localStorage, and
   * updates the in-memory token so the next API call carries the
   * right context. Returns the project info.
   */
  async setActiveProject(projectId) {
    // Dynamic import to avoid the auth-store ↔ api-client cycle —
    // client.js imports auth, so auth importing client at top-level
    // would self-reference at module init.
    const { Projects } = await import("../api/client.js");
    const result = await Projects.switch(projectId);
    this.token = result.accessToken;
    this.activeProjectId = result.project.id;
    writeActiveProject(this.activeProjectId);
    return result.project;
  },

  /**
   * Forget the active project. Called on logout and when the project
   * the UI was pointing at disappears (e.g. soft-deleted by an admin).
   */
  clearActiveProject() {
    this.activeProjectId = null;
    writeActiveProject(null);
  },

  /** Login with email + password. On success the access token + user
   *  are placed in state and the refresh cookie is set by the server.
   *  Also primes the active project so the next page-load doesn't
   *  bounce on missing context. */
  async login(email, password) {
    const { data } = await authApi.post("/auth/login", { email, password });
    this.token = data.accessToken;
    this.user  = data.user;
    await this.ensureActiveProject();
    return data.user;
  },

  /** Send the existing refresh cookie to /auth/refresh, get a fresh
   *  access token + rotated cookie. Returns the new user or null. */
  async tryRefresh() {
    try {
      const { data } = await authApi.post("/auth/refresh");
      this.token = data.accessToken;
      this.user  = data.user;
      return data.user;
    } catch {
      this.token = null;
      this.user  = null;
      return null;
    }
  },

  /** Probe /auth/me with the current access token. Used after
   *  login to confirm the token works and after refresh-on-401
   *  to repopulate the user object. */
  async fetchMe() {
    if (!this.token) return null;
    try {
      const { data } = await authApi.get("/auth/me", {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.user = data;
      return data;
    } catch {
      this.token = null;
      this.user  = null;
      return null;
    }
  },

  /** Best-effort logout — revokes the refresh cookie server-side
   *  and clears local state. Idempotent on the server. */
  async logout() {
    try { await authApi.post("/auth/logout"); }
    catch { /* ignore — we still want to clear local state */ }
    this.token = null;
    this.user  = null;
    this.isWorkspaceAdmin = false;
    this.clearActiveProject();
  },

  /**
   * Make sure an active project is set + load the workspace-admin
   * flag. Called from boot() and after a workspace switch. Safe to
   * call repeatedly — when activeProjectId is already valid in the
   * current workspace, we just refresh the isWorkspaceAdmin flag.
   *
   * Why centralise this: pages that need a project context (service
   * accounts, project plugins, the home flow list) used to race
   * with UserMenu's auto-select. By picking a default at boot the
   * window is closed — every page mount sees a valid activeProjectId.
   *
   * Returns the chosen project id, or null when the user has no
   * projects (shouldn't happen — migrate seeds a Default project).
   */
  async ensureActiveProject() {
    if (!this.isAuthenticated) return null;
    // Late, dynamic import to avoid the api-client ↔ auth-store cycle.
    const { Projects } = await import("../api/client.js");
    let data;
    try { data = await Projects.list(); }
    catch { return null; }
    this.isWorkspaceAdmin = !!data.isWorkspaceAdmin;
    const projects = data.projects || [];

    // Honour the stored choice when it's still valid in this workspace.
    const stored = this.activeProjectId
      && projects.some(p => p.id === this.activeProjectId);
    if (stored) return this.activeProjectId;

    // Otherwise pick a sensible default: the slug-"default" project
    // if present, else the alphabetically-first one.
    const pick = projects.find(p => p.slug === "default") || projects[0];
    if (!pick) return null;
    try {
      await this.setActiveProject(pick.id);
      return pick.id;
    } catch {
      return null;
    }
  },

  /** Boot probe — tries to silently restore a session via the
   *  refresh cookie, then picks a default project so every page has
   *  a context to work with. Always sets `ready=true` when done so
   *  the router guard can stop waiting. */
  async boot() {
    await this.tryRefresh();
    if (this.isAuthenticated) {
      await this.ensureActiveProject();
    }
    this.ready = true;
  },

  /** Convenience: returns true if the current user has any of the
   *  given roles. Used in templates and route guards. */
  hasRole(...roles) {
    if (!this.user) return false;
    return roles.includes(this.user.role);
  },
});

/** Discovery: which login methods does the backend offer? Used by
 *  LoginPage to optionally render an SSO button. */
export async function loadAuthConfig() {
  try {
    const { data } = await authApi.get("/auth/config");
    return data;   // { localEnabled, oidcEnabled, oidcLabel }
  } catch {
    return { localEnabled: true, oidcEnabled: false };
  }
}
