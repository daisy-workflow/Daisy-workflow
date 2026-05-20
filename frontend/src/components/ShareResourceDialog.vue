<!--
  Per-resource sharing dialog. Reusable across resource types —
  workflow, config, agent — by changing the `resource-type` prop. The
  page that hosts the resource opens this with `:open`, passes the
  resource id + a friendly name for the header.

  RBAC v2 semantics:
    • Grants here are ADDITIVE on top of the user's existing role +
      custom roles. There are no deny rules.
    • The set of permissions you can grant is constrained by the
      resource type (workflow → workflow.*; config → config.*; etc.) —
      enforced server-side; this UI mirrors the rule to avoid round
      trips.
    • Grants are stored in resource_grants and consumed by the
      permission resolver when the route under guard passes
      `{ resourceType, resourceIdFrom }` to requirePermission.

  Principals: users in the workspace + service accounts in the active
  project. SAs only — sharing across projects isn't a thing for the
  resource-level grant model; cross-project use goes through
  workspace.fire grants.
-->
<template>
  <q-dialog
    :model-value="open"
    @update:model-value="(v) => emit('update:open', v)"
    position="right" full-height
  >
    <q-card style="width: 540px; max-width: 92vw;" class="column no-wrap">
      <q-toolbar class="app-toolbar">
        <q-icon name="share" class="q-mr-sm" />
        <q-toolbar-title>Share — {{ resourceName || resourceId }}</q-toolbar-title>
        <q-btn flat round dense icon="close" v-close-popup />
      </q-toolbar>
      <q-separator />

      <q-card-section>
        <q-banner class="bg-blue-1 text-blue-9 q-mb-md">
          <template v-slot:avatar><q-icon name="info" /></template>
          Sharing here adds extra permissions on this single
          <b>{{ resourceType }}</b>. Other resources are unaffected.
        </q-banner>
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div class="row items-center q-mb-sm">
          <div class="text-subtitle2">Existing grants</div>
          <q-space />
          <q-btn flat dense size="sm" icon="refresh" @click="loadGrants">
            <q-tooltip>Refresh</q-tooltip>
          </q-btn>
        </div>
        <q-list bordered separator dense>
          <q-item v-for="g in grants" :key="g.id">
            <q-item-section>
              <q-item-label>
                {{ g.principal_label || g.principal_id }}
                <q-chip
                  v-if="g.principal_type === 'service_account'"
                  dense square size="10px" color="teal" text-color="white"
                  class="q-ml-xs"
                >SA</q-chip>
              </q-item-label>
              <q-item-label caption v-if="g.principal_email">
                {{ g.principal_email }}
              </q-item-label>
              <q-item-label caption>
                <q-chip
                  v-for="p in g.permissions" :key="p"
                  dense square size="10px" color="grey-3" text-color="grey-9"
                  class="q-mr-xs"
                >{{ p }}</q-chip>
              </q-item-label>
              <q-item-label caption>
                granted {{ relativeTime(g.created_at) }}
                <span v-if="g.granted_by_email"> by {{ g.granted_by_email }}</span>
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn flat dense size="sm" icon="edit" @click="openEdit(g)">
                <q-tooltip>Change permissions</q-tooltip>
              </q-btn>
              <q-btn flat dense size="sm" icon="remove_circle" color="negative"
                     @click="onRevoke(g)">
                <q-tooltip>Revoke</q-tooltip>
              </q-btn>
            </q-item-section>
          </q-item>
          <q-item v-if="grants.length === 0" dense>
            <q-item-section>
              <q-item-label class="text-grey-7">No grants yet. Use the form below.</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div class="text-subtitle2 q-mb-sm">
          {{ editing ? "Change permissions" : "Add grant" }}
        </div>

        <template v-if="!editing">
          <q-select
            v-model="form.principalType"
            :options="['user', 'service_account']"
            label="Principal type"
            emit-value map-options dense outlined
            class="q-mb-sm"
          />
          <q-select
            v-if="form.principalType === 'user'"
            v-model="form.principalId"
            :options="userOptions"
            option-label="label" option-value="value"
            emit-value map-options dense outlined
            label="User"
            class="q-mb-sm"
          />
          <q-select
            v-else
            v-model="form.principalId"
            :options="saOptions"
            option-label="label" option-value="value"
            emit-value map-options dense outlined
            label="Service account"
            class="q-mb-sm"
          />
        </template>

        <div class="text-caption text-grey-7 q-mb-xs">Permissions</div>
        <div class="row q-col-gutter-x-sm q-col-gutter-y-xs q-mb-md">
          <div v-for="p in grantablePerms" :key="p.name" class="col-12">
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

        <div class="row justify-end">
          <q-btn
            v-if="editing"
            flat no-caps label="Cancel"
            class="q-mr-sm"
            @click="cancelEdit"
          />
          <q-btn
            unelevated color="primary" no-caps
            :icon="editing ? 'check' : 'add'"
            :label="editing ? 'Save' : 'Grant'"
            :disable="!canSubmit"
            :loading="saving"
            @click="onSubmit"
          />
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import {
  ResourceGrants, Workspaces, ServiceAccounts, CustomRoles,
} from "../api/client.js";

const props = defineProps({
  open:         { type: Boolean, required: true },
  resourceType: { type: String,  required: true },   // 'workflow' | 'config' | 'agent'
  resourceId:   { type: String,  required: true },
  resourceName: { type: String,  default: "" },
});
const emit = defineEmits(["update:open"]);

const $q = useQuasar();

const grants    = ref([]);
const users     = ref([]);
const sas       = ref([]);
const catalog   = ref([]);
const saving    = ref(false);
const editing   = ref(null);     // grant row being edited; null = creating

const form = ref({
  principalType: "user",
  principalId:   null,
  permissions:   new Set(),
});

// Refresh contents every time the dialog opens for a new resource.
// Watching `open` keeps the dialog data fresh even when the parent
// keeps the component mounted across openings.
watch(
  () => [props.open, props.resourceType, props.resourceId],
  async ([open]) => {
    if (!open) return;
    editing.value = null;
    form.value = { principalType: "user", principalId: null, permissions: new Set() };
    await loadAll();
  },
  { immediate: true },
);

async function loadAll() {
  await Promise.all([
    loadGrants(),
    loadUsers(),
    loadServiceAccounts(),
    loadCatalog(),
  ]);
}

async function loadGrants() {
  try {
    grants.value = await ResourceGrants.list(props.resourceType, props.resourceId);
  } catch (e) {
    $q.notify({ type: "negative", message: `Grants load failed: ${err(e)}`, position: "bottom" });
  }
}

async function loadUsers() {
  try {
    users.value = await Workspaces.members(auth.user?.workspaceId);
  } catch { users.value = []; }
}

async function loadServiceAccounts() {
  try {
    sas.value = await ServiceAccounts.list();
  } catch { sas.value = []; }
}

async function loadCatalog() {
  // Catalog is small + stable. We don't need workspace-admin perms to
  // see it — every user with `custom_role.read` (built-in admin) does.
  // Failing here just leaves the picker empty; the user can refresh.
  if (catalog.value.length) return;
  try { catalog.value = await CustomRoles.catalog(); }
  catch { catalog.value = []; }
}

// The permissions this dialog can grant. Constrained by resource
// type so the UI doesn't offer config.* on a workflow share, etc.
// Mirrors the server-side guard in api/resourceGrants.js — keeping
// the two in lockstep avoids a friendly UI offering perms the
// backend will then reject.
const grantablePerms = computed(() => {
  return catalog.value.filter(p => {
    const fam = p.name.split(".")[0];
    if (fam === "execution") return true;             // executions tag along
    if (fam !== props.resourceType) return false;
    // Family-matching perms only — and only the resource-grantable
    // subset (drops .reveal_secret etc. when not applicable).
    if (p.name.endsWith(".share_workspace")) return false;
    if (p.name.endsWith(".create"))         return false;   // share doesn't grant create
    return true;
  });
});

const userOptions = computed(() =>
  users.value.map(u => ({
    value: u.id,
    label: (u.display_name || u.email) + (u.email && u.display_name ? ` — ${u.email}` : ""),
  })),
);

const saOptions = computed(() =>
  sas.value.map(s => ({ value: s.id, label: s.name + (s.description ? ` — ${s.description}` : "") })),
);

const canSubmit = computed(() => {
  if (form.value.permissions.size === 0) return false;
  if (!editing.value && !form.value.principalId) return false;
  return true;
});

function togglePerm(name, on) {
  const next = new Set(form.value.permissions);
  if (on) next.add(name); else next.delete(name);
  form.value.permissions = next;
}

function openEdit(g) {
  editing.value = g;
  form.value = {
    principalType: g.principal_type,
    principalId:   g.principal_id,
    permissions:   new Set(g.permissions || []),
  };
}

function cancelEdit() {
  editing.value = null;
  form.value = { principalType: "user", principalId: null, permissions: new Set() };
}

async function onSubmit() {
  saving.value = true;
  try {
    const perms = [...form.value.permissions];
    if (editing.value) {
      await ResourceGrants.update(editing.value.id, perms);
      $q.notify({ type: "positive", message: "Grant updated", timeout: 1200, position: "bottom" });
    } else {
      await ResourceGrants.create({
        resourceType:  props.resourceType,
        resourceId:    props.resourceId,
        principalType: form.value.principalType,
        principalId:   form.value.principalId,
        permissions:   perms,
      });
      $q.notify({ type: "positive", message: "Granted", timeout: 1200, position: "bottom" });
    }
    cancelEdit();
    await loadGrants();
  } catch (e) {
    $q.notify({ type: "negative", message: err(e), position: "bottom" });
  } finally {
    saving.value = false;
  }
}

async function onRevoke(g) {
  $q.dialog({
    title: "Revoke grant?",
    message: `Remove access from ${g.principal_label || g.principal_id}? This cannot be undone.`,
    persistent: true,
    ok:     { label: "Revoke", color: "negative", unelevated: true, "no-caps": true },
    cancel: { label: "Cancel", flat: true, "no-caps": true },
  }).onOk(async () => {
    try {
      await ResourceGrants.remove(g.id);
      await loadGrants();
    } catch (e) {
      $q.notify({ type: "negative", message: err(e), position: "bottom" });
    }
  });
}

function err(e) {
  return e?.response?.data?.message || e.message || "request failed";
}

function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
</script>

<style scoped>
.perm-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  background: rgba(0,0,0,0.05);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
