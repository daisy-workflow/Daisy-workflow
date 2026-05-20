<!--
  Service Accounts admin — project-scoped machine identities.

  This page lives at /service-accounts. Project admins (and workspace
  admins, who inherit) can create service accounts, issue API keys
  bound to them, and revoke either at any time.

  Critical UX moment: when a new key is issued, the plaintext token is
  shown EXACTLY ONCE in a modal. The user must copy it before
  dismissing — the server never sees it again and we have no way to
  recover it. The modal is designed to make that obvious.
-->
<template>
  <div class="page q-pa-md sa-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Service accounts</div>
        <div class="text-caption text-grey-7">
          Machine identities for CI / automation. Each service account
          carries one role within the current project and authenticates
          with one or more API keys.
        </div>
      </div>
      <q-space />
      <q-btn
        color="primary" unelevated no-caps icon="add" label="New service account"
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
        <q-btn icon="refresh" flat dense size="sm" @click="reload" />
      </template>

      <template v-slot:body-cell-name="props">
        <q-td :props="props">
          <span class="text-primary cursor-pointer" @click="openKeys(props.row)">
            {{ props.row.name }}
          </span>
          <q-chip
            v-if="props.row.status === 'disabled'"
            dense square size="11px" color="grey-6" text-color="white"
            class="q-ml-xs"
          >disabled</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-role="props">
        <q-td :props="props">
          <q-chip dense square size="11px" :color="roleColor(props.row.role)" text-color="white">
            {{ props.row.role }}
          </q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-last_used="props">
        <q-td :props="props">
          <template v-if="props.row.last_used_at">
            <q-tooltip>{{ new Date(props.row.last_used_at).toLocaleString() }}</q-tooltip>
            <span>{{ relativeTime(props.row.last_used_at) }}</span>
          </template>
          <span v-else class="text-grey-5">never</span>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-btn flat dense size="sm" icon="vpn_key" @click="openKeys(props.row)">
            <q-tooltip>Manage keys</q-tooltip>
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

    <!-- Create / edit dialog ─────────────────────────────────── -->
    <q-dialog v-model="editOpen" persistent>
      <q-card style="min-width: 460px; max-width: 90vw;">
        <q-toolbar class="app-toolbar">
          <q-icon :name="editing?.id ? 'edit' : 'add'" class="q-mr-sm" />
          <q-toolbar-title>
            {{ editing?.id ? "Edit service account" : "New service account" }}
          </q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input
            v-model="form.name"
            label="Name *" dense outlined
            hint="Letters, digits, dot, dash, underscore. Max 64 chars."
            class="q-mb-sm"
          />
          <q-input
            v-model="form.description"
            label="Description" type="textarea" autogrow
            dense outlined
            class="q-mb-sm"
          />
          <q-select
            v-model="form.role"
            :options="['admin', 'editor', 'viewer']"
            label="Role within this project *"
            dense outlined
            class="q-mb-sm"
          />
          <q-select
            v-if="editing?.id"
            v-model="form.status"
            :options="['active', 'disabled']"
            label="Status"
            dense outlined
            hint="Disabled service accounts can't authenticate. Keys are preserved."
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

    <!-- Keys dialog ────────────────────────────────────────────── -->
    <q-dialog v-model="keysOpen" position="right" full-height>
      <q-card style="width: 540px; max-width: 92vw;" class="column no-wrap">
        <q-toolbar class="app-toolbar">
          <q-icon name="vpn_key" class="q-mr-sm" />
          <q-toolbar-title>API keys — {{ keysFor?.name }}</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />

        <q-card-section>
          <q-banner class="bg-blue-1 text-blue-9 q-mb-md">
            <template v-slot:avatar><q-icon name="info" /></template>
            Each key authenticates as <b>{{ keysFor?.name }}</b> with
            role <b>{{ keysFor?.role }}</b> in this project.
            Treat keys like passwords — never commit them to source control.
          </q-banner>
        </q-card-section>

        <q-separator />

        <q-card-section>
          <div class="row items-center q-mb-sm">
            <div class="text-subtitle2">Active keys</div>
            <q-space />
            <q-btn
              unelevated color="primary" no-caps icon="add" label="Issue key"
              size="sm"
              :disable="keysFor?.status !== 'active'"
              @click="openIssueKey"
            />
          </div>
          <q-list bordered separator dense>
            <q-item v-for="k in keys" :key="k.id">
              <q-item-section>
                <q-item-label>
                  <code class="key-prefix">{{ k.prefix }}…</code>
                  <q-chip
                    v-if="k.revoked_at"
                    dense square size="10px" color="negative" text-color="white"
                    class="q-ml-xs"
                  >revoked</q-chip>
                  <q-chip
                    v-else-if="k.expires_at && new Date(k.expires_at) < new Date()"
                    dense square size="10px" color="warning" text-color="white"
                    class="q-ml-xs"
                  >expired</q-chip>
                </q-item-label>
                <q-item-label caption>
                  {{ k.description || "—" }}
                </q-item-label>
                <q-item-label caption>
                  Last used:
                  <span v-if="k.last_used_at">
                    {{ relativeTime(k.last_used_at) }}
                    <span v-if="k.last_used_ip" class="q-ml-sm">from {{ k.last_used_ip }}</span>
                  </span>
                  <span v-else>never</span>
                </q-item-label>
                <q-item-label caption v-if="k.expires_at">
                  Expires: {{ new Date(k.expires_at).toLocaleDateString() }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-btn
                  v-if="!k.revoked_at"
                  flat dense size="sm" icon="block" color="negative"
                  @click="onRevokeKey(k)"
                >
                  <q-tooltip>Revoke this key</q-tooltip>
                </q-btn>
              </q-item-section>
            </q-item>
            <q-item v-if="keys.length === 0" dense>
              <q-item-section>
                <q-item-label class="text-grey-7">No keys yet. Issue one to start using this service account.</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </q-dialog>

    <!-- Issue-key dialog ───────────────────────────────────────── -->
    <q-dialog v-model="issueOpen" persistent>
      <q-card style="min-width: 460px; max-width: 90vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="add_circle" class="q-mr-sm" />
          <q-toolbar-title>Issue API key</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input
            v-model="issueForm.description"
            label="Description (optional)" dense outlined
            hint="e.g. 'CI publish pipeline'"
            class="q-mb-sm"
          />
          <q-input
            v-model="issueForm.expiresAt"
            label="Expires (optional)" type="date" dense outlined
            hint="ISO-8601 date. Empty = no expiry."
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn
            unelevated color="primary" no-caps label="Issue"
            :loading="issuing"
            @click="onIssueKey"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Show-once dialog ───────────────────────────────────────── -->
    <q-dialog v-model="showOnceOpen" persistent>
      <q-card style="min-width: 520px; max-width: 92vw;">
        <q-toolbar class="bg-warning text-black">
          <q-icon name="warning" class="q-mr-sm" />
          <q-toolbar-title>Copy this key now</q-toolbar-title>
        </q-toolbar>
        <q-card-section>
          <p class="q-mb-md">
            This is the only time the full key will be shown. After you close
            this dialog, the server has no way to retrieve it. If you lose it,
            you'll need to issue a new one and revoke this one.
          </p>
          <q-input
            v-model="showOnceToken"
            readonly outlined
            class="q-mb-sm"
            type="textarea"
            autogrow
            style="font-family: ui-monospace, monospace; font-size: 12px;"
          />
          <q-btn
            unelevated color="primary" no-caps icon="content_copy"
            label="Copy to clipboard"
            @click="copyToken"
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn
            unelevated color="primary" no-caps
            label="I've copied it — close"
            @click="dismissShowOnce"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { ServiceAccounts } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const loading   = ref(false);
const loadError = ref("");

const columns = [
  { name: "name",      label: "Name",        field: "name", align: "left", sortable: true },
  { name: "role",      label: "Role",        field: "role", align: "left", style: "width: 90px;" },
  { name: "description", label: "Description", field: "description", align: "left" },
  { name: "active_key_count", label: "Keys", field: "active_key_count", align: "right", style: "width: 70px;" },
  { name: "last_used", label: "Last used",   align: "left", style: "width: 140px;" },
  { name: "actions",   label: "",            align: "right", style: "width: 140px;" },
];

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    rows.value = await ServiceAccounts.list();
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message || "load failed";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  // Page requires an active project. If we don't have one yet (fresh
  // login, deep-linked URL, just cleared localStorage), have the auth
  // store pick a default before bouncing. Only fall back to home when
  // the user truly has no projects — which shouldn't happen because
  // the migration seeds a Default per workspace.
  if (!auth.activeProjectId) {
    const picked = await auth.ensureActiveProject();
    if (!picked) {
      router.replace({ name: "home" });
      return;
    }
  }
  await reload();
});

// ── Create / edit ───────────────────────────────────────────
const editOpen = ref(false);
const editing  = ref(null);
const saving   = ref(false);
const form     = ref({ name: "", description: "", role: "editor", status: "active" });

function openCreate() {
  editing.value = null;
  form.value = { name: "", description: "", role: "editor", status: "active" };
  editOpen.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = {
    name:        row.name,
    description: row.description || "",
    role:        row.role,
    status:      row.status,
  };
  editOpen.value = true;
}

async function onSave() {
  saving.value = true;
  try {
    if (editing.value?.id) {
      await ServiceAccounts.update(editing.value.id, {
        name:        form.value.name,
        description: form.value.description,
        role:        form.value.role,
        status:      form.value.status,
      });
      $q.notify({ type: "positive", message: "Saved", timeout: 1200, position: "bottom" });
    } else {
      await ServiceAccounts.create({
        name:        form.value.name,
        description: form.value.description,
        role:        form.value.role,
      });
      $q.notify({ type: "positive", message: "Service account created", timeout: 1200, position: "bottom" });
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
    "Delete service account?",
    `"${row.name}" will be disabled immediately. All ${row.active_key_count} active key(s) will stop working. This cannot be undone.`,
  );
  if (!ok) return;
  try {
    await ServiceAccounts.remove(row.id);
    $q.notify({ type: "positive", message: "Deleted", position: "bottom" });
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Keys ────────────────────────────────────────────────────
const keysOpen = ref(false);
const keysFor  = ref(null);
const keys     = ref([]);

async function openKeys(row) {
  keysFor.value = row;
  keys.value = [];
  keysOpen.value = true;
  try { keys.value = await ServiceAccounts.keys(row.id); }
  catch (e) {
    $q.notify({ type: "negative", message: `Keys load failed: ${e?.response?.data?.message || e.message}`, position: "bottom" });
  }
}

async function onRevokeKey(k) {
  const ok = await confirm("Revoke API key?", `Key ${k.prefix}… will stop working immediately. Existing requests using it will fail. This cannot be undone.`);
  if (!ok) return;
  try {
    await ServiceAccounts.revokeKey(keysFor.value.id, k.id);
    keys.value = await ServiceAccounts.keys(keysFor.value.id);
    await reload();    // refresh active-key counts in the list behind
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Issue key + show-once ───────────────────────────────────
const issueOpen   = ref(false);
const issuing     = ref(false);
const issueForm   = ref({ description: "", expiresAt: "" });
const showOnceOpen  = ref(false);
const showOnceToken = ref("");

function openIssueKey() {
  issueForm.value = { description: "", expiresAt: "" };
  issueOpen.value = true;
}

async function onIssueKey() {
  if (!keysFor.value) return;
  issuing.value = true;
  try {
    const body = { description: issueForm.value.description };
    if (issueForm.value.expiresAt) {
      // Convert YYYY-MM-DD → end-of-day ISO so a date picker behaves intuitively.
      body.expiresAt = new Date(`${issueForm.value.expiresAt}T23:59:59`).toISOString();
    }
    const res = await ServiceAccounts.createKey(keysFor.value.id, body);
    issueOpen.value = false;
    // Show the raw token in the show-once dialog. Once dismissed it's gone.
    showOnceToken.value = res.token;
    showOnceOpen.value = true;
    // Re-list keys so the new one shows up after the user dismisses.
    keys.value = await ServiceAccounts.keys(keysFor.value.id);
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  } finally {
    issuing.value = false;
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(showOnceToken.value);
    $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: `Copy failed: ${e.message}`, position: "bottom" });
  }
}

function dismissShowOnce() {
  // Wipe the token from memory before closing — a small belt-and-braces
  // measure so a paused tab doesn't keep it lying around in Vue state.
  showOnceToken.value = "";
  showOnceOpen.value = false;
}

// ── Helpers ─────────────────────────────────────────────────
function roleColor(r) {
  return r === "admin" ? "primary" : r === "editor" ? "teal" : "grey-7";
}

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
/* Padding handled by q-pa-md on the root div — matches UsersPage. */
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.key-prefix {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
</style>
