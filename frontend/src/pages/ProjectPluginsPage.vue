<!--
  Project plugin enablement — which workspace-installed plugins this
  project's workflows are allowed to use.

  Visible to project admins + editors (anyone who can author workflows
  also chooses what tools they can pull from). Workspace admins inherit.

  Built-in (core) plugins always come back as enabled and are rendered
  read-only — they're part of the engine.
-->
<template>
  <div class="page q-pa-md pp-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Project plugins</div>
        <div class="text-caption text-grey-7">
          Plugins are installed at the workspace level. Toggle which ones
          your project is allowed to use. Core plugins are always available.
        </div>
      </div>
      <q-space />
      <q-btn icon="refresh" flat dense @click="reload">
        <q-tooltip>Refresh</q-tooltip>
      </q-btn>
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="name"
      flat dense bordered
      :loading="loading"
      :pagination="{ rowsPerPage: 100, sortBy: 'name', descending: false }"
      :rows-per-page-options="[25, 50, 100, 0]"
    >
      <template v-slot:body-cell-name="props">
        <q-td :props="props">
          <span class="plugin-name">{{ props.row.name }}</span>
          <q-chip v-if="props.row.core" dense square size="11px" color="primary" text-color="white" class="q-ml-xs">core</q-chip>
          <q-chip v-else-if="props.row.source && props.row.source.startsWith('marketplace')"
                  dense square size="11px" color="teal" text-color="white" class="q-ml-xs">marketplace</q-chip>
          <q-chip v-else-if="props.row.source === 'local'"
                  dense square size="11px" color="grey-6" text-color="white" class="q-ml-xs">local</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-version="props">
        <q-td :props="props">
          <code class="version">{{ props.row.version }}</code>
        </q-td>
      </template>

      <template v-slot:body-cell-status="props">
        <q-td :props="props">
          <q-chip
            v-if="props.row.status === 'healthy' || props.row.core"
            dense square size="11px" color="positive" text-color="white"
          >healthy</q-chip>
          <q-chip
            v-else-if="props.row.status === 'unhealthy'"
            dense square size="11px" color="negative" text-color="white"
          >unhealthy</q-chip>
          <q-chip
            v-else
            dense square size="11px" color="grey-5" text-color="white"
          >{{ props.row.status || "unknown" }}</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-enabled="props">
        <q-td :props="props" auto-width>
          <q-toggle
            :model-value="props.row.enabled_in_project"
            :disable="props.row.core || busyRow === props.row.name"
            color="primary"
            @update:model-value="(v) => onToggle(props.row, v)"
          >
            <q-tooltip v-if="props.row.core">Core plugins are always enabled</q-tooltip>
          </q-toggle>
        </q-td>
      </template>

      <template v-slot:body-cell-granted="props">
        <q-td :props="props">
          <template v-if="props.row.enabled_in_project && !props.row.core">
            <q-tooltip>{{ new Date(props.row.granted_at).toLocaleString() }}</q-tooltip>
            <span class="text-grey-7">{{ props.row.granted_by_email || "—" }}</span>
          </template>
          <span v-else class="text-grey-5">—</span>
        </q-td>
      </template>
    </q-table>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { ProjectPlugins } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const loading   = ref(false);
const loadError = ref("");
const busyRow   = ref(null);

const columns = [
  { name: "name",    label: "Plugin",        field: "name",    align: "left", sortable: true },
  { name: "version", label: "Version",       field: "version", align: "left", style: "width: 100px;" },
  { name: "status",  label: "Status",        field: "status",  align: "left", style: "width: 110px;" },
  { name: "enabled", label: "Enabled here",  align: "center",  style: "width: 130px;" },
  { name: "granted", label: "Granted by",    field: "granted_by_email", align: "left" },
];

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    rows.value = await ProjectPlugins.list();
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message || "load failed";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  // Same as the service-accounts page — fall back to auto-select
  // before bouncing. Closes the post-login / deep-link race.
  if (!auth.activeProjectId) {
    const picked = await auth.ensureActiveProject();
    if (!picked) {
      router.replace({ name: "home" });
      return;
    }
  }
  await reload();
});

async function onToggle(row, value) {
  busyRow.value = row.name;
  try {
    await ProjectPlugins.set(row.name, value);
    // Update locally so the UI doesn't flicker through a refetch.
    row.enabled_in_project = value;
    $q.notify({
      type: "positive",
      message: `"${row.name}" ${value ? "enabled" : "disabled"} in this project`,
      timeout: 1200, position: "bottom",
    });
  } catch (e) {
    $q.notify({
      type: "negative",
      message: e?.response?.data?.message || e.message || "toggle failed",
      position: "bottom",
    });
  } finally {
    busyRow.value = null;
  }
}
</script>

<style scoped>
/* Padding handled by q-pa-md on the root div — matches UsersPage. */
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.plugin-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
</style>
