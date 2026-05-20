// Vue Router setup + the auth guard.
//
// Public routes (no login required):
//   /login            sign-in screen
//
// All other routes require an authenticated user. The router waits
// for `auth.boot()` to finish — that's a single /auth/refresh probe
// using the daisy_rt cookie, so reload-the-page survival works
// without any extra UX. While that probe is in flight, the guard
// just blocks navigation; the call is fast (one HTTP round-trip).

import { createWebHistory, createRouter } from "vue-router";

import HomePage       from "./pages/HomePage.vue";
import FlowDesigner   from "./pages/FlowDesigner.vue";
import FlowInspector  from "./pages/FlowInspector.vue";
import InstanceViewer from "./pages/InstanceViewer.vue";
import TriggerDesigner from "./pages/TriggerDesigner.vue";
import ConfigDesigner from "./pages/ConfigDesigner.vue";
import AgentDesigner  from "./pages/AgentDesigner.vue";
import LoginPage      from "./pages/LoginPage.vue";
import UsersPage      from "./pages/UsersPage.vue";
import AuditPage      from "./pages/AuditPage.vue";
import PluginsPage    from "./pages/PluginsPage.vue";
import WorkspaceSettings from "./pages/WorkspaceSettings.vue";
import ProjectsPage      from "./pages/ProjectsPage.vue";
import ServiceAccountsPage from "./pages/ServiceAccountsPage.vue";
import ProjectPluginsPage   from "./pages/ProjectPluginsPage.vue";
import CustomRolesPage      from "./pages/CustomRolesPage.vue";
import CrossProjectGrantsPage from "./pages/CrossProjectGrantsPage.vue";
import QuotasPage             from "./pages/QuotasPage.vue";
import JitGrantsPage          from "./pages/JitGrantsPage.vue";
import AdminPage              from "./pages/AdminPage.vue";
import PropertyEditor from "./components/PropertyEditor.vue";

import { auth } from "./stores/auth.js";

const routes = [
  // Public.
  { path: "/login", component: LoginPage, name: "login", meta: { public: true } },

  // Protected. Routes without meta.roles are visible to every signed-in
  // user (admin/editor/viewer). Edit-style routes are pinned to the
  // roles allowed to write the underlying resource — that mirrors the
  // backend role policy (PR 2) so the UI never lets a viewer wander
  // onto a page where every save will 403.
  { path: "/",                       component: HomePage,          name: "home" },
  { path: "/test",                   component: PropertyEditor },
  // Visual mode (canvas) and code mode (JSON editor) are two separate
  // top-level views — they never render side-by-side, so they don't fight
  // over a shared model. The :mode segment is optional; when missing,
  // FlowDesigner reads the user's localStorage preference and replaces
  // the URL so bookmarks land on the same mode next time.
  { path: "/flowDesigner/:id/:mode(visual|code)?", component: FlowDesigner,
    meta: { roles: ["admin", "editor"] } },
  { path: "/triggerDesigner/:id",    component: TriggerDesigner,
    meta: { roles: ["admin", "editor"] } },
  { path: "/configDesigner/:id",     component: ConfigDesigner, name: "configDesigner",
    meta: { roles: ["admin"] } },
  { path: "/agentDesigner/:id",      component: AgentDesigner,  name: "agentDesigner",
    meta: { roles: ["admin", "editor"] } },
  { path: "/flowInspector",          component: FlowInspector,  name: "flowInspector" },
  { path: "/instanceViewer/:id",     component: InstanceViewer, name: "instanceViewer" },

  // Admin surfaces.
  { path: "/users",                  component: UsersPage,         name: "users",
    meta: { roles: ["admin"] } },
  { path: "/audit",                  component: AuditPage,         name: "audit",
    meta: { roles: ["admin"] } },
  { path: "/plugins",                component: PluginsPage,       name: "plugins",
    meta: { roles: ["admin"] } },
  // Admin hub. Seven admin destinations (workspace settings, projects,
  // service accounts, project plugins, custom roles, cross-project
  // grants, quotas) all live behind /admin with a left-rail switcher.
  // The legacy individual routes redirect into /admin?view=<key> so
  // existing bookmarks and inbound links keep working.
  { path: "/admin",                  component: AdminPage,         name: "admin" },
  // Legacy aliases — preserved as redirects. Removing them outright
  // would 404 every link in old emails / Slack threads / wiki pages.
  { path: "/workspace",              redirect: { path: "/admin", query: { view: "workspace" } } },
  { path: "/projects",               redirect: { path: "/admin", query: { view: "projects" } },
    meta: { roles: ["admin"] } },
  { path: "/service-accounts",       redirect: { path: "/admin", query: { view: "service-accounts" } },
    meta: { roles: ["admin", "editor"] } },
  { path: "/project-plugins",        redirect: { path: "/admin", query: { view: "project-plugins" } },
    meta: { roles: ["admin", "editor"] } },
  { path: "/custom-roles",           redirect: { path: "/admin", query: { view: "custom-roles" } },
    meta: { roles: ["admin"] } },
  { path: "/cross-project-grants",   redirect: { path: "/admin", query: { view: "cross-project-grants" } },
    meta: { roles: ["admin"] } },
  { path: "/quotas",                 redirect: { path: "/admin", query: { view: "quotas" } },
    meta: { roles: ["admin", "editor"] } },
  // JIT elevations — workspace admin only. Page gate keeps editors/
  // viewers from rendering the table; the "mine" endpoint serves
  // them via the user menu's "elevated access" indicator.
  { path: "/jit-grants",             component: JitGrantsPage,        name: "jitGrants",
    meta: { roles: ["admin"] } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Global guard.
//
//   1. Wait for boot (one-shot tryRefresh probe) so reload-from-cookie
//      flows don't bounce through /login.
//   2. Public routes always pass.
//   3. Protected routes redirect to /login?next=… when no user.
//   4. Role-restricted routes redirect to / when the user lacks the role
//      (the page they came from is fine; we don't want a back-button trap).
router.beforeEach(async (to, _from, next) => {
  if (!auth.ready) {
    await auth.boot();
  }
  if (to.meta?.public) {
    return next();
  }
  if (!auth.isAuthenticated) {
    return next({ name: "login", query: { next: to.fullPath } });
  }
  const allowed = to.meta?.roles;
  if (allowed && !auth.hasRole(...allowed)) {
    return next("/");
  }
  next();
});
