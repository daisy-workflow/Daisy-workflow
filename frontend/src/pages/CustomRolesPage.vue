<!--
  Custom roles admin — workspace-scoped.

  Workspace admins create / edit / delete roles, then assign them to
  users at either workspace or project scope. The permission picker
  comes from /custom-roles/catalog so the UI always reflects the
  server-side source of truth.
-->
<template>
  <div class="page q-pa-md custom-roles-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Custom roles</div>
        <div class="text-caption text-grey-7">
          Define named permission sets and grant them to users. Granted
          permissions add on top of whatever built-in role
          (admin/editor/viewer) the user already holds.
        </div>
      </div>
      <q-space />
      <q-btn
        color="primary" unelevated no-caps icon="add" label="New role"
        @click="openCreate"
      />
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
      :pagination="{ rowsPerPage: 50, sortBy: 'name', descending: false }"
    >
      <template v-slot:body-cell-name="props">
        <q-td :props="props">
          <span class="text-primary cursor-pointer" @click="openEdit(props.row)">
            {{ props.row.name }}
          </span>
        </q-td>
      </template>

      <template v-slot:body-cell-permissions="props">
        <q-td :props="props">
          <q-chip
            v-for="p in props.row.permissions.slice(0, 5)" :key="p"
            dense square size="10px" color="grey-3" text-color="grey-9"
            class="q-mr-xs"
          >{{ p }}</q-chip>
          <q-chip
            v-if="props.row.permissions.length > 5"
            dense square size="10px" color="grey-5" text-color="white"
          >+{{ props.row.permissions.length - 5 }}</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-btn flat dense size="sm" icon="group_add" @click="openGrants(props.row)">
            <q-tooltip>Manage grants</q-tooltip>
          </q-btn>
          <q-btn flat dense size="sm" icon="edit" @click="openEdit(props.row)">
            <q-tooltip>Edit</q-tooltip>
          </q-btn>
          <q-btn flat dense size="sm" icon="delete" color="negative" @click="onDelete(props.row)">
            <q-tooltip>Delete</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <!-- Create / edit role dialog ──────────────────────────────── -->
    <q-dialog v-model="editOpen" persistent>
      <q-card style="min-width: 640px; max-width: 92vw; max-height: 88vh;" class="column no-wrap">
        <q-toolbar class="app-toolbar">
          <q-icon :name="editing?.id ? 'edit' : 'add'" class="q-mr-sm" />
          <q-toolbar-title>{{ editing?.id ? "Edit custom role" : "New custom role" }}</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section class="col scroll">
          <q-input
            v-model="form.name"
            label="Name *" dense outlined
            hint="Letters, digits, spaces, dots, dashes, underscores. Up to 60 chars."
            class="q-mb-sm"
          />
          <q-input
            v-model="form.description"
            label="Description" type="textarea" autogrow
            dense outlined
            class="q-mb-md"
          />

          <div class="text-subtitle2 q-mb-xs">Permissions</div>
          <div class="text-caption text-grey-7 q-mb-md">
            Pick the permissions this role grants. Each is additive on
            top of the user's built-in role. Workspace-level perms
            (workspace.*, plugin.install, etc.) only do anything for
            grants made at workspace scope.
          </div>

          <q-input
            v-model="permFilter"
            label="Filter" dense outlined clearable
            class="q-mb-sm"
            debounce="100"
          >
            <template v-slot:prepend><q-icon name="search" /></template>
          </q-input>

          <div v-for="g in filteredCatalog" :key="g.group" class="q-mb-sm">
            <div class="text-caption text-grey-8 q-mb-xs perm-group">{{ g.group }}</div>
            <div class="row q-col-gutter-x-sm q-col-gutter-y-xs">
              <div v-for="p in g.perms" :key="p.name" class="col-6">
                <q-checkbox
                  :model-value="form.permissions.has(p.name)"
                  @update:model-value="(v) => togglePerm(p.name, v)"
                  dense
                >
                  <div>
                    <code class="perm-name">{{ p.name }}</code>
                    <div class="text-caption text-grey-7">{{ p.description }}</div>
                  </div>
                </q-checkbox>
              </div>
            </div>
          </div>
        </q-card-section>
        <q-separator />
        <q-card-actions align="right" class="q-pa-md">
          <div class="text-caption text-grey-7 q-mr-md">
            {{ form.permissions.size }} permission(s) selected
          </div>
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn
            unelevated color="primary" no-caps
            :label="editing?.id ? 'Save' : 'Create'"
            :loading="saving"
            @click="onSave"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Grants dialog ─────────────────────────────────────────── -->
    <q-dialog v-model="grantsOpen" position="right" full-height>
      <q-card style="width: 540px; max-width: 92vw;" class="column no-wrap">
        <q-toolbar class="app-toolbar">
          <q-icon name="group" class="q-mr-sm" />
          <q-toolbar-title>Grants — {{ grantsFor?.name }}</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />

        <q-card-section>
          <q-list bordered separator dense>
            <q-item v-for="g in grants" :key="g.id">
              <q-item-section>
                <q-item-label>{{ g.user_display_name || g.user_email }}</q-item-label>
                <q-item-label caption>
                  at {{ g.scope_type }} <b>{{ g.scope_name }}</b>
                  · granted {{ relativeTime(g.created_at) }}
                  <span v-if="g.granted_by_email"> by {{ g.granted_by_email }}</span>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-btn flat dense size="sm" icon="remove_circle" color="negative"
                       @click="onRevoke(g)">
                  <q-tooltip>Revoke this grant</q-tooltip>
                </q-btn>
              </q-item-section>
            </q-item>
            <q-item v-if="grants.length === 0" dense>
              <q-item-section>
                <q-item-label class="text-grey-7">No one's been granted this role yet.</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>

        <q-separator />
        <q-card-section>
          <div class="text-caption text-grey-7 q-mb-sm">Grant to user</div>
          <q-select
            v-model="grantUserId"
            :options="workspaceUsers"
            option-label="email" option-value="id"
            emit-value map-options dense outlined
            label="User"
            class="q-mb-sm"
          />
          <q-select
            v-model="grantScopeType"
            :options="['workspace', 'project']"
            dense outlined label="Scope"
            class="q-mb-sm"
          />
          <q-select
            v-if="grantScopeType === 'project'"
            v-model="grantScopeId"
            :options="projectOptions"
            option-label="label" option-value="value"
            emit-value map-options dense outlined
            label="Project"
            class="q-mb-sm"
          />
          <div class="row justify-end">
            <q-btn
              unelevated color="primary" no-caps icon="add"
              label="Grant"
              :disable="!grantUserId || (grantScopeType === 'project' && !grantScopeId)"
              @click="onAddGrant"
            />
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { CustomRoles, Workspaces, Projects } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const loading   = ref(false);
const loadError = ref("");
const catalog   = ref([]);

const columns = [
  { name: "name", label: "Name", field: "name", align: "left", sortable: true },
  { name: "description", label: "Description", field: "description", align: "left" },
  { name: "permissions", label: "Permissions", field: "permissions", align: "left" },
  { name: "grant_count", label: "Grants", field: "grant_count", align: "right", style: "width: 80px;" },
  { name: "actions", label: "", align: "right", style: "width: 150px;" },
];

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    rows.value = await CustomRoles.list();
    // Catalog is small + stable — fetch once and keep.
    if (catalog.value.length === 0) {
      catalog.value = await CustomRoles.catalog();
    }
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

// ── Create / edit ─────────────────────────────────────────────
const editOpen   = ref(false);
const editing    = ref(null);
const saving     = ref(false);
const permFilter = ref("");
const form       = ref({ name: "", description: "", permissions: new Set() });

function openCreate() {
  editing.value = null;
  form.value = { name: "", description: "", permissions: new Set() };
  permFilter.value = "";
  editOpen.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = {
    name: row.name,
    description: row.description || "",
    permissions: new Set(Array.isArray(row.permissions) ? row.permissions : []),
  };
  permFilter.value = "";
  editOpen.value = true;
}

function togglePerm(name, on) {
  // Set is reactive in Vue 3 only if reassigned; clone-then-mutate.
  const next = new Set(form.value.permissions);
  if (on) next.add(name); else next.delete(name);
  form.value.permissions = next;
}

// Permission catalog grouped by family. Filter narrows by name OR
// description so users can search "delete" and find everything.
const filteredCatalog = computed(() => {
  const q = (permFilter.value || "").trim().toLowerCase();
  const byGroup = new Map();
  for (const p of catalog.value) {
    if (q && !p.name.toLowerCase().includes(q)
         && !(p.description || "").toLowerCase().includes(q)) continue;
    const g = p.group || "Other";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  return [...byGroup.entries()].map(([group, perms]) => ({ group, perms }));
});

async function onSave() {
  if (!form.value.name?.trim()) {
    $q.notify({ type: "negative", message: "name required", position: "bottom" });
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name:        form.value.name.trim(),
      description: form.value.description,
      permissions: [...form.value.permissions],
    };
    if (editing.value?.id) {
      await CustomRoles.update(editing.value.id, payload);
    } else {
      await CustomRoles.create(payload);
    }
    editOpen.value = false;
    await reload();
    $q.notify({ type: "positive", message: "Saved", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  } finally {
    saving.value = false;
  }
}

async function onDelete(row) {
  const ok = await confirm(
    "Delete custom role?",
    `"${row.name}" will be removed and all ${row.grant_count} grant(s) of it revoked. This cannot be undone.`,
  );
  if (!ok) return;
  try {
    await CustomRoles.remove(row.id);
    await reload();
    $q.notify({ type: "positive", message: "Deleted", position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Grants dialog ─────────────────────────────────────────────
const grantsOpen      = ref(false);
const grantsFor       = ref(null);
const grants          = ref([]);
const workspaceUsers  = ref([]);
const projectsList    = ref([]);
const grantUserId     = ref(null);
const grantScopeType  = ref("project");
const grantScopeId    = ref(null);

const projectOptions = computed(() =>
  projectsList.value.map(p => ({ value: p.id, label: p.name })),
);

async function openGrants(row) {
  grantsFor.value = row;
  grants.value = [];
  grantUserId.value   = null;
  grantScopeType.value = "project";
  grantScopeId.value  = null;
  grantsOpen.value = true;
  try {
    grants.value = await CustomRoles.grants(row.id);
    workspaceUsers.value = await Workspaces.members(auth.user.workspaceId);
    const data = await Projects.list();
    projectsList.value = (data.projects || []).filter(p => !p.deleted_at);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

async function onAddGrant() {
  if (!grantsFor.value || !grantUserId.value) return;
  const scopeId = grantScopeType.value === "workspace"
    ? auth.user.workspaceId
    : grantScopeId.value;
  try {
    await CustomRoles.grant(grantsFor.value.id, {
      userId:    grantUserId.value,
      scopeType: grantScopeType.value,
      scopeId,
    });
    grants.value = await CustomRoles.grants(grantsFor.value.id);
    await reload();   // refresh grant_count
    grantUserId.value = null;
    grantScopeId.value = null;
    $q.notify({ type: "positive", message: "Granted", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

async function onRevoke(g) {
  const ok = await confirm("Revoke grant?", `Revoke "${grantsFor.value.name}" from ${g.user_email}?`);
  if (!ok) return;
  try {
    await CustomRoles.revoke(grantsFor.value.id, g.id);
    grants.value = await CustomRoles.grants(grantsFor.value.id);
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Helpers ───────────────────────────────────────────────────
function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function confirm(title, message) {
  return new Promise((resolve) => {
    $q.dialog({
      title, message, persistent: true,
      ok:     { label: "Confirm", color: "negative", unelevated: true, "no-caps": true },
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
.perm-group {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.perm-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  background: rgba(0,0,0,0.05);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
