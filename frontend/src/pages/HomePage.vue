<!--
  Home page — VS Code style activity bar on the left, content on the right.
  The previous single-page-with-stacked-tables version is preserved as
  HomePage.legacy.vue.

  Sections (driven by role):
    workflows         admin, editor          (viewer: hidden)
    triggers          admin, editor          (viewer: hidden)
    agents            admin, editor          (viewer: hidden)
    configs           admin (edit) +
                      editor (view-only)     (viewer: hidden)
    instances         admin, editor, viewer
    running           admin, editor          (viewer: hidden)

  Row-click conventions:
    • Workflow → opens FlowDesigner in a NEW TAB. The editor is heavy
      enough that this matches user habit of "keep multiple workflows
      open at once".
    • Everything else → same-tab navigation to its respective editor /
      detail page.

  Persistence: the chosen section lives in the URL as ?view=<key> so
  reloads and shared links land on the same panel.
-->

<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <q-img
         :src="$q.dark.isActive ? '/dag_logo_dark.png' : '/dag_logo_light.png'"
          style="width: 28px; height: 28px;" class="q-mr-sm" />
        <q-toolbar-title>DAISY Workflow Engine</q-toolbar-title>
        <q-space />
        <!-- Centralised Ask Agent button. Opens a full-screen chat
             that can produce workflows, agents, and plugins from one
             conversation. Replaces the per-page "Ask AI" entry points
             over time (Prompt tab on the editor, Ask Agent on the
             Plugins page) — both will eventually re-launch this. -->
        <q-btn
          flat dense no-caps
          icon="auto_awesome"
          label="Ask Agent"
          class="ask-agent-btn"
          @click="orchestratorOpen = true"
        >
          <q-tooltip>Describe what you want — workflows, agents, or plugins</q-tooltip>
        </q-btn>
      </q-toolbar>
    </q-header>

    <OrchestratorChat v-model="orchestratorOpen" @saved="onOrchestratorSaved" />

    <!-- Activity bar — fixed-width vertical rail of icons -->
    <q-drawer
      side="left"
      :model-value="true"
      :width="64"
      bordered
      persistent
      class="activity-bar"
    >
      <div class="rail">
        <q-btn
          v-for="item in visibleSections"
          :key="item.key"
          flat dense round
          :icon="item.icon"
          class="rail-btn"
          :class="{ active: activeKey === item.key }"
          @click="setActive(item.key)"
        >
          <q-tooltip anchor="center right" self="center left" :offset="[10, 0]">
            {{ item.tooltip }}
          </q-tooltip>
        </q-btn>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="app-page home-content">
        <div class="content-header q-mb-md">
          <div class="text-h6">{{ activeLabel }}</div>
          <div class="text-caption text-grey-7">{{ activeSubtitle }}</div>
        </div>

        <!-- Workflows ────────────────────────────────────────────────
             Two extra launcher buttons per row — code mode and visual
             mode — flow through the leftmost "action" column via the
             `row-action` slot. Row click (the name cell) still calls
             onEditWorkflow, which now respects the saved per-workflow
             mode preference in localStorage. -->
        <AppTable
          v-if="activeKey === 'workflows'"
          :rows="wf_rows"
          :columns="wf_columns"
          title="Workflows"
          @add="onAddWorkflow"
          @edit="onEditWorkflow"
          @delete="onDeleteWorkflow"
          @delete-selected="onDeleteSelectedWorkflows"
          @refresh="reload"
          @export="onExportWorkflows"
          @import="onImportWorkflows"
        >
          <template #row-action="{ row }">
            <q-btn
              flat dense round size="sm"
              icon="code"
              @click.stop="onOpenFlow(row, 'code')"
            >
              <q-tooltip>Open in code mode</q-tooltip>
            </q-btn>
            <q-btn
              flat dense round size="sm"
              icon="schema"
              @click.stop="onOpenFlow(row, 'visual')"
            >
              <q-tooltip>Open in visual mode</q-tooltip>
            </q-btn>
          </template>
        </AppTable>

        <!-- Triggers ───────────────────────────────────────────────────
             Unified view: lists every trigger (running or stopped) and
             exposes per-row Run / Start / Stop / Edit / Delete inline.
             Replaces the old split between "Triggers" + "Running
             triggers" — operators can flip subscription state without
             leaving the page. -->
        <TriggersTable
          v-else-if="activeKey === 'triggers'"
          :rows="trigger_rows"
          :columns="trigger_columns"
          title="Triggers"
          :role="auth.user?.role || 'viewer'"
          :busy-row="triggerBusy"
          @add="onAddTrigger"
          @edit="onEditTrigger"
          @delete="onDeleteTrigger"
          @refresh="reload"
          @run="fireTrigger"
          @start="startTrigger"
          @stop="stopTrigger"
          @export="onExportTriggers"
          @import="onImportTriggers"
        />

        <!-- Agents ─────────────────────────────────────────────────── -->
        <AppTable
          v-else-if="activeKey === 'agents'"
          :rows="agent_rows"
          :columns="agent_columns"
          title="Agents"
          @add="onAddAgent"
          @edit="onEditAgent"
          @delete="onDeleteAgent"
          @delete-selected="onDeleteSelectedAgents"
        />

        <!-- Configurations (admin: full CRUD; editor: read-only) ───── -->
        <AppTable
          v-else-if="activeKey === 'configs'"
          :rows="config_rows"
          :columns="config_columns"
          :title="isAdmin ? 'Configurations' : 'Configurations (read-only)'"
          :read-only="!isAdmin"
          :clickable="isAdmin"
          @add="onAddConfig"
          @edit="onEditConfig"
          @delete="onDeleteConfig"
          @delete-selected="onDeleteSelectedConfigs"
        />

        <!-- Knowledge bases (Phase B) — RAG vector stores per project.
             Embedded-page pattern; the component carries its own
             page-header so the home content-header stays blank. -->
        <KnowledgeBasesPage v-else-if="activeKey === 'kbs'" />

        <!-- Prompt templates (Phase D) — embedded page; the component
             carries its own page-header, so the surrounding home
             content-header is intentionally blank (label/subtitle = ""). -->
        <PromptTemplatesPage v-else-if="activeKey === 'prompts'" />

        <!-- Evals (Phase D) — suites + cases + run history. Same
             embedded-page pattern as PromptTemplatesPage above. -->
        <EvalsPage v-else-if="activeKey === 'evals'" />

        <!-- Model routes (Phase E) — named indirections for swapping
             agents without editing every workflow. Same embedded-page
             pattern as the surfaces above. -->
        <ModelRoutesPage v-else-if="activeKey === 'routes'" />

        <!-- Instances — every role sees the list; only admins can delete.
             A chip-style q-select sits above the table for filtering by
             tag. Empty filter passes all rows. Click a chip in the table
             body to toggle that tag in the filter (handled in script). -->
        <template v-else-if="activeKey === 'instances'">
          <div class="row items-center q-pa-sm q-pb-none">
            <q-select
              v-model="exec_tag_filter"
              dense outlined
              use-input use-chips multiple hide-dropdown-icon
              input-debounce="0"
              new-value-mode="add-unique"
              :options="[]"
              label="Filter by tags"
              hint="OR semantics — rows pass when ANY listed tag is present."
              style="min-width: 280px;"
            />
          </div>
          <AppTable
            :rows="exec_rows_filtered"
            :columns="exec_columns"
            :title="isAdmin ? 'Instances' : 'Instances (read-only)'"
            :read-only="!isAdmin"
            @edit="onOpenInstance"
            @delete="onDeleteInstance"
            @delete-selected="onDeleteSelectedInstances"
            @refresh="reload"
            @tag-click="onExecTagClick"
          />
        </template>

        <PluginsPage v-else-if="activeKey === 'plugin'"/>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Triggers, Configs, Agents, Executions } from "../api/client";
import { auth } from "../stores/auth.js";
import AppTable from "../components/AppTable.vue";
import TriggersTable from "../components/TriggersTable.vue";
import OrchestratorChat from "../components/OrchestratorChat.vue";
import PluginsPage from "./PluginsPage.vue"
// Content-authoring surfaces that used to live under /admin. Moved
// to the Home rail so editors don't detour through a governance
// page to edit a prompt or run an eval — they sit alongside Agents
// and Configurations.
import KnowledgeBasesPage from "./KnowledgeBasesPage.vue"
import PromptTemplatesPage from "./PromptTemplatesPage.vue"
import EvalsPage from "./EvalsPage.vue"
import ModelRoutesPage from "./ModelRoutesPage.vue"
// File picker + download helpers — same utilities the FlowDesigner
// uses for its single-flow Import/Export buttons.
import { downloadText, pickFileAsText } from "../components/flow/flowModel.js";
import { getFlowMode, setFlowMode, clearFlowMode } from "../components/flow/flowMode.js";
const router = useRouter();
const route  = useRoute();
const $q     = useQuasar();

// ──────────────────────────────────────────────────────────────────────
// Sidebar items + role gating
// ──────────────────────────────────────────────────────────────────────
const isAdmin  = computed(() => auth.user?.role === "admin");
const isEditor = computed(() => auth.user?.role === "editor");
const isViewer = computed(() => auth.user?.role === "viewer");

// `roles` lists every role allowed to SEE this section. Configuration
// is visible to admin + editor but the editor flavour is read-only —
// the `readOnlyFor` field is consumed at render time, not here.
const sections = [
  { key: "workflows", icon: "schema",           label: "Workflows",
    tooltip: "Workflows",         subtitle: "Workflow definitions in this workspace.",
    roles: ["admin", "editor"] },
  { key: "triggers",  icon: "bolt",             label: "Triggers",
    tooltip: "Triggers",          subtitle: "Schedule / webhook / MQTT / email sources that fire workflows.",
    roles: ["admin", "editor"] },
  { key: "agents",    icon: "smart_toy",        label: "Agents",
    tooltip: "Agents",            subtitle: "LLM personas referenced by the agent plugin.",
    roles: ["admin", "editor"] },
  { key: "configs",   icon: "settings_input_component", label: "Configurations",
    tooltip: "Configurations",    subtitle: "Reusable credentials & connection settings.",
    roles: ["admin", "editor"] },
  // Empty label/subtitle — these pages render their own headers
  // (same pattern as PluginsPage), and double-headers look awful.
  // The rail's tooltip is the only label they need.
  { key: "kbs",       icon: "library_books",    label: "",
    tooltip: "Knowledge bases",   subtitle: "",
    roles: ["admin", "editor"] },
  { key: "prompts",   icon: "text_snippet",     label: "",
    tooltip: "Prompt templates",  subtitle: "",
    roles: ["admin", "editor"] },
  { key: "evals",     icon: "fact_check",       label: "",
    tooltip: "Evals",             subtitle: "",
    roles: ["admin", "editor"] },
  { key: "routes",    icon: "alt_route",        label: "",
    tooltip: "Model routes",      subtitle: "",
    roles: ["admin", "editor"] },
  { key: "instances", icon: "monitor",          label: "Instances",
    tooltip: "Instances",         subtitle: "Live and historical workflow executions.",
    roles: ["admin", "editor", "viewer"] },
  // "Running triggers" merged into the Triggers view — that table
  // now exposes Run / Start / Stop per row, so a separate tab is
  // no longer needed.
    { key: "plugin",   icon: "add_business",      label: "",
    tooltip: "Plugins",  subtitle: "",
    roles: ["admin", "editor"] },
];

const visibleSections = computed(() => {
  if (!auth.user) return [];
  return sections.filter(s => s.roles.includes(auth.user.role));
});

// Default section depends on role: viewers should land on Instances
// (only thing they can access), everyone else lands on Workflows.
function defaultKey() {
  if (isViewer.value) return "instances";
  return "workflows";
}

const activeKey = ref(route.query.view || defaultKey());

const active = computed(() =>
  visibleSections.value.find(s => s.key === activeKey.value) ||
  visibleSections.value[0] ||
  null,
);
const activeLabel    = computed(() => active.value?.label    || "");
const activeSubtitle = computed(() => active.value?.subtitle || "");

function setActive(key) {
  if (key === activeKey.value) return;
  activeKey.value = key;
  // Sync URL so reload + shared links land here.
  router.replace({ query: { ...route.query, view: key } });
}

// If the URL ever lands on a section the current user can't see (e.g.
// a viewer bookmarking ?view=configs), bounce them to their default.
watch(visibleSections, (vs) => {
  if (vs.length && !vs.some(s => s.key === activeKey.value)) {
    setActive(defaultKey());
  }
}, { immediate: true });

// ──────────────────────────────────────────────────────────────────────
// Data sources
// ──────────────────────────────────────────────────────────────────────
// Centralised Ask-Agent chat dialog (top-bar button). Open state is
// owned by HomePage so the same instance survives sidebar navigation.
const orchestratorOpen = ref(false);

// When the agent finishes saving a workflow / agent / plugin we
// refresh the underlying tables so the new row shows up immediately.
function onOrchestratorSaved(_evt) { reload(); }

const wf_rows      = ref([]);
const trigger_rows = ref([]);
const config_rows  = ref([]);
const agent_rows   = ref([]);
const exec_rows    = ref([]);

// Tag filter for the Instances table. Empty list means "no filter".
// Persisted to localStorage so it survives reloads, same shape as
// FlowInspector's tagFilter (overlap / OR semantics across selected
// tags). Click a chip in the table to add it; click the chip again
// in the filter input's x to remove it.
const exec_tag_filter = ref((() => {
  try {
    const saved = JSON.parse(localStorage.getItem("home.exec.tagFilter") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
})());
watch(exec_tag_filter, (v) => {
  try { localStorage.setItem("home.exec.tagFilter", JSON.stringify(v || [])); }
  catch { /* ignore */ }
}, { deep: true });

// Filtered view bound to AppTable. Overlap match — a row passes when
// ANY of its tags overlaps the filter list. Empty filter passes all.
const exec_rows_filtered = computed(() => {
  if (!exec_tag_filter.value.length) return exec_rows.value;
  const wanted = exec_tag_filter.value.map(t => String(t).toLowerCase());
  return exec_rows.value.filter(r => {
    const rowTags = (r.tags || []).map(t => String(t).toLowerCase());
    return wanted.some(t => rowTags.includes(t));
  });
});

// Click handler: toggle the clicked tag in/out of the filter list so
// successive clicks on the same chip alternate between "filter by this"
// and "stop filtering by this".
function onExecTagClick(tag) {
  const i = exec_tag_filter.value.indexOf(tag);
  if (i >= 0) exec_tag_filter.value.splice(i, 1);
  else        exec_tag_filter.value.push(tag);
}

// `running_rows` used to power a separate sidebar tab. The Triggers
// view now subsumes that — its inline Start/Stop buttons + status
// pill replace the need to filter triggers down to running ones.

// ──────────────────────────────────────────────────────────────────────
// Columns (same shapes as the legacy HomePage so AppTable behaves
// identically across both pages).
// ──────────────────────────────────────────────────────────────────────
const wf_columns = [
  { name: "action", label: "", style: "width:2px" },
  { name: "name",   label: "Name", field: "name", align: "left", sortable: true },
  { name: "id",     label: "ID",   field: "id",   align: "left", style: "width: 300px" },
  {
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const trigger_columns = [
  { name: "action", label: "", style: "width:2px" },
  {
    name: "status", label: "Status", field: row => triggerStatusLabel(row),
    align: "left", style: "width: 70px;",
  },
  { name: "name",  label: "Name",  field: "name", align: "left", sortable: true },
  { name: "type",  label: "Type",  field: "type", align: "left", sortable: true, style: "width: 70px;" },
  { name: "graph", label: "Flow",  field: row => graphName(row.graph_id), align: "left" },
  { name: "fires", label: "Fires", field: "fire_count", align: "right", style: "width: 60px;" },
  {
    name: "lastFired", label: "Last", field: "last_fired_at", align: "left",
    format: v => v ? new Date(v).toLocaleString() : "—",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 180px",
  },
  // Holds Run, Start/Stop, Edit, Delete inline (rendered by
  // TriggersTable's body-cell-actions slot). Edit + Delete only
  // appear for admin / editor, so the column collapses for viewers.
  { name: "actions", label: "", align: "right", style: "width: 168px;" },
];

const config_columns = [
  { name: "action", label: "", style: "width:2px" },
  { name: "name",        label: "Name",        field: "name",        align: "left", sortable: true },
  { name: "type",        label: "Type",        field: "type",        align: "left", sortable: true, style: "width: 130px;" },
  { name: "description", label: "Description", field: "description", align: "left" },
  {
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const agent_columns = [
  { name: "action", label: "", style: "width:2px" },
  { name: "title",       label: "Title",       field: "title",       align: "left", sortable: true },
  { name: "config_name", label: "AI provider", field: "config_name", align: "left", sortable: true, style: "width: 200px;" },
  { name: "description", label: "Description", field: "description", align: "left" },
  {
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const exec_columns = [
  { name: "action", label: "", style: "width:2px" },
  {
    name: "status", label: "Status", field: "status",
    align: "left", style: "width: 90px;",
  },
  // Primary clickable column. Named "name" so AppTable's
  // body-cell-name slot wires up the link affordance + click handler
  // (which the parent listens for as @edit → onOpenInstance).
  { name: "name", label: "Workflow", field: "graph_name", align: "left", sortable: true },
  { name: "id",   label: "Execution", field: "id", align: "left", style: "width: 300px" },
  {
    name: "started", label: "Started", field: "started_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "—",
  },
  {
    name: "duration", label: "Duration",
    field: row => (row.started_at && row.finished_at)
      ? `${Math.round((new Date(row.finished_at) - new Date(row.started_at)) / 1000)}s` : "—",
    align: "right", style: "width: 80px;",
  },
  // Tags — AppTable has a built-in body-cell-tags renderer that turns
  // this column's value (an array) into clickable chips, and emits
  // `tag-click` upward when one is clicked.
  { name: "tags", label: "Tags", field: row => row.tags || [], align: "left", style: "max-width: 220px;" },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

function graphName(graphId) {
  const g = wf_rows.value.find(x => x.id === graphId);
  return g ? g.name : (graphId ? graphId.slice(0, 8) + "…" : "");
}
function triggerStatusLabel(row) {
  if (!row?.enabled) return "off";
  if (row?.last_error) return "error";
  return "running";
}

// ──────────────────────────────────────────────────────────────────────
// Reload — each list is only fetched if the role allows reading it.
// We always fetch in parallel and tolerate per-list failures so one
// broken endpoint doesn't black out the page.
// ──────────────────────────────────────────────────────────────────────
async function reload() {
  const canSee = (key) => visibleSections.value.some(s => s.key === key);

  const [graphs, triggers, configs, agents, execs] = await Promise.all([
    canSee("workflows") ? Graphs.list().catch(() => [])    : Promise.resolve([]),
    canSee("triggers")  ? Triggers.list().catch(() => [])  : Promise.resolve([]),
    canSee("configs")   ? Configs.list().catch(() => [])   : Promise.resolve([]),
    canSee("agents")    ? Agents.list().catch(() => [])    : Promise.resolve([]),
    canSee("instances") ? Executions.list({ limit: 100 }).catch(() => []) : Promise.resolve([]),
  ]);
  wf_rows.value      = graphs;
  trigger_rows.value = triggers;
  config_rows.value  = configs;
  agent_rows.value   = agents;
  exec_rows.value    = execs;
}
onMounted(reload);

// ──────────────────────────────────────────────────────────────────────
// Row actions
//
// Workflow rows open in a NEW TAB — they're the heaviest editor and
// users keep several open at once. Everything else stays in-page.
// ──────────────────────────────────────────────────────────────────────
function onAddWorkflow() {
  // New flows always start in visual mode (the friendlier first
  // impression). The user can switch via the toolbar toggle once the
  // flow is saved.
  router.push({ path: `/flowDesigner/new/visual` });
}
function onEditWorkflow(row) {
  // Row click respects the user's saved per-workflow preference.
  // Defaults to visual when nothing's stored (see flowMode.js).
  const mode = getFlowMode(row.id);
  router.push({ path: `/flowDesigner/${row.id}/${mode}` });
}
// Explicit launcher buttons in the leftmost cell. Clicking either one
// also updates the saved preference so future row clicks land in the
// same mode without needing the button again.
function onOpenFlow(row, mode) {
  setFlowMode(row.id, mode);
  router.push({ path: `/flowDesigner/${row.id}/${mode}` });
}
async function onDeleteWorkflow(row) {
  if (!await confirm(`Delete workflow "${row.name}"?`)) return;
  try {
    await Graphs.remove(row.id);
    // Drop the orphaned mode preference so we don't accumulate
    // localStorage cruft for long-gone workflows.
    clearFlowMode(row.id);
    notify(`Deleted "${row.name}"`, "positive");
    await reload();
  }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedWorkflows(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} workflow(s)?`)) return;
  let failed = 0;
  for (const r of rows) {
    try { await Graphs.remove(r.id); clearFlowMode(r.id); }
    catch { failed++; }
  }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} workflow(s)`, failed ? "warning" : "positive");
  await reload();
}

function onAddTrigger()      { router.push({ path: "/triggerDesigner/new" }); }
function onEditTrigger(row)  { router.push({ path: `/triggerDesigner/${row.id}` }); }
async function onDeleteTrigger(row) {
  if (!await confirm(`Delete trigger "${row.name}"? It will be unsubscribed and removed.`)) return;
  try { await Triggers.remove(row.id); notify(`Deleted "${row.name}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
// Bulk-delete on triggers was dropped when the dedicated "Running
// triggers" tab was merged in — TriggersTable now exposes inline
// per-row Run / Start / Stop / Edit / Delete, no checkbox column.

// Per-row busy flag for Run / Start / Stop buttons on the Triggers table.
// Same pattern as FlowInspector: prevents double-clicks while the API call
// is in flight.
const triggerBusy = reactive({});

async function fireTrigger(row) {
  if (triggerBusy[row.id]) return;
  triggerBusy[row.id] = true;
  try {
    const { executionId } = await Triggers.fire(row.id);
    notify(`Fired "${row.name}"`, "positive");
    await reload();
    if (executionId) router.push(`/instanceViewer/${executionId}`);
  } catch (e) {
    notify(`Run failed: ${errMsg(e)}`, "negative");
  } finally {
    triggerBusy[row.id] = false;
  }
}
async function stopTrigger(row) {
  if (triggerBusy[row.id]) return;
  triggerBusy[row.id] = true;
  try {
    await Triggers.update(row.id, { enabled: false });
    notify(`Stopped "${row.name}"`, "positive");
    await reload();
  } catch (e) {
    notify(`Stop failed: ${errMsg(e)}`, "negative");
  } finally {
    triggerBusy[row.id] = false;
  }
}
async function startTrigger(row) {
  if (triggerBusy[row.id]) return;
  triggerBusy[row.id] = true;
  try {
    await Triggers.update(row.id, { enabled: true });
    notify(`Started "${row.name}"`, "positive");
    await reload();
  } catch (e) {
    notify(`Start failed: ${errMsg(e)}`, "negative");
  } finally {
    triggerBusy[row.id] = false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Bulk Import / Export — Workflows + Triggers.
//
// Export: pulls the full row(s) from the API (the table rows are a
//   slim listing; we need each graph's `dsl` for a useful export, and
//   each trigger's full config). Bundles into a single JSON file and
//   downloads. The exported file is human-readable + diff-able.
//
// Import: opens a file picker, parses JSON (accepts either a single
//   object or an array), creates each via the existing
//   Graphs.create / Triggers.create endpoints. Errors are
//   accumulated; the user gets a single notify with counts at the
//   end so a bad row doesn't blow up the whole batch.
//
// Triggers export resolves the parent flow by NAME (not id) so the
// JSON is portable between environments — `graph_id` is a UUID that
// differs per deployment. Import does the reverse lookup.
// ──────────────────────────────────────────────────────────────────────

async function onExportWorkflows() {
  try {
    // The table's `wf_rows` is the listing shape (no full dsl), so
    // re-fetch each graph for its canonical JSON. Done in parallel
    // since it's a read-only N-request fan-out.
    const full = await Promise.all(wf_rows.value.map(r => Graphs.get(r.id).catch(() => null)));
    const out = full.filter(Boolean).map(g => {
      // Prefer the parsed shape if the server returns it; fall back
      // to re-parsing dsl. Strip server-side bookkeeping fields.
      const dsl = g.parsed || (typeof g.dsl === "string" ? safeParse(g.dsl) : g.dsl);
      return dsl;
    });
    const payload = JSON.stringify({ kind: "daisy.workflows", version: 1, workflows: out }, null, 2);
    downloadText(`workflows-${Date.now()}.json`, payload, "application/json");
    notify(`Exported ${out.length} workflow(s)`, "positive");
  } catch (e) {
    notify(`Export failed: ${errMsg(e)}`, "negative");
  }
}

async function onImportWorkflows() {
  const text = await pickFileAsText(".json,.txt");
  if (!text) return;
  let bundle;
  try { bundle = JSON.parse(text); }
  catch (e) { notify(`Import: not valid JSON (${e.message})`, "negative"); return; }
  // Accept three shapes: { kind, workflows: [...] }, a bare array, or
  // a single workflow object. Same flexibility as the FlowDesigner's
  // single-flow import.
  const items = Array.isArray(bundle?.workflows) ? bundle.workflows
              : Array.isArray(bundle)            ? bundle
              : [bundle];
  let ok = 0, failed = 0;
  for (const item of items) {
    try { await Graphs.create(item); ok++; }
    catch { failed++; }
  }
  await reload();
  notify(failed
    ? `Imported ${ok}/${items.length} (${failed} failed)`
    : `Imported ${ok} workflow(s)`,
    failed ? "warning" : "positive");
}

async function onExportTriggers(selected = []) {
  try {
    // The TriggersTable emits the current selection. Empty selection
    // means "export everything" — easier than two buttons or a mode
    // toggle, and matches the principle of "no selection = whole
    // list." The Export button's tooltip flips to reflect this so
    // the choice is visible.
    const source = Array.isArray(selected) && selected.length
      ? selected
      : trigger_rows.value;
    // Re-fetch each trigger via Triggers.get to be sure we have the
    // canonical config. The listing shape is usually identical, but
    // belt-and-braces.
    const full = await Promise.all(source.map(r => Triggers.get(r.id).catch(() => null)));
    const out = full.filter(Boolean).map(t => ({
      name:       t.name,
      type:       t.type,
      graph_name: graphName(t.graph_id) || null,   // portable: name, not uuid
      config:     t.config,
      enabled:    !!t.enabled,
    }));
    const payload = JSON.stringify({ kind: "daisy.triggers", version: 1, triggers: out }, null, 2);
    const tag = selected.length ? `selected-${out.length}` : `all-${out.length}`;
    downloadText(`triggers-${tag}-${Date.now()}.json`, payload, "application/json");
    notify(`Exported ${out.length} trigger(s)`, "positive");
  } catch (e) {
    notify(`Export failed: ${errMsg(e)}`, "negative");
  }
}

async function onImportTriggers() {
  const text = await pickFileAsText(".json,.txt");
  if (!text) return;
  let bundle;
  try { bundle = JSON.parse(text); }
  catch (e) { notify(`Import: not valid JSON (${e.message})`, "negative"); return; }
  const items = Array.isArray(bundle?.triggers) ? bundle.triggers
              : Array.isArray(bundle)           ? bundle
              : [bundle];
  // Build a name→id index for graph lookup. The listing is already
  // loaded into wf_rows on every reload, but if it's empty (user
  // hasn't visited Workflows yet) fall back to a fresh fetch.
  const graphs = wf_rows.value.length ? wf_rows.value : await Graphs.list().catch(() => []);
  const idByName = new Map(graphs.map(g => [g.name, g.id]));

  let ok = 0, failed = 0, missing = 0;
  for (const item of items) {
    try {
      const graphId = item.graph_id || (item.graph_name && idByName.get(item.graph_name));
      if (!graphId) { missing++; continue; }
      await Triggers.create({
        name:    item.name,
        graphId,
        type:    item.type,
        config:  item.config || {},
        enabled: !!item.enabled,
      });
      ok++;
    } catch { failed++; }
  }
  await reload();
  const parts = [`Imported ${ok}/${items.length}`];
  if (failed)  parts.push(`${failed} failed`);
  if (missing) parts.push(`${missing} skipped (flow not found)`);
  notify(parts.join(" · "), (failed || missing) ? "warning" : "positive");
}

// Tolerant JSON.parse for cases where the workflow's DSL is stored
// as a string (legacy rows). Returns null on parse failure rather
// than throwing — the caller decides what to do.
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function onAddAgent()        { router.push({ path: "/agentDesigner/new" }); }
function onEditAgent(row)    { router.push({ path: `/agentDesigner/${row.id}` }); }
async function onDeleteAgent(row) {
  if (!await confirm(`Delete agent "${row.title}"? Any plugin nodes referencing it will start failing.`)) return;
  try { await Agents.remove(row.id); notify(`Deleted "${row.title}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedAgents(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} agent(s)?`)) return;
  let failed = 0;
  for (const r of rows) { try { await Agents.remove(r.id); } catch { failed++; } }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} agent(s)`, failed ? "warning" : "positive");
  await reload();
}

function onAddConfig()       { router.push({ path: "/configDesigner/new" }); }
function onEditConfig(row)   { router.push({ path: `/configDesigner/${row.id}` }); }
async function onDeleteConfig(row) {
  if (!await confirm(`Delete configuration "${row.name}"? Anything referencing ${'${'}config.${row.name}.*${'}'} will stop resolving.`)) return;
  try { await Configs.remove(row.id); notify(`Deleted "${row.name}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedConfigs(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} configuration(s)?`)) return;
  let failed = 0;
  for (const r of rows) { try { await Configs.remove(r.id); } catch { failed++; } }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} configuration(s)`, failed ? "warning" : "positive");
  await reload();
}

function onOpenInstance(row) {
  router.push({ name: "instanceViewer", params: { id: row.id } });
}

// Mirrors onDeleteConfig — admin-only, single-row. The Instances table
// passes a fully-hydrated row including `status`, so we guard against
// deleting in-flight executions (matches FlowInspector's isInFlight rule:
// running, queued, paused, waiting are off-limits).
async function onDeleteInstance(row) {
  if (!row?.id) return;
  if (isInFlightStatus(row.status)) {
    notify(`Can't delete while still ${row.status}`, "warning");
    return;
  }
  if (!await confirm(`Delete execution ${String(row.id).slice(0, 8)}…? This cannot be undone.`)) return;
  try {
    await Executions.remove(row.id);
    notify(`Deleted execution ${String(row.id).slice(0, 8)}…`, "positive");
    await reload();
  } catch (e) {
    notify(`Delete failed: ${errMsg(e)}`, "negative");
  }
}

async function onDeleteSelectedInstances(rows) {
  if (!rows?.length) return;
  // Drop in-flight rows up front — same rule the per-row handler enforces.
  const targets = rows.filter(r => !isInFlightStatus(r.status));
  const skipped = rows.length - targets.length;
  if (!targets.length) {
    notify(`All selected rows are still running — nothing to delete.`, "warning");
    return;
  }
  const msg = skipped
    ? `Delete ${targets.length} execution(s)? ${skipped} still-running row(s) will be skipped. This cannot be undone.`
    : `Delete ${targets.length} execution(s)? This cannot be undone.`;
  if (!await confirm(msg)) return;

  let failed = 0;
  for (const r of targets) {
    try { await Executions.remove(r.id); }
    catch { failed++; }
  }
  notify(
    failed
      ? `Deleted ${targets.length - failed} of ${targets.length} (${failed} failed)`
      : `Deleted ${targets.length} execution(s)`,
    failed ? "warning" : "positive",
  );
  await reload();
}

// Centralised in-flight check — keep in sync with the backend's notion of
// terminal vs non-terminal status. Anything not in this set is fair game
// to delete (success, failed, skipped, cancelled, …).
function isInFlightStatus(status) {
  return ["running", "queued", "paused", "waiting"].includes(String(status || "").toLowerCase());
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────
function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
function confirm(message) {
  return new Promise((resolve) => {
    $q.dialog({
      title: "Confirm",
      message,
      persistent: true,
      ok:     { label: "Delete", color: "negative", unelevated: true, "no-caps": true },
      cancel: { label: "Cancel", flat: true,  "no-caps": true },
    })
      .onOk(() => resolve(true))
      .onDismiss(() => resolve(false));
  });
}
function notify(message, type = "positive") {
  $q.notify({ type, message, timeout: 1800, position: "bottom" });
}
</script>

<style scoped>
/* Ask Agent button — soft primary chip in the top toolbar so it
   reads as a feature affordance rather than a regular icon button.
   Sits to the right of the title; the avatar/theme cluster from
   UserMenu still floats over the right edge. */
.ask-agent-btn {
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 18px;
  padding: 4px 14px;
  margin-right: 12px;
  font-weight: 500;
}
.ask-agent-btn:hover { background: var(--primary-soft); filter: brightness(0.97); }

/*
  Light-themed activity bar. Surface tones match the rest of the app
  (light Quasar theme + brand primary #2f6df3 from main.js).
*/
.activity-bar {
  background: #ffffff;
  border-right: 1px solid #e2e8f0;
}
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  gap: 4px;
}
.rail-btn {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  color: #64748b;            /* slate-500 — readable but recedes */
}
.rail-btn:hover {
  color: #0f172a;            /* slate-900 on hover */
  background: rgba(15, 23, 42, 0.04);
}
.rail-btn.active {
  /* Tinted in primary so the active state pops against the white
     rail without going as heavy as a filled chip. */
  color: #2f6df3;
  background: rgba(47, 109, 243, 0.10);
  position: relative;
}
.rail-btn.active::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: #2f6df3;
  border-radius: 0 2px 2px 0;
}
.home-content {
  padding: 18px 22px;
}
.content-header {
  margin-bottom: 12px;
}
</style>
