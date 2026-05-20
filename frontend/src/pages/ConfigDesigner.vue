<!--
  ConfigDesigner — single-page editor for one configuration row.

  Like TriggerDesigner, the editor renders a per-type form built from the
  field schema served by the backend (GET /configs/types). The schema knows
  which fields are required, which are secret (rendered as password inputs
  and masked when editing an existing row), and what their types are. When
  the user picks the "generic" type we drop into a freeform key/value
  editor with a per-row "secret" toggle.

  Saved configs are referenced from any DSL expression as
  `${config.<name>.<key>}` — see the engine's worker.js for how ctx.config
  is wired in at execution start.
-->
<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <q-btn flat round dense icon="arrow_back" class="btn-toolbar q-mr-sm" @click="goBack">
          <q-tooltip>Back</q-tooltip>
        </q-btn>
        <q-toolbar-title>
          {{ isNew ? "New configuration" : (form.name || "Configuration") }}
          <span v-if="!isNew && form.type" class="app-subtitle">{{ typeLabel(form.type) }}</span>
          <span v-if="dirty" class="q-ml-xs text-caption" style="color: var(--warning);">●</span>
        </q-toolbar-title>
        <q-space />
        <!-- Share — per-resource ACL dialog. Disabled until the config
             has been saved at least once (no id to attach grants to).
             Workspace-shared configs are intentionally not shareable
             at resource scope; the dialog (and the backend) refuse
             that combination — sharing-of-shared is a workspace-level
             act, not a per-row one. -->
        <q-btn
          flat round dense
          icon="share"
          class="btn-icon q-mr-sm"
          :disable="isNew"
          @click="shareOpen = true"
        >
          <q-tooltip>{{
            isNew
              ? "Save the config once before sharing"
              : "Share with specific users"
          }}</q-tooltip>
        </q-btn>
        <q-btn
          unelevated
          color="primary"
          icon="save"
          class="btn-icon-primary"
          :loading="saving"
          :disable="!canSave"
          @click="onSave"
        >
          <q-tooltip>Save</q-tooltip>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="app-page">
        <q-banner v-if="loadError" dense class="bg-red-10 text-red-2">
          <template v-slot:avatar><q-icon name="error_outline" /></template>
          {{ loadError }}
        </q-banner>

        <div v-if="loading" class="row flex-center q-pa-lg">
          <q-spinner-dots color="primary" size="32px" />
        </div>

        <div v-else class="q-pa-md column q-gutter-md" style="max-width: 720px;">
          <div class="row q-col-gutter-md">
            <div class="col-7">
              <q-input class="q-pl-md"
                v-model="form.name"
                dense outlined label="Name *"
                :error="!nameOk"
                :error-message="nameError"
                hint="Reference in expressions as ${config.name.key}"
              />
            </div>
            <div class="col-5">
              <q-select
                v-model="form.type"
                :options="typeOptions"
                emit-value map-options
                dense outlined label="Type *"
                :disable="!isNew"
                :hint="isNew ? '' : 'Type is fixed after creation'"
              />
            </div>
          </div>

          <q-input
            v-model="form.description"
            dense outlined label="Description"
            type="textarea" autogrow
            input-style="min-height: 60px;"
          />

          <!-- Workspace-share toggle. Visible to workspace admins ONLY,
               and only on create. After a config is saved its sharing
               state is fixed — changing it would re-assign ownership
               between project and workspace, which we don't expose as
               a one-button action (avoids accidental cross-project
               credential leaks). -->
          <q-card
            v-if="isNew && auth.user?.role === 'admin'"
            flat bordered class="q-mb-sm"
          >
            <q-card-section class="q-pa-sm row items-center">
              <q-toggle
                v-model="form.sharedAtWorkspace"
                color="primary"
                label="Share with the whole workspace"
              />
              <q-space />
              <q-icon name="info" class="q-mr-xs text-grey-7" />
              <div class="text-caption text-grey-7">
                Shared configs are usable by every project in this workspace.
                Project-private configs override shared ones on a name collision.
              </div>
            </q-card-section>
          </q-card>

          <!-- Typed forms ──────────────────────────────────────────────── -->
          <q-card v-if="typeDef && !typeDef.freeform" flat bordered>
            <q-card-section class="q-pa-sm">
              <div class="text-caption text-grey q-mb-sm">{{ typeDef.label }}</div>
              <div v-for="f in typeDef.fields" :key="f.name" class="q-mb-xs">
                <!-- secret string — never echoes the existing value back.
                     The API masks secrets as "***" in GET responses; we
                     also strip those on load so the field is empty by
                     default. Leaving it empty on save = "keep existing
                     ciphertext" (the backend's update path preserves it). -->
                <q-input
                  v-if="f.secret"
                  :model-value="secretInputValue(f.name)"
                  @update:model-value="setField(f.name, $event)"
                  dense outlined
                  :type="passwordVisible[f.name] ? 'text' : 'password'"
                  :label="`${f.name}${f.required ? ' *' : ''}`"
                  :hint="f.description"
                  :placeholder="isNew ? '' : 'Leave blank to keep existing secret'"
                  autocomplete="new-password"
                >
                  <template v-slot:append>
                    <q-icon
                      :name="passwordVisible[f.name] ? 'visibility_off' : 'visibility'"
                      class="cursor-pointer"
                      @click="passwordVisible[f.name] = !passwordVisible[f.name]"
                    >
                      <q-tooltip>{{ passwordVisible[f.name] ? "Hide" : "Show" }}</q-tooltip>
                    </q-icon>
                  </template>
                </q-input>
                <!-- enum -->
                <q-select
                  v-else-if="f.type === 'select'"
                  :model-value="form.data[f.name]"
                  @update:model-value="setField(f.name, $event)"
                  :options="f.options"
                  dense outlined
                  :label="`${f.name}${f.required ? ' *' : ''}`"
                  :hint="f.description"
                />
                <!-- boolean -->
                <q-toggle
                  v-else-if="f.type === 'boolean'"
                  :model-value="!!form.data[f.name]"
                  @update:model-value="setField(f.name, $event)"
                  :label="f.name"
                  left-label
                  color="primary"
                />
                <!-- number -->
                <q-input
                  v-else-if="f.type === 'number'"
                  :model-value="form.data[f.name]"
                  @update:model-value="setField(f.name, $event === '' ? undefined : Number($event))"
                  type="number" dense outlined
                  :label="`${f.name}${f.required ? ' *' : ''}`"
                  :hint="f.description"
                />
                <!-- string fallback -->
                <q-input
                  v-else
                  :model-value="form.data[f.name]"
                  @update:model-value="setField(f.name, $event)"
                  dense outlined
                  :label="`${f.name}${f.required ? ' *' : ''}`"
                  :hint="f.description"
                />
              </div>
            </q-card-section>
          </q-card>

          <!-- Freeform / generic ────────────────────────────────────────── -->
          <q-card v-else-if="typeDef && typeDef.freeform" flat bordered>
            <q-card-section class="q-pa-sm">
              <div class="row items-center">
                <div class="text-caption text-grey">Key/value pairs</div>
                <q-space />
                <q-btn dense flat size="sm" no-caps icon="add" label="Field" @click="addGenericRow" />
              </div>
              <div class="text-caption text-grey q-mb-sm">
                Toggle the lock to mark a field as a secret — it will be encrypted at rest and masked
                in the API.
              </div>
              <div v-for="row in genericRows" :key="row._k" class="row q-col-gutter-xs items-center q-mb-xs">
                <div class="col-3">
                  <q-input dense outlined v-model="row.k" placeholder="key"
                           @update:model-value="syncGeneric" />
                </div>
                <div class="col-7">
                  <q-input
                    dense outlined
                    v-model="row.v"
                    :type="row.secret ? 'password' : 'text'"
                    :placeholder="row.secret && !isNew ? 'Leave blank to keep existing secret' : 'value'"
                    @update:model-value="syncGeneric"
                  />
                </div>
                <div class="col-1">
                  <q-btn dense flat round size="sm"
                         :icon="row.secret ? 'lock' : 'lock_open'"
                         :color="row.secret ? 'primary' : 'grey'"
                         @click="toggleGenericSecret(row)">
                    <q-tooltip>{{ row.secret ? "Marked as secret (encrypted)" : "Mark as secret" }}</q-tooltip>
                  </q-btn>
                </div>
                <div class="col-1 text-right">
                  <q-btn dense flat round size="sm" icon="delete" color="negative"
                         @click="removeGenericRow(row._k)" />
                </div>
              </div>
              <div v-if="!genericRows.length" class="text-caption text-grey q-pa-sm">
                No keys yet — click "Field" to add one.
              </div>
            </q-card-section>
          </q-card>
        </div>
      </q-page>
    </q-page-container>

    <!-- Per-resource sharing dialog — lazy-mounted so unsaved configs
         pay zero cost. The component does its own listing + grant
         management; we just pass identity. -->
    <ShareResourceDialog
      v-if="!isNew"
      v-model:open="shareOpen"
      resource-type="config"
      :resource-id="route.params.id"
      :resource-name="form.name"
    />
  </q-layout>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Configs } from "../api/client";
import { auth } from "../stores/auth.js";
import ShareResourceDialog from "../components/ShareResourceDialog.vue";

const route  = useRoute();
const router = useRouter();
const $q     = useQuasar();

const isNew = computed(() => route.params.id === "new" || !route.params.id);

// Open state for the per-resource share dialog. Initial close;
// toggled by the toolbar share button.
const shareOpen = ref(false);

// ── Server-side schema for all types (drives the editor). ──────────────────
const types = ref([]);
const typeOptions = computed(() =>
  types.value.map(t => ({ value: t.type, label: t.label }))
);
function typeLabel(t) {
  return types.value.find(x => x.type === t)?.label || t;
}
function findType(t) {
  return types.value.find(x => x.type === t);
}
const typeDef = computed(() => findType(form.value.type));

// ── Form state. Always-present keys; the per-type form rebinds on type change.
const form = ref({
  name: "",
  type: "generic",
  description: "",
  data: {},
  // RBAC v2: workspace-shared toggle. Only consulted on create; ignored
  // by the API on update. Default false = project-private.
  sharedAtWorkspace: false,
});

// Per-secret-field visibility toggle (eye icon next to the password input).
// Keyed by the schema field name; resets when the user picks a different
// type or loads a different config.
const passwordVisible = reactive({});

/**
 * What we hand to the password input's :model-value. The API returns
 * "***" for secret fields in GET responses; we never want that string to
 * appear in the field, otherwise the user thinks "***" IS the password.
 * If the underlying value is the mask sentinel we render an empty input
 * — the placeholder ("Leave blank to keep existing secret") explains
 * what an empty field will do on save.
 */
function secretInputValue(name) {
  const v = form.value.data?.[name];
  return v === "***" ? "" : (v ?? "");
}
const loading   = ref(true);
const saving    = ref(false);
const loadError = ref("");
const dirty     = ref(false);
let lastSavedHash = "";

// Generic rows mirror form.data when the type is "generic" — kept as an
// array of { _k, k, v, secret } so the user can edit keys without losing
// row identity in the v-for.
const genericRows = ref([]);

// ── Load --------------------------------------------------------------------
onMounted(async () => {
  try {
    types.value = await Configs.types();
  } catch (e) {
    loadError.value = errMsg(e);
  }
  if (!isNew.value) {
    try {
      const row = await Configs.get(route.params.id);
      form.value = {
        name:        row.name,
        type:        row.type,
        description: row.description || "",
        data:        { ...(row.data || {}) },
      };
      if (row.type === "generic") rebuildGenericRows();
    } catch (e) {
      loadError.value = errMsg(e);
    }
  } else {
    // Default the new row to "generic" + an empty bag, but if the type
    // registry came back without "generic" pick the first type.
    form.value.type = types.value.find(t => t.type === "generic") ? "generic"
                    : (types.value[0]?.type || "generic");
    if (form.value.type === "generic") rebuildGenericRows();
  }
  loading.value = false;
  lastSavedHash = JSON.stringify(form.value);
});

// Reset data when the user picks a different type during create. Doing this
// inside a watcher keeps the form predictable — switching to "database"
// shouldn't keep stale "url" keys from a generic config.
watch(() => form.value.type, (newType, oldType) => {
  if (!isNew.value || newType === oldType) return;
  form.value.data = {};
  if (newType === "generic") {
    genericRows.value = [];
  }
  // Each type has its own set of secret fields; reset visibility.
  for (const k of Object.keys(passwordVisible)) delete passwordVisible[k];
});

// ── Dirty tracking ─────────────────────────────────────────────────────────
watch(form, () => {
  try { dirty.value = JSON.stringify(form.value) !== lastSavedHash; }
  catch { dirty.value = true; }
}, { deep: true });

// ── Validation -------------------------------------------------------------
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const nameOk    = computed(() => NAME_RE.test(form.value.name || ""));
const nameError = computed(() => {
  if (!form.value.name) return "required";
  if (!nameOk.value) return "letters, digits, _, - (must start with a letter or _)";
  return "";
});
const canSave = computed(() => !saving.value && nameOk.value && !!form.value.type);

// ── Per-type field helpers ─────────────────────────────────────────────────
function setField(k, v) {
  // Treat empty string as "unset" so we don't pollute the API payload.
  if (v === "" || v === undefined) {
    const next = { ...form.value.data };
    delete next[k];
    form.value.data = next;
  } else {
    form.value.data = { ...form.value.data, [k]: v };
  }
}

// ── Generic rows ───────────────────────────────────────────────────────────
function rebuildGenericRows() {
  const data = form.value.data || {};
  const secretMap = data.__secret || {};
  genericRows.value = Object.entries(data)
    .filter(([k]) => k !== "__secret")
    .map(([k, v]) => ({
      _k: `_${k}_${Math.random().toString(16).slice(2, 6)}`,
      k,
      // Existing secrets come back masked as "***" — clear the box so the
      // user knows nothing they type is what's currently stored.
      v: v === "***" ? "" : v,
      secret: !!secretMap[k],
    }));
}
function addGenericRow() {
  genericRows.value.push({ _k: `_${Date.now()}`, k: "", v: "", secret: false });
}
function removeGenericRow(_k) {
  genericRows.value = genericRows.value.filter(r => r._k !== _k);
  syncGeneric();
}
function toggleGenericSecret(row) {
  row.secret = !row.secret;
  syncGeneric();
}
function syncGeneric() {
  const data = {};
  const secretMap = {};
  for (const r of genericRows.value) {
    if (!r.k) continue;
    if (r.secret) secretMap[r.k] = true;
    if (r.v !== "" && r.v !== undefined) data[r.k] = r.v;
  }
  if (Object.keys(secretMap).length) data.__secret = secretMap;
  form.value.data = data;
}

// ── Save --------------------------------------------------------------------
async function onSave() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    // Strip "***" sentinels so we don't send them as the new ciphertext.
    const data = stripSentinels(form.value.data);
    const payload = {
      name:        form.value.name,
      type:        form.value.type,
      description: form.value.description,
      data,
    };
    // Sharing flag travels only on the create path — backend ignores
    // it on update (sharing is immutable post-create in v1).
    if (isNew.value && form.value.sharedAtWorkspace) {
      payload.sharedAtWorkspace = true;
    }
    let saved;
    if (isNew.value) {
      saved = await Configs.create(payload);
    } else {
      // Update doesn't need `type` — backend keeps the existing one.
      saved = await Configs.update(route.params.id, {
        name: payload.name, description: payload.description, data,
      });
    }
    lastSavedHash = JSON.stringify(form.value);
    dirty.value = false;
    $q.notify({ type: "positive", message: `Saved "${form.value.name}"`, position: "bottom" });
    if (isNew.value && saved?.id) {
      router.replace({ path: `/configDesigner/${saved.id}` });
    }
  } catch (e) {
    $q.notify({ type: "negative", message: `Save failed: ${errMsg(e)}`, position: "bottom" });
  } finally {
    saving.value = false;
  }
}

function stripSentinels(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === "***") continue;
    out[k] = v;
  }
  return out;
}

// ── Navigation -------------------------------------------------------------
function goBack() {
  if (dirty.value) {
    $q.dialog({
      title: "Unsaved changes",
      message: "Discard changes and leave?",
      ok: { label: "Discard", color: "negative", unelevated: true, "no-caps": true },
      cancel: { label: "Stay", flat: true, "no-caps": true },
      persistent: true,
    }).onOk(_actuallyBack);
  } else {
    _actuallyBack();
  }
}
function _actuallyBack() {
  if (window.history.length > 1) router.back();
  else router.push("/");
}

window.addEventListener("beforeunload", (e) => {
  if (dirty.value) { e.preventDefault(); e.returnValue = ""; }
});

function errMsg(e) {
  return e?.response?.data?.message || e?.message || "unknown error";
}
</script>
