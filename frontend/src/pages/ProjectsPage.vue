<!--
  Projects admin page — workspace-admin only.

  RBAC v2 Phase 2. Lets a workspace admin:
    • See every project in the workspace (active + soft-deleted)
    • Create new projects
    • Rename / edit metadata
    • Soft-delete (with restore window) and restore
    • Manage member roles per project

  Membership management for a single project sits in a side dialog
  to keep the page focused. The dialog reuses the same role choices
  (admin / editor / viewer) the existing Workspace Members admin uses,
  so the affordance is familiar.
-->
<template>
  <div class="page q-pa-md projects-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Projects</div>
        <div class="text-caption text-grey-7">
          Team-isolation units within this workspace. Each project owns its
          workflows, triggers, configs, agents, executions, and members.
        </div>
      </div>
      <q-space />
      <q-btn
        color="primary" unelevated no-caps icon="add" label="New project"
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
      <template v-slot:top-right>
        <q-toggle
          v-model="includeDeleted"
          label="Show deleted"
          dense color="primary"
          @update:model-value="reload"
        />
        <q-btn icon="refresh" flat dense size="sm" class="q-ml-sm" @click="reload" />
      </template>

      <template v-slot:body-cell-name="props">
        <q-td :props="props">
          <span class="text-primary cursor-pointer" @click="openEdit(props.row)">
            {{ props.row.name }}
          </span>
          <q-chip
            v-if="props.row.deleted_at"
            dense square size="11px" color="negative" text-color="white"
            class="q-ml-xs"
          >deleted</q-chip>
          <q-chip
            v-else-if="props.row.status === 'archived'"
            dense square size="11px" color="grey-6" text-color="white"
            class="q-ml-xs"
          >archived</q-chip>
          <q-chip
            v-else-if="props.row.slug === 'default'"
            dense square size="11px" color="primary" text-color="white"
            class="q-ml-xs"
          >default</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-slug="props">
        <q-td :props="props">
          <code class="slug">{{ props.row.slug }}</code>
        </q-td>
      </template>

      <template v-slot:body-cell-purge="props">
        <q-td :props="props">
          <template v-if="props.row.purge_at">
            <q-tooltip>{{ new Date(props.row.purge_at).toLocaleString() }}</q-tooltip>
            <span>in {{ relativeDays(props.row.purge_at) }}</span>
          </template>
          <span v-else class="text-grey-5">—</span>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-btn
            v-if="!props.row.deleted_at"
            flat dense size="sm" icon="people"
            @click="openMembers(props.row)"
          >
            <q-tooltip>Manage members</q-tooltip>
          </q-btn>
          <q-btn
            v-if="!props.row.deleted_at"
            flat dense size="sm" icon="edit"
            @click="openEdit(props.row)"
          >
            <q-tooltip>Edit</q-tooltip>
          </q-btn>
          <q-btn
            v-if="!props.row.deleted_at && props.row.slug !== 'default'"
            flat dense size="sm" icon="delete" color="negative"
            @click="onDelete(props.row)"
          >
            <q-tooltip>Delete</q-tooltip>
          </q-btn>
          <q-btn
            v-if="props.row.deleted_at"
            flat dense size="sm" icon="restore"
            @click="onRestore(props.row)"
          >
            <q-tooltip>Restore</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <!-- Create / edit dialog ─────────────────────────────────── -->
    <q-dialog v-model="editOpen" persistent>
      <q-card style="min-width: 460px; max-width: 90vw;">
        <q-toolbar class="app-toolbar">
          <q-icon :name="editing?.id ? 'edit' : 'add'" class="q-mr-sm" />
          <q-toolbar-title>{{ editing?.id ? "Edit project" : "New project" }}</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input
            v-model="form.name"
            label="Name *" dense outlined
            class="q-mb-sm"
          />
          <q-input
            v-if="!editing?.id"
            v-model="form.slug"
            label="Slug" hint="URL-safe identifier. Auto-derived from name when left blank."
            dense outlined
            class="q-mb-sm"
          />
          <q-input
            v-model="form.description"
            label="Description" type="textarea" autogrow
            dense outlined
            class="q-mb-sm"
          />

          <div class="text-caption text-grey-7 q-mt-md q-mb-xs">Metadata (optional)</div>
          <q-input
            v-model="form.metadata.owner"
            label="Owner" dense outlined
            class="q-mb-xs"
          />
          <q-input
            v-model="form.metadata.cost_center"
            label="Cost center" dense outlined
            class="q-mb-xs"
          />
          <q-select
            v-model="form.metadata.env"
            :options="['dev', 'staging', 'prod']"
            label="Environment"
            emit-value map-options dense outlined
            class="q-mb-xs"
          />
          <q-select
            v-model="form.metadata.classification"
            :options="['public', 'internal', 'confidential', 'restricted']"
            label="Data classification"
            emit-value map-options dense outlined
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
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

    <!-- Members dialog ─────────────────────────────────────────── -->
    <q-dialog v-model="membersOpen" position="right" full-height>
      <q-card style="width: 480px; max-width: 92vw;" class="column no-wrap">
        <q-toolbar class="app-toolbar">
          <q-icon name="people" class="q-mr-sm" />
          <q-toolbar-title>Members — {{ membersFor?.name }}</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />

        <q-card-section>
          <div class="text-caption text-grey-7 q-mb-sm">
            Workspace admins implicitly have admin in every project. Don't list them here.
          </div>
          <q-list bordered separator dense>
            <q-item v-for="m in members" :key="m.id">
              <q-item-section>
                <q-item-label>{{ m.display_name || m.email }}</q-item-label>
                <q-item-label caption>{{ m.email }}</q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-select
                  v-model="m.role"
                  :options="['admin', 'editor', 'viewer']"
                  dense outlined options-dense
                  style="width: 110px;"
                  @update:model-value="(v) => onChangeRole(m, v)"
                />
              </q-item-section>
              <q-item-section side>
                <q-btn flat dense size="sm" icon="remove_circle" color="negative"
                       @click="onRemoveMember(m)">
                  <q-tooltip>Remove from project</q-tooltip>
                </q-btn>
              </q-item-section>
            </q-item>
            <q-item v-if="members.length === 0" dense>
              <q-item-section>
                <q-item-label class="text-grey-7">No project-specific members yet.</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>

        <q-separator />
        <q-card-section>
          <div class="text-caption text-grey-7 q-mb-sm">Add member</div>
          <q-select
            v-model="addUserId"
            :options="addableUsers"
            option-label="email" option-value="id"
            emit-value map-options dense outlined
            label="User"
            class="q-mb-sm"
          />
          <q-select
            v-model="addRole"
            :options="['admin', 'editor', 'viewer']"
            dense outlined label="Role"
            class="q-mb-sm"
          />
          <div class="row justify-end">
            <q-btn
              unelevated color="primary" no-caps icon="add"
              label="Add"
              :disable="!addUserId"
              @click="onAddMember"
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
import { Projects, Workspaces } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows = ref([]);
const loading = ref(false);
const loadError = ref("");
const includeDeleted = ref(false);

const columns = [
  { name: "name",  label: "Name",        field: "name", align: "left", sortable: true },
  { name: "slug",  label: "Slug",        field: "slug", align: "left", style: "width: 160px;" },
  { name: "description", label: "Description", field: "description", align: "left" },
  {
    name: "created", label: "Created", field: "created_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleDateString() : "",
    style: "width: 120px;",
  },
  { name: "purge",   label: "Purge in", align: "left", style: "width: 110px;" },
  { name: "actions", label: "",         align: "right", style: "width: 180px;" },
];

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    const data = await Projects.list({ includeDeleted: includeDeleted.value });
    rows.value = data.projects || [];
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message || "load failed";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  // Workspace-admin only. Two layers: (a) the user's primary role on
  // the users table, (b) the cached isWorkspaceAdmin flag the auth
  // store populated at boot. Either positive admits — the second
  // catches admins whose user.role row drifted from their
  // workspace_members row. Bounce the rest.
  if (auth.user?.role !== "admin" && !auth.isWorkspaceAdmin) {
    router.replace({ name: "home" });
    return;
  }
  await reload();
});

// ── Create / edit ────────────────────────────────────────────
const editOpen = ref(false);
const editing  = ref(null);
const saving   = ref(false);
const form     = ref({ name: "", slug: "", description: "", metadata: {} });

function openCreate() {
  editing.value = null;
  form.value = { name: "", slug: "", description: "", metadata: {} };
  editOpen.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = {
    name: row.name,
    slug: row.slug,
    description: row.description || "",
    metadata: { ...(row.metadata || {}) },
  };
  editOpen.value = true;
}

async function onSave() {
  saving.value = true;
  try {
    if (editing.value?.id) {
      await Projects.update(editing.value.id, {
        name: form.value.name,
        description: form.value.description,
        metadata: form.value.metadata,
      });
      $q.notify({ type: "positive", message: "Saved", timeout: 1200, position: "bottom" });
    } else {
      await Projects.create({
        name: form.value.name,
        slug: form.value.slug || undefined,
        description: form.value.description,
        metadata: form.value.metadata,
      });
      $q.notify({ type: "positive", message: "Project created", timeout: 1200, position: "bottom" });
    }
    editOpen.value = false;
    await reload();
  } catch (e) {
    $q.notify({
      type: "negative",
      message: e?.response?.data?.message || e.message || "save failed",
      position: "bottom",
    });
  } finally {
    saving.value = false;
  }
}

async function onDelete(row) {
  const ok = await confirm(
    "Delete project?",
    `"${row.name}" will be hidden immediately. You can restore it within 30 days. After that, the project and all its workflows / triggers / configs are permanently deleted.`,
  );
  if (!ok) return;
  try {
    await Projects.remove(row.id);
    $q.notify({ type: "positive", message: "Deleted (restorable for 30 days)", position: "bottom" });
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

async function onRestore(row) {
  try {
    await Projects.restore(row.id);
    $q.notify({ type: "positive", message: "Restored", position: "bottom" });
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Members ──────────────────────────────────────────────────
const membersOpen = ref(false);
const membersFor  = ref(null);
const members     = ref([]);
const workspaceUsers = ref([]);
const addUserId   = ref(null);
const addRole     = ref("editor");

async function openMembers(row) {
  membersFor.value = row;
  members.value = [];
  membersOpen.value = true;
  try {
    members.value = await Projects.members(row.id);
    // Pull workspace members so we have a pool to add from.
    workspaceUsers.value = await Workspaces.members(auth.user.workspaceId);
  } catch (e) {
    $q.notify({ type: "negative", message: `Members load failed: ${e?.response?.data?.message || e.message}`, position: "bottom" });
  }
}

// Hide users already in the project from the "add" dropdown.
const addableUsers = computed(() => {
  const inSet = new Set(members.value.map(m => m.id));
  return (workspaceUsers.value || []).filter(u => !inSet.has(u.id));
});

async function onAddMember() {
  if (!addUserId.value || !membersFor.value) return;
  try {
    await Projects.addMember(membersFor.value.id, addUserId.value, addRole.value);
    addUserId.value = null;
    members.value = await Projects.members(membersFor.value.id);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

async function onChangeRole(m, newRole) {
  try {
    await Projects.updateMember(membersFor.value.id, m.id, newRole);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
    // Revert UI by reloading.
    members.value = await Projects.members(membersFor.value.id);
  }
}

async function onRemoveMember(m) {
  const ok = await confirm("Remove member?", `Remove ${m.email} from "${membersFor.value.name}"?`);
  if (!ok) return;
  try {
    await Projects.removeMember(membersFor.value.id, m.id);
    members.value = await Projects.members(membersFor.value.id);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Helpers ──────────────────────────────────────────────────
function relativeDays(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const d  = Math.max(0, Math.round(ms / (24 * 3600 * 1000)));
  return d === 0 ? "today" : `${d}d`;
}

function confirm(title, message) {
  return new Promise((resolve) => {
    $q.dialog({
      title, message, persistent: true,
      ok:     { label: "Confirm", color: "primary", unelevated: true, "no-caps": true },
      cancel: { label: "Cancel",  flat: true, "no-caps": true },
    }).onOk(() => resolve(true)).onDismiss(() => resolve(false));
  });
}
</script>

<style scoped>
/* `.page` base styles come from styles.css; this file just tunes
   the projects-page header layout. The earlier `padding: 18px 22px`
   collided with the q-pa-md utility class — drop it. */
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.slug {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
</style>
