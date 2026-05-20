<!--
  Prompt Templates — project-scoped (with workspace-shared rows).

  Layout: list + inline editor (right column shows the selected
  template). Workspace-shared rows are visible to everyone in the
  workspace but only workspace admins can create / edit them.

  Variable substitution uses ${name} syntax. The "Variables" panel
  auto-extracts the placeholders found in the body so the user sees
  exactly what the agent's call site needs to supply.
-->
<template>
  <div class="page q-pa-md pt-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Prompt templates</div>
        <div class="text-caption text-grey-7">
          Parameterised system prompts. Agents can pin a template instead of
          carrying their own inline prompt — edit the prompt in one place.
        </div>
      </div>
      <q-space />
      <q-btn
        color="primary" unelevated no-caps icon="add" label="New template"
        @click="openCreate"
      />
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <div class="row q-col-gutter-md">
      <!-- list -->
      <div class="col-12 col-md-4">
        <q-card flat bordered>
          <q-list separator>
            <q-item
              v-for="t in rows" :key="t.id"
              clickable :active="selected?.id === t.id"
              active-class="pt-active"
              @click="select(t)"
            >
              <q-item-section>
                <q-item-label>
                  {{ t.title }}
                  <q-chip
                    v-if="t.shared_at_workspace"
                    dense square size="10px"
                    color="indigo-1" text-color="indigo-10" class="q-ml-xs"
                  >shared</q-chip>
                </q-item-label>
                <q-item-label v-if="t.description" caption>{{ t.description }}</q-item-label>
              </q-item-section>
            </q-item>
            <q-item v-if="!rows.length">
              <q-item-section class="text-grey-7 text-center">
                No templates yet.
              </q-item-section>
            </q-item>
          </q-list>
        </q-card>
      </div>

      <!-- editor -->
      <div class="col-12 col-md-8">
        <q-card v-if="selected" flat bordered>
          <q-toolbar class="app-toolbar">
            <q-icon name="text_snippet" class="q-mr-sm" />
            <q-toolbar-title>{{ selected.title }}</q-toolbar-title>
            <q-btn flat dense icon="delete" color="negative" @click="onDelete">
              <q-tooltip>Delete</q-tooltip>
            </q-btn>
          </q-toolbar>
          <q-separator />
          <q-card-section>
            <q-input v-model="editForm.title" outlined dense label="Title" class="q-mb-sm" />
            <q-input v-model="editForm.description" outlined dense label="Description" class="q-mb-sm" />
            <q-input
              v-model="editForm.body"
              outlined type="textarea" autogrow
              label="Body (use ${var} placeholders)"
              :input-style="{ minHeight: '200px', fontFamily: 'ui-monospace, monospace', fontSize: '13px' }"
              class="q-mb-sm"
            />
            <div class="text-caption text-grey-7 q-mb-xs">
              Auto-detected variables:
              <template v-if="detectedVars.length">
                <q-chip v-for="v in detectedVars" :key="v" dense square size="11px" color="grey-3">
                  {{ v }}
                </q-chip>
              </template>
              <span v-else>none</span>
            </div>
            <q-btn unelevated color="primary" no-caps icon="save"
              label="Save" :loading="saving" :disable="!editForm.title || !editForm.body"
              @click="onSave"
            />
          </q-card-section>
          <q-separator />
          <q-card-section>
            <div class="text-subtitle2 q-mb-sm">Preview</div>
            <div class="text-caption text-grey-7 q-mb-xs">Substitute values for the placeholders below.</div>
            <div v-for="v in detectedVars" :key="v" class="row items-center q-mb-xs">
              <div class="col-3 text-grey-7"><code>${{ '{' + v + '}' }}</code></div>
              <div class="col">
                <q-input v-model="previewVars[v]" outlined dense :placeholder="`value for ${v}`" />
              </div>
            </div>
            <q-btn flat dense color="primary" no-caps icon="play_arrow" label="Render" @click="onPreview" />
            <pre v-if="rendered != null" class="pt-pre q-mt-sm">{{ rendered }}</pre>
          </q-card-section>
        </q-card>
        <q-banner v-else class="bg-blue-1 text-blue-9">
          Pick a template on the left to edit it, or create a new one.
        </q-banner>
      </div>
    </div>

    <!-- Create dialog -->
    <q-dialog v-model="createOpen" persistent>
      <q-card style="min-width: 460px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="add" class="q-mr-sm" />
          <q-toolbar-title>New prompt template</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input v-model="newForm.title" outlined dense label="Title" class="q-mb-sm" />
          <q-input v-model="newForm.description" outlined dense label="Description (optional)" class="q-mb-sm" />
          <q-input
            v-model="newForm.body"
            outlined dense type="textarea" autogrow
            label="Body (use ${var})"
            :input-style="{ minHeight: '120px', fontFamily: 'ui-monospace, monospace', fontSize: '13px' }"
            class="q-mb-sm"
          />
          <q-toggle
            v-if="auth.isWorkspaceAdmin"
            v-model="newForm.sharedAtWorkspace"
            color="primary" label="Share with the whole workspace"
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn unelevated color="primary" no-caps label="Create"
            :loading="creating" :disable="!newForm.title || !newForm.body"
            @click="onCreate"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from "vue";
import { useQuasar } from "quasar";
import { PromptTemplates } from "../api/client.js";
import { auth } from "../stores/auth.js";

const $q = useQuasar();

const rows         = ref([]);
const loadError    = ref("");
const selected     = ref(null);
const saving       = ref(false);
const editForm     = reactive({ title: "", description: "", body: "" });

// "${name}" extraction — same regex as the backend renderer so the
// hint stays accurate.
const PLACEHOLDER_RE = /\$\{([^${}]+)\}/g;
const detectedVars = computed(() => {
  const seen = new Set();
  for (const m of (editForm.body || "").matchAll(PLACEHOLDER_RE)) {
    seen.add(m[1].split(":")[0].split(".")[0].trim());
  }
  return [...seen];
});

const previewVars = reactive({});
const rendered    = ref(null);

async function reload() {
  try {
    rows.value = await PromptTemplates.list();
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message;
  }
}

async function select(t) {
  selected.value = t;
  rendered.value = null;
  // Editor mirrors the row; refetch the latest so we don't edit a
  // stale list-row payload.
  try {
    const full = await PromptTemplates.get(t.id);
    selected.value = full;
    editForm.title = full.title; editForm.description = full.description || ""; editForm.body = full.body || "";
    // Reset preview vars; keep any keys the user already typed.
    for (const k of Object.keys(previewVars)) delete previewVars[k];
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

async function onSave() {
  saving.value = true;
  try {
    await PromptTemplates.update(selected.value.id, {
      title: editForm.title.trim(),
      description: editForm.description || null,
      body: editForm.body,
    });
    $q.notify({ type: "positive", message: "Saved" });
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { saving.value = false; }
}

async function onDelete() {
  $q.dialog({
    title: "Delete template?",
    message: `“${selected.value.title}” — agents pinned to it will fall back to their inline prompt.`,
    ok: { label: "Delete", color: "negative", noCaps: true },
    cancel: { label: "Cancel", flat: true, noCaps: true },
    persistent: true,
  }).onOk(async () => {
    try {
      await PromptTemplates.remove(selected.value.id);
      selected.value = null;
      await reload();
    } catch (e) {
      $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
    }
  });
}

async function onPreview() {
  try {
    const r = await PromptTemplates.preview(selected.value.id, { ...previewVars });
    rendered.value = r.rendered;
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

// Create dialog
const createOpen = ref(false);
const creating   = ref(false);
const newForm    = reactive({ title: "", description: "", body: "", sharedAtWorkspace: false });

function openCreate() {
  newForm.title = ""; newForm.description = ""; newForm.body = ""; newForm.sharedAtWorkspace = false;
  createOpen.value = true;
}
async function onCreate() {
  creating.value = true;
  try {
    await PromptTemplates.create({
      title: newForm.title.trim(),
      description: newForm.description || null,
      body: newForm.body,
      sharedAtWorkspace: !!newForm.sharedAtWorkspace,
    });
    createOpen.value = false;
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { creating.value = false; }
}

onMounted(reload);
</script>

<style scoped>
.pt-page .page-header { display: flex; align-items: center; }
.pt-active { background: #eef5ff; }
.pt-pre {
  white-space: pre-wrap;
  background: #fafafa;
  border-radius: 4px;
  padding: 8px;
  margin: 0;
  font-size: 12px;
  max-height: 280px;
  overflow: auto;
}
.app-toolbar { background: #f5f5f5; min-height: 36px; }
</style>
