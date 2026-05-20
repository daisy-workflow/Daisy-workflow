<!--
  Just-in-time elevations admin — workspace-admin only.

  Lists active + recently-expired grants in this workspace, lets a
  workspace admin issue new ones, and revoke any active row early.
  Common use case: incident response. Mary needs admin in project
  Finance for the next 4 hours to dig into a stuck workflow.

  The permission resolver already reads jit_grants — enforcement is
  free. This page is purely the admin surface.
-->
<template>
  <div class="page q-pa-md jit-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Just-in-time elevations</div>
        <div class="text-caption text-grey-7">
          Grant a user a higher role for a bounded period — usually for
          incident response. Auto-expires at the deadline; revocable at
          any time. Every action performed while elevated still appears
          in the audit log under the user's name.
        </div>
      </div>
      <q-space />
      <q-btn color="primary" unelevated no-caps icon="bolt" label="Issue elevation" @click="openCreate" />
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="id"
      flat dense bordered
      :loading="loading"
      :pagination="{ rowsPerPage: 50, sortBy: 'created_at', descending: true }"
    >
      <template v-slot:top-right>
        <q-btn icon="refresh" flat dense size="sm" @click="reload" />
      </template>

      <template v-slot:body-cell-status="props">
        <q-td :props="props">
          <q-chip
            v-if="props.row.status === 'active'"
            dense square size="11px" color="positive" text-color="white"
          >active · {{ relativeUntil(props.row.expires_at) }}</q-chip>
          <q-chip
            v-else-if="props.row.status === 'revoked'"
            dense square size="11px" color="grey-6" text-color="white"
          >revoked</q-chip>
          <q-chip
            v-else
            dense square size="11px" color="grey-5" text-color="white"
          >expired</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-user="props">
        <q-td :props="props">
          <div>{{ props.row.user_display_name || props.row.user_email }}</div>
          <div class="text-caption text-grey-7">{{ props.row.user_email }}</div>
        </q-td>
      </template>

      <template v-slot:body-cell-scope="props">
        <q-td :props="props">
          <q-chip dense square size="11px" :color="props.row.scope_type === 'workspace' ? 'primary' : 'teal'" text-color="white">
            {{ props.row.scope_type }}
          </q-chip>
          {{ props.row.scope_name || props.row.scope_id }}
        </q-td>
      </template>

      <template v-slot:body-cell-reason="props">
        <q-td :props="props">
          <span class="reason">{{ props.row.reason }}</span>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-btn
            v-if="props.row.status === 'active'"
            flat dense size="sm" icon="block" color="negative"
            @click="onRevoke(props.row)"
          >
            <q-tooltip>Revoke early</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <!-- Create dialog ─────────────────────────────────────────── -->
    <q-dialog v-model="createOpen" persistent>
      <q-card style="min-width: 540px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="bolt" class="q-mr-sm" />
          <q-toolbar-title>Issue elevation</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-select
            v-model="form.userId"
            :options="userOptions"
            option-label="label" option-value="value"
            emit-value map-options dense outlined
            label="User *"
            class="q-mb-sm"
          />

          <div class="row q-col-gutter-sm q-mb-sm">
            <div class="col-6">
              <q-select
                v-model="form.scopeType"
                :options="['workspace', 'project']"
                dense outlined
                label="Scope *"
              />
            </div>
            <div class="col-6">
              <q-select
                v-if="form.scopeType === 'project'"
                v-model="form.scopeId"
                :options="projectOptions"
                option-label="label" option-value="value"
                emit-value map-options dense outlined
                label="Project *"
              />
              <q-input
                v-else
                :model-value="activeWorkspaceName"
                readonly dense outlined
                label="Workspace"
              />
            </div>
          </div>

          <q-select
            v-model="form.role"
            :options="['admin', 'editor', 'viewer']"
            dense outlined
            label="Role *"
            hint="Usually 'admin' — JIT exists to elevate temporarily."
            class="q-mb-sm"
          />

          <q-input
            v-model="form.reason"
            type="textarea" autogrow
            dense outlined
            label="Reason *"
            hint="What's the incident / task? Surfaces in audit logs."
            class="q-mb-sm"
          />

          <div class="text-caption text-grey-7 q-mb-xs">Duration *</div>
          <div class="row q-gutter-xs q-mb-sm">
            <q-btn
              v-for="d in DURATION_PRESETS" :key="d.minutes"
              :flat="form.durationMinutes !== d.minutes"
              :unelevated="form.durationMinutes === d.minutes"
              :color="form.durationMinutes === d.minutes ? 'primary' : 'grey-7'"
              dense no-caps size="sm"
              :label="d.label"
              @click="form.durationMinutes = d.minutes"
            />
            <q-input
              v-model.number="form.durationMinutes"
              type="number" min="1" max="10080"
              dense outlined
              style="max-width: 110px;"
              suffix="min"
            />
          </div>

          <div v-if="previewExpiresAt" class="text-caption text-grey-7">
            Expires at {{ previewExpiresAt.toLocaleString() }}
          </div>
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn
            unelevated color="primary" no-caps label="Issue"
            :disable="!canSubmit"
            :loading="saving"
            @click="onSave"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { JitGrants, Workspaces, Projects } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const users     = ref([]);
const projects  = ref([]);
const loading   = ref(false);
const saving    = ref(false);
const loadError = ref("");

const DURATION_PRESETS = [
  { minutes: 60,        label: "1h" },
  { minutes: 4 * 60,    label: "4h" },
  { minutes: 8 * 60,    label: "8h" },
  { minutes: 24 * 60,   label: "24h" },
];

const columns = [
  { name: "status",     label: "Status",   field: "status",     align: "left", style: "width: 180px;" },
  { name: "user",       label: "User",     field: "user_email", align: "left" },
  { name: "scope",      label: "Scope",    field: "scope_name", align: "left" },
  { name: "role",       label: "Role",     field: "role",       align: "left", style: "width: 80px;" },
  { name: "reason",     label: "Reason",   field: "reason",     align: "left" },
  {
    name: "created", label: "Granted",
    field: "created_at", align: "left",
    format: v => v ? new Date(v).toLocaleString() : "",
    style: "width: 170px;",
  },
  {
    name: "granted_by", label: "By", field: "granted_by_email", align: "left",
    format: v => v || "—", style: "width: 200px;",
  },
  { name: "actions", label: "", align: "right", style: "width: 60px;" },
];

const userOptions = computed(() =>
  users.value.map(u => ({
    value: u.id,
    label: (u.display_name || u.email) + (u.email && u.display_name ? ` — ${u.email}` : ""),
  })),
);
const projectOptions = computed(() =>
  projects.value.map(p => ({ value: p.id, label: p.name })),
);
const activeWorkspaceName = computed(() => auth.user?.workspaceId || "");

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    const [data, ws, proj] = await Promise.all([
      JitGrants.list(),
      Workspaces.members(auth.user.workspaceId),
      Projects.list(),
    ]);
    rows.value = data;
    users.value = ws;
    projects.value = (proj.projects || []).filter(p => !p.deleted_at);
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

// ── Create dialog ────────────────────────────────────────────
const createOpen = ref(false);
const form = reactive({
  userId:          null,
  scopeType:       "project",
  scopeId:         null,
  role:            "admin",
  reason:          "",
  durationMinutes: 60,
});

function openCreate() {
  Object.assign(form, {
    userId: null, scopeType: "project", scopeId: null,
    role: "admin", reason: "", durationMinutes: 60,
  });
  createOpen.value = true;
}

const previewExpiresAt = computed(() => {
  const m = Math.floor(Number(form.durationMinutes));
  if (!Number.isFinite(m) || m < 1) return null;
  return new Date(Date.now() + m * 60_000);
});

const canSubmit = computed(() => {
  if (!form.userId) return false;
  if (form.scopeType === "project" && !form.scopeId) return false;
  if (!form.reason?.trim()) return false;
  const m = Math.floor(Number(form.durationMinutes));
  if (!Number.isFinite(m) || m < 1) return false;
  return true;
});

async function onSave() {
  saving.value = true;
  try {
    await JitGrants.create({
      userId:          form.userId,
      scopeType:       form.scopeType,
      scopeId:         form.scopeType === "workspace" ? auth.user.workspaceId : form.scopeId,
      role:            form.role,
      reason:          form.reason.trim(),
      durationMinutes: Math.floor(Number(form.durationMinutes)),
    });
    createOpen.value = false;
    await reload();
    $q.notify({ type: "positive", message: "Elevation issued", timeout: 1200, position: "bottom" });
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
    "Revoke elevation?",
    `Revoke ${row.user_email}'s ${row.role} access in ${row.scope_name}? They'll lose the elevated permissions immediately. In-flight requests aren't affected.`,
  );
  if (!ok) return;
  try {
    await JitGrants.revoke(row.id);
    await reload();
    $q.notify({ type: "positive", message: "Revoked", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Helpers ────────────────────────────────────────────────
function relativeUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.round(ms / 1000);
  if (s < 60)    return `${s}s left`;
  if (s < 3600)  return `${Math.round(s / 60)}m left`;
  if (s < 86400) return `${Math.round(s / 3600)}h left`;
  return `${Math.round(s / 86400)}d left`;
}

function confirm(title, message) {
  return new Promise((resolve) => {
    $q.dialog({
      title, message, persistent: true,
      ok:     { label: "Revoke", color: "negative", unelevated: true, "no-caps": true },
      cancel: { label: "Cancel",  flat: true, "no-caps": true },
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
.reason {
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
