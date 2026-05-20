<!--
  Cross-project workflow.fire grants — workspace admin only.

  Each row is a one-way "Project A may call workflows in Project B"
  permission consumed by the workflow.fire plugin at runtime. Same-
  project calls don't need a row.

  UX choice: a single page lists every grant in the workspace and lets
  the admin add new ones via a two-dropdown form. The list view makes
  it obvious which projects can talk to which — important for compliance
  reviews.
-->
<template>
  <div class="page q-pa-md cpg-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Cross-project grants</div>
        <div class="text-caption text-grey-7">
          A workflow can call another workflow as a sub-workflow via the
          <code>workflow.fire</code> plugin. By default, calls stay within
          the same project. Grant a project explicit permission to call
          workflows in another project below.
        </div>
      </div>
      <q-space />
      <q-btn color="primary" unelevated no-caps icon="add" label="New grant" @click="openCreate" />
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="rowKey"
      flat dense bordered
      :loading="loading"
      :pagination="{ rowsPerPage: 50, sortBy: 'caller_name', descending: false }"
    >
      <template v-slot:top-right>
        <q-btn icon="refresh" flat dense size="sm" @click="reload" />
      </template>

      <template v-slot:body-cell-flow="props">
        <q-td :props="props">
          <span class="project-pill">{{ props.row.caller_name }}</span>
          <q-icon name="east" class="q-mx-sm text-grey-7" />
          <span class="project-pill">{{ props.row.callee_name }}</span>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-btn flat dense size="sm" icon="remove_circle" color="negative" @click="onRevoke(props.row)">
            <q-tooltip>Revoke this grant</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <!-- Create dialog ─────────────────────────────────────────── -->
    <q-dialog v-model="createOpen" persistent>
      <q-card style="min-width: 460px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="add" class="q-mr-sm" />
          <q-toolbar-title>New cross-project grant</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <p class="text-caption text-grey-7 q-mb-md">
            Allow workflows in <b>Caller</b> to fire workflows in
            <b>Callee</b>. Grant is one-way — to allow the reverse
            direction too, create a second grant with the projects
            swapped.
          </p>
          <q-select
            v-model="form.caller"
            :options="projectOptions"
            option-label="label" option-value="value"
            emit-value map-options dense outlined
            label="Caller (the project doing workflow.fire) *"
            class="q-mb-sm"
          />
          <q-icon name="south" class="block q-my-xs text-grey-6" style="margin-left: 50%;" />
          <q-select
            v-model="form.callee"
            :options="projectOptions.filter(p => p.value !== form.caller)"
            option-label="label" option-value="value"
            emit-value map-options dense outlined
            label="Callee (the project being called into) *"
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn
            unelevated color="primary" no-caps label="Grant"
            :disable="!form.caller || !form.callee || form.caller === form.callee"
            :loading="saving"
            @click="onSave"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { CrossProjectGrants, Projects } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const projects  = ref([]);
const loading   = ref(false);
const saving    = ref(false);
const loadError = ref("");

const columns = [
  { name: "caller_name", label: "Caller", field: "caller_name", align: "left", sortable: true },
  { name: "flow",        label: "",       align: "left" },
  { name: "callee_name", label: "Callee", field: "callee_name", align: "left", sortable: true },
  {
    name: "created", label: "Granted",
    field: "created_at", align: "left",
    format: v => v ? new Date(v).toLocaleDateString() : "",
    style: "width: 130px;",
  },
  {
    name: "granted_by", label: "By",
    field: "granted_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px;",
  },
  { name: "actions", label: "", align: "right", style: "width: 60px;" },
];

const projectOptions = computed(() =>
  projects.value.map(p => ({ value: p.id, label: p.name })),
);

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    const [grants, projData] = await Promise.all([
      CrossProjectGrants.list(),
      Projects.list(),
    ]);
    // Row-key needs to be unique — composite PK means the caller-id
    // alone isn't enough.
    rows.value = grants.map(g => ({
      ...g,
      rowKey: `${g.caller_project_id}->${g.callee_project_id}`,
    }));
    projects.value = (projData.projects || []).filter(p => !p.deleted_at);
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message || "load failed";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  if (auth.user?.role !== "admin" && !auth.isWorkspaceAdmin) {
    router.replace({ name: "home" });
    return;
  }
  await reload();
});

// ── Create ──────────────────────────────────────────────────
const createOpen = ref(false);
const form = ref({ caller: null, callee: null });

function openCreate() {
  form.value = { caller: null, callee: null };
  createOpen.value = true;
}

async function onSave() {
  saving.value = true;
  try {
    await CrossProjectGrants.create(form.value.caller, form.value.callee);
    createOpen.value = false;
    await reload();
    $q.notify({ type: "positive", message: "Granted", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({
      type: "negative",
      message: e?.response?.data?.message || e.message || "grant failed",
      position: "bottom",
    });
  } finally {
    saving.value = false;
  }
}

async function onRevoke(row) {
  const ok = await confirm(
    "Revoke cross-project grant?",
    `Workflows in "${row.caller_name}" will no longer be able to call workflows in "${row.callee_name}". In-flight executions are unaffected.`,
  );
  if (!ok) return;
  try {
    await CrossProjectGrants.remove(row.caller_project_id, row.callee_project_id);
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

function confirm(title, message) {
  return new Promise((resolve) => {
    $q.dialog({
      title, message, persistent: true,
      ok:     { label: "Revoke", color: "negative", unelevated: true, "no-caps": true },
      cancel: { label: "Cancel", flat: true, "no-caps": true },
    }).onOk(() => resolve(true)).onDismiss(() => resolve(false));
  });
}
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.project-pill {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(47, 109, 243, 0.08);
  color: var(--text);
  padding: 2px 8px;
  border-radius: 3px;
}
</style>
