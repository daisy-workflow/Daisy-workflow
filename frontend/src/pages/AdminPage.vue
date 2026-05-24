<!--
  Admin hub — single page that owns the left rail + section switching
  for every admin destination. Each section embeds the existing
  standalone page as a panel (the page roots are all
  `<div class="page q-pa-md">`, no q-layout wrapper, so they slot in
  cleanly).

  Sections + role gating:
    workspace          everyone     (workspace settings is read-only
                                     to non-admins; the page enforces)
    projects           workspace admin
    service-accounts   admin / editor (project admin via permission)
    project-plugins    admin / editor
    custom-roles       workspace admin
    cross-project-grants  workspace admin
    quotas             admin / editor

  URL state:
    The active section sits on `?view=<key>` so reload / bookmark /
    shared-link all land on the same panel. The legacy individual
    routes (/projects, /workspace, etc.) redirect here with the right
    view key — see routes.js.
-->
<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <q-btn
          flat round dense icon="arrow_back"
          class="btn-toolbar q-mr-sm"
          @click="goHome"
        >
          <q-tooltip>Back to workflows</q-tooltip>
        </q-btn>
        <q-toolbar-title>
          Admin
          <span v-if="activeLabel" class="q-ml-xs text-caption text-grey-7">
            · {{ activeLabel }}
          </span>
        </q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-drawer
      side="left"
      :model-value="true"
      :width="220"
      bordered persistent
      class="admin-sidebar"
    >
    <q-scroll-area class="fit">
      <q-list  >
        
        <q-item
          v-for="item in visibleSections"
          :key="item.key"
          clickable
          :active="activeKey === item.key"
          active-class="admin-active"
          @click="setActive(item.key)"
        >
          <q-item-section avatar>
            <q-icon :name="item.icon" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ item.label }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
      </q-scroll-area>
    </q-drawer>

    <q-page-container>
      <q-page>
        <!--
          Each section embeds the existing standalone page. The
          mounted component re-runs onMounted on every switch because
          we KEY the panel by activeKey — that's deliberate: most of
          these pages load DB-backed state and the user expects fresh
          data when they switch tabs. keep-alive would cache stale rows.
        -->
        <keep-alive include="">
          <component :is="activeComponent" :key="activeKey" />
        </keep-alive>

        <q-banner
          v-if="!activeComponent"
          class="bg-blue-1 text-blue-9 q-ma-md"
        >
          <template v-slot:avatar><q-icon name="info" /></template>
          Pick an admin section from the left.
        </q-banner>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth } from "../stores/auth.js";

// Each admin section is a standalone page component the rest of the
// app can still navigate to directly (the legacy routes redirect into
// /admin?view=…). Embedding via `<component :is>` keeps each section
// self-contained — its own data loading, dialogs, error handling.
import WorkspaceSettings        from "./WorkspaceSettings.vue";
import ProjectsPage             from "./ProjectsPage.vue";
import ServiceAccountsPage      from "./ServiceAccountsPage.vue";
import ProjectPluginsPage       from "./ProjectPluginsPage.vue";
import CustomRolesPage          from "./CustomRolesPage.vue";
import CrossProjectGrantsPage   from "./CrossProjectGrantsPage.vue";
import QuotasPage               from "./QuotasPage.vue";
import SsoSettingsPage          from "./SsoSettingsPage.vue";
import GuardrailsPage           from "./GuardrailsPage.vue";
import ComplianceSettingsPage   from "./ComplianceSettingsPage.vue";
// Four pages previously hung off their own top-level routes
// (/users, /audit, /plugins, /jit-grants). They're all workspace-admin
// governance surfaces, so they belong in the admin hub alongside the
// others. The standalone routes are kept as named redirects (see
// routes.js) so UserMenu's router.push({name:"users"}) etc. still works.
import UsersPage                from "./UsersPage.vue";
import AuditPage                from "./AuditPage.vue";
import PluginsPage              from "./PluginsPage.vue";
import JitGrantsPage            from "./JitGrantsPage.vue";
// Knowledge bases + Prompt templates + Evals + Model routes are
// content-authoring surfaces (sibling to Agents + Configs), not
// workspace governance — they live on the Home page rail instead
// of /admin. Imports intentionally absent.

const route  = useRoute();
const router = useRouter();

// Helpers used by `roles` predicates below. Two flavours:
//   • `wsAdmin` — workspace-admin only (the auth store flag is the
//                 source of truth, with a fallback to user.role for
//                 the boot window where the flag hasn't loaded yet).
//   • `editor`  — admin OR editor at workspace level.
function isWsAdmin() { return auth.isWorkspaceAdmin || auth.user?.role === "admin"; }
function isEditor()  { return ["admin", "editor"].includes(auth.user?.role); }

// Section catalogue. `predicate` decides visibility per user; pages
// also enforce server-side. `view` is the URL key (?view=…). `label`
// shows in the rail + the toolbar suffix.
const sections = [
  { key: "workspace",           label: "Workspace",            icon: "settings",                 component: WorkspaceSettings,      predicate: () => true       },
  // People — workspace user roster (role / status / password reset).
  { key: "users",               label: "Users",                icon: "people",                   component: UsersPage,              predicate: isWsAdmin        },
  { key: "sso",                 label: "SSO (SAML)",           icon: "business",                 component: SsoSettingsPage,        predicate: isWsAdmin        },
  { key: "projects",            label: "Projects",             icon: "folder_special",           component: ProjectsPage,           predicate: isWsAdmin        },
  { key: "service-accounts",    label: "Service accounts",     icon: "vpn_key",                  component: ServiceAccountsPage,    predicate: isEditor         },
  // Workspace-level plugin install (catalog → installed). Project
  // plugins (per-project enablement) is a downstream view of this.
  { key: "plugins",             label: "Plugins",              icon: "widgets",                  component: PluginsPage,            predicate: isWsAdmin        },
  { key: "project-plugins",     label: "Project plugins",      icon: "extension",                component: ProjectPluginsPage,     predicate: isEditor         },
  { key: "custom-roles",        label: "Custom roles",         icon: "admin_panel_settings",     component: CustomRolesPage,        predicate: isWsAdmin        },
  { key: "cross-project-grants", label: "Cross-project grants", icon: "swap_horiz",              component: CrossProjectGrantsPage, predicate: isWsAdmin        },
  // Time-bounded role elevations — sits next to the other permission
  // surfaces (custom roles, cross-project grants).
  { key: "jit-grants",          label: "JIT elevation",        icon: "schedule",                 component: JitGrantsPage,          predicate: isWsAdmin        },
  { key: "quotas",              label: "Quotas",               icon: "data_usage",               component: QuotasPage,             predicate: isEditor         },
  { key: "guardrails",          label: "Guardrails",           icon: "shield",                   component: GuardrailsPage,         predicate: isEditor         },
  { key: "compliance",          label: "Compliance",           icon: "gavel",                    component: ComplianceSettingsPage, predicate: isWsAdmin        },
  // Observability — last because it's a read-only browse surface, not
  // a configuration surface like the rest of the rail.
  { key: "audit",               label: "Audit log",            icon: "history",                  component: AuditPage,              predicate: isWsAdmin        },
];

const visibleSections = computed(() => sections.filter(s => s.predicate()));

// Default section: when nothing's in the URL, land on the first
// section the user can see. Workspace settings is always visible, so
// the fallback never explodes.
function defaultKey() {
  return visibleSections.value[0]?.key || "workspace";
}

const activeKey = ref(route.query.view || defaultKey());

const active = computed(() =>
  visibleSections.value.find(s => s.key === activeKey.value)
  || visibleSections.value[0]
  || null,
);
const activeLabel     = computed(() => active.value?.label || "");
const activeComponent = computed(() => active.value?.component || null);

function setActive(key) {
  if (key === activeKey.value) return;
  activeKey.value = key;
  router.replace({ query: { ...route.query, view: key } });
}

// If the URL ever lands on a section the user can't see (deep link
// shared from an admin to a viewer), redirect them to the default.
watch(visibleSections, (vs) => {
  if (vs.length && !vs.some(s => s.key === activeKey.value)) {
    setActive(defaultKey());
  }
}, { immediate: true });

// React to back/forward — keep activeKey in sync with the URL.
watch(() => route.query.view, (v) => {
  if (typeof v === "string" && v !== activeKey.value
      && visibleSections.value.some(s => s.key === v)) {
    activeKey.value = v;
  }
});

onMounted(async () => {
  // Make sure an active project is set before mounting any panel
  // that needs project context (service accounts, plugins, quotas,
  // custom-role grants). Same safety net the standalone pages use.
  if (!auth.activeProjectId) {
    await auth.ensureActiveProject();
  }
});

function goHome() { router.push({ name: "home" }); }
</script>

<style scoped>
/*
  Light-themed sidebar in the same style as HomePage's activity bar —
  the visual language stays consistent across "Workflows / Triggers /
  Instances" on the home page and "Admin > …" here.
*/
.admin-sidebar {
  background: #ffffff;
  border-right: 1px solid #e2e8f0;
}
.admin-sidebar :deep(.q-item) {
  border-radius: 6px;
  margin: 2px 6px;
  color: #475569;
}
.admin-sidebar :deep(.q-item:hover) {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.04);
}
.admin-sidebar :deep(.admin-active) {
  color: #2f6df3;
  background: rgba(47, 109, 243, 0.10);
}
.admin-sidebar :deep(.admin-active::before) {
  content: "";
  position: absolute;
  left: -6px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: #2f6df3;
  border-radius: 0 2px 2px 0;
}
</style>
