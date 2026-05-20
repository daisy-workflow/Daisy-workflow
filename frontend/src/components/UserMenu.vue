<!--
  Floating user-badge widget — top-right of every authenticated page.

  Layout choice: the visible footprint is just a single 30x30 avatar
  button. Clicking opens the full menu (email, role, workspace list,
  admin links, sign out). Keeping it small avoids overlapping the
  per-page q-toolbar buttons that live in the same corner.

  Hidden on /login and other public routes.
-->

<template>
  <div v-if="visible" class="user-menu">
    <!-- Theme toggle — sits next to the avatar so it's a one-click
         affordance from any page rather than buried in the menu. -->
    <q-btn
      round flat dense class="theme-btn"
      :icon="theme.mode === 'dark' ? 'light_mode' : 'dark_mode'"
      @click="onToggleTheme"
    >
      <q-tooltip>
        {{ theme.mode === "dark" ? "Switch to light theme" : "Switch to dark theme" }}
      </q-tooltip>
    </q-btn>

    <q-btn round flat dense class="user-btn" no-caps>
      <q-avatar size="30px" color="primary" text-color="white">
        {{ initials }}
      </q-avatar>

      <q-menu anchor="bottom right" self="top right">
        <!-- max-height + auto-scroll so the menu stays usable as it
             grows. Before RBAC v2 this list was short enough to fit
             any viewport; with the workspace switcher + project
             switcher + admin links + Sign out, it now exceeds 600px
             of items and the bottom (including Sign out) was getting
             clipped on shorter windows. -->
        <q-list dense style="min-width: 240px; max-height: 80vh; overflow-y: auto;">
          <q-item-label header class="text-caption">Signed in as</q-item-label>
          <q-item>
            <q-item-section>
              <q-item-label>{{ auth.user.email }}</q-item-label>
              <q-item-label caption>role: {{ auth.user.role }}</q-item-label>
            </q-item-section>
          </q-item>

          <q-separator />

          <q-item v-if="workspaces.length <= 1">
            <q-item-section>
              <q-item-label caption>Workspace</q-item-label>
              <q-item-label>{{ activeWorkspaceName || "—" }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-expansion-item
            v-else
            dense
            icon="workspaces"
            :label="`Workspace: ${activeWorkspaceName}`"
            class="text-body2"
          >
            <q-list dense>
              <q-item
                v-for="w in workspaces"
                :key="w.id"
                clickable
                v-close-popup
                :active="w.id === auth.user.workspaceId"
                @click="onSwitchWorkspace(w)"
              >
                <q-item-section>
                  <q-item-label>{{ w.name }}</q-item-label>
                  <q-item-label caption>role: {{ w.role }}</q-item-label>
                </q-item-section>
                <q-item-section v-if="w.id === auth.user.workspaceId" side>
                  <q-icon name="check" color="primary" />
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>

          <!-- Project (RBAC v2). Shows the active project name and, when
               the user has access to more than one, expands into a list
               of projects they can switch to. Workspace admins see every
               project in the workspace; everyone else sees only those
               they're a member of (server enforces this on GET /projects). -->
          <q-item v-if="projects.length <= 1">
            <q-item-section>
              <q-item-label caption>Project</q-item-label>
              <q-item-label>{{ activeProjectName || "—" }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-expansion-item
            v-else
            dense
            icon="folder_open"
            :label="`Project: ${activeProjectName || '—'}`"
            class="text-body2"
          >
            <q-list dense>
              <q-item
                v-for="p in projects"
                :key="p.id"
                clickable
                v-close-popup
                :active="p.id === auth.activeProjectId"
                @click="onSwitchProject(p)"
              >
                <q-item-section>
                  <q-item-label>{{ p.name }}</q-item-label>
                  <q-item-label caption>
                    {{ p.member_role || (isWorkspaceAdmin ? "workspace admin (inherited)" : "—") }}
                  </q-item-label>
                </q-item-section>
                <q-item-section v-if="p.id === auth.activeProjectId" side>
                  <q-icon name="check" color="primary" />
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>

          <q-separator />

          <q-item clickable v-close-popup @click="goWorkspace">
            <q-item-section avatar><q-icon name="settings" /></q-item-section>
            <q-item-section>Workspace settings</q-item-section>
          </q-item>
          <q-item v-if="isWorkspaceAdmin" clickable v-close-popup @click="goProjects">
            <q-item-section avatar><q-icon name="folder_special" /></q-item-section>
            <q-item-section>Projects</q-item-section>
          </q-item>
          <q-item clickable v-close-popup @click="goServiceAccounts">
            <q-item-section avatar><q-icon name="vpn_key" /></q-item-section>
            <q-item-section>Service accounts</q-item-section>
          </q-item>
          <q-item clickable v-close-popup @click="goProjectPlugins">
            <q-item-section avatar><q-icon name="extension" /></q-item-section>
            <q-item-section>Project plugins</q-item-section>
          </q-item>
          <q-item v-if="isWorkspaceAdmin" clickable v-close-popup @click="goCustomRoles">
            <q-item-section avatar><q-icon name="admin_panel_settings" /></q-item-section>
            <q-item-section>Custom roles</q-item-section>
          </q-item>
          <q-item v-if="isWorkspaceAdmin" clickable v-close-popup @click="goCrossProjectGrants">
            <q-item-section avatar><q-icon name="swap_horiz" /></q-item-section>
            <q-item-section>Cross-project grants</q-item-section>
          </q-item>
          <q-item clickable v-close-popup @click="goQuotas">
            <q-item-section avatar><q-icon name="data_usage" /></q-item-section>
            <q-item-section>Quotas</q-item-section>
          </q-item>
          <q-item v-if="isWorkspaceAdmin" clickable v-close-popup @click="goJitGrants">
            <q-item-section avatar><q-icon name="bolt" /></q-item-section>
            <q-item-section>JIT elevations</q-item-section>
          </q-item>

          <!-- My active JIT elevations — visible to every user when
               they have at least one active grant. Tap to revoke. -->
          <template v-if="myJitGrants.length">
            <q-separator />
            <q-item-label header class="text-caption">You have elevated access</q-item-label>
            <q-item v-for="g in myJitGrants" :key="g.id">
              <q-item-section avatar><q-icon name="bolt" color="warning" /></q-item-section>
              <q-item-section>
                <q-item-label>{{ g.role }} in {{ g.scope_name }}</q-item-label>
                <q-item-label caption>{{ relativeUntil(g.expires_at) }} · {{ g.reason }}</q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-btn flat dense size="sm" icon="close" color="grey-7" @click="onSelfRevoke(g)">
                  <q-tooltip>Revoke now</q-tooltip>
                </q-btn>
              </q-item-section>
            </q-item>
          </template>
          <q-item v-if="auth.user.role === 'admin'" clickable v-close-popup @click="goUsers">
            <q-item-section avatar><q-icon name="people" /></q-item-section>
            <q-item-section>Users</q-item-section>
          </q-item>
          <q-item v-if="auth.user.role === 'admin'" clickable v-close-popup @click="goAudit">
            <q-item-section avatar><q-icon name="history" /></q-item-section>
            <q-item-section>Audit log</q-item-section>
          </q-item>
          <q-item v-if="auth.user.role === 'admin'" clickable v-close-popup @click="goPlugins">
            <q-item-section avatar><q-icon name="extension" /></q-item-section>
            <q-item-section>Plugins</q-item-section>
          </q-item>

          <q-separator />

          <q-item clickable v-close-popup @click="onLogout">
            <q-item-section avatar><q-icon name="logout" /></q-item-section>
            <q-item-section>Sign out</q-item-section>
          </q-item>
        </q-list>
      </q-menu>
    </q-btn>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { theme } from "../stores/theme.js";
import { Workspaces, Projects, JitGrants } from "../api/client.js";

const route  = useRoute();
const router = useRouter();
const $q     = useQuasar();

// Keep Quasar's own dark mode in lockstep with our theme store. We
// still drive our CSS variables via the `html[data-theme]` attribute
// (the store does that), but Quasar's components (dialogs, q-table,
// q-menu) have their own dark-aware classes that we toggle here.
watch(
  () => theme.mode,
  (m) => { $q?.dark?.set(m === "dark"); },
  { immediate: true },
);

function onToggleTheme() { theme.toggle(); }

const workspaces  = ref([]);
const projects    = ref([]);
// Active JIT elevations on this user — drives the "you have elevated
// access" footer in the menu. Refreshed when the user opens the menu
// (loadProjects is the natural sibling) so we don't poll on a timer.
const myJitGrants = ref([]);
// Read the workspace-admin flag synchronously from the auth store.
// auth.boot() and login() populate it before any page mounts, so the
// "Projects" entry below renders correctly the first time the user
// opens the menu — no async race with loadProjects().
const isWorkspaceAdmin = computed(() => auth.isWorkspaceAdmin || auth.user?.role === "admin");

const visible = computed(() => {
  if (route.meta?.public) return false;
  return auth.isAuthenticated;
});

const initials = computed(() => {
  const e = auth.user?.email || "";
  const local = e.split("@")[0] || "?";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local.slice(0, 2) || "?").toUpperCase();
});

const activeWorkspaceName = computed(() => {
  return workspaces.value.find(w => w.id === auth.user?.workspaceId)?.name || null;
});

const activeProjectName = computed(() => {
  return projects.value.find(p => p.id === auth.activeProjectId)?.name || null;
});

async function loadWorkspaces() {
  try {
    const data = await Workspaces.list();
    workspaces.value = data.workspaces || [];
  } catch {
    workspaces.value = [];
  }
}

// Refresh the project list for the switcher. The "pick a default
// project" logic lives in auth.boot() / ensureActiveProject() now —
// this is just the populator for the menu's expansion-item.
async function loadProjects() {
  try {
    const data = await Projects.list();
    projects.value = data.projects || [];
    // Keep auth.isWorkspaceAdmin fresh too — workspace-admin status
    // can change at runtime (someone gets promoted) and the menu
    // should reflect that without a full reload.
    auth.isWorkspaceAdmin = !!data.isWorkspaceAdmin;
  } catch {
    projects.value = [];
  }
}

async function loadMyJitGrants() {
  try { myJitGrants.value = await JitGrants.mine(); }
  catch { myJitGrants.value = []; }
}

async function onSelfRevoke(g) {
  try {
    await JitGrants.revoke(g.id);
    await loadMyJitGrants();
    // Page that's currently mounted may be relying on the elevated
    // permission set. Reload to re-evaluate any conditional UI.
    router.go(0);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

function relativeUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.round(ms / 1000);
  if (s < 60)    return `${s}s left`;
  if (s < 3600)  return `${Math.round(s / 60)}m left`;
  if (s < 86400) return `${Math.round(s / 3600)}h left`;
  return `${Math.round(s / 86400)}d left`;
}

onMounted(() => {
  if (auth.isAuthenticated) {
    loadWorkspaces();
    loadProjects();
    loadMyJitGrants();
  }
});
watch(() => auth.user?.id, (id) => {
  if (id) { loadWorkspaces(); loadProjects(); loadMyJitGrants(); }
  else    { workspaces.value = []; projects.value = []; myJitGrants.value = []; }
});
// When the workspace switches, the project list changes too.
watch(() => auth.user?.workspaceId, () => {
  if (auth.isAuthenticated) { loadProjects(); loadMyJitGrants(); }
});

async function onSwitchWorkspace(w) {
  if (w.id === auth.user.workspaceId) return;
  try {
    const { accessToken, user } = await Workspaces.switch(w.id);
    auth.token = accessToken;
    auth.user  = user;
    // Active project doesn't survive a workspace switch — it lives
    // in a different tenant. Clear it; loadProjects() in the next
    // tick will auto-pick the new workspace's default.
    auth.clearActiveProject();
    router.go(0);
  } catch { /* notify already happens via the global axios handler */ }
}

async function onSwitchProject(p) {
  if (p.id === auth.activeProjectId) return;
  try {
    await auth.setActiveProject(p.id);
    // Hard reload so every component re-fetches list views under the
    // new scope. The workspace switcher uses the same idiom.
    router.go(0);
  } catch (e) {
    $q.notify({
      type: "negative",
      message: `Project switch failed: ${e?.response?.data?.message || e.message}`,
      position: "bottom",
    });
  }
}

function goUsers()      { router.push({ name: "users" }); }
function goAudit()      { router.push({ name: "audit" }); }
function goPlugins()    { router.push({ name: "plugins" }); }
function goWorkspace()  { router.push({ name: "workspace" }); }
function goProjects()        { router.push({ name: "projects" }); }
function goServiceAccounts() { router.push({ name: "serviceAccounts" }); }
function goProjectPlugins()  { router.push({ name: "projectPlugins" }); }
function goCustomRoles()         { router.push({ name: "customRoles" }); }
function goCrossProjectGrants()  { router.push({ name: "crossProjectGrants" }); }
function goQuotas()              { router.push({ name: "quotas" }); }
function goJitGrants()           { router.push({ name: "jitGrants" }); }

async function onLogout() {
  await auth.logout();
  router.replace({ name: "login" });
}
</script>

<style scoped>
/*
  Compact floating avatar — 36x36 button, 30x30 avatar inside.
  Sits over the top-right corner. Pages with a q-toolbar receive a
  paired global padding rule (see App.vue) so the toolbar's right-most
  control stops short of the avatar's footprint.
*/
.user-menu {
  position: fixed;
  top: 6px;
  right: 8px;
  z-index: 9000;
  display: flex;
  align-items: center;
  gap: 6px;
}
.theme-btn,
.user-btn {
  width: 36px;
  height: 36px;
  background: var(--surface, white);
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 50%;
  padding: 0;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}
.theme-btn:hover,
.user-btn:hover {
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.14);
}
.theme-btn :deep(.q-icon) { font-size: 18px; color: var(--text, #1f2937); }
</style>
