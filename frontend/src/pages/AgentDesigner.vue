<!--
  AgentDesigner — single-page editor for one agent row.

  An agent pairs:
    • title       — display name + the lookup key the `agent` plugin uses
    • prompt      — the system prompt the LLM runs against
    • config_name — name of a stored ai.provider configuration that
                    supplies the API key + model

  The form is small (three fields plus an optional description) so we use
  a hand-rolled layout instead of the schema-driven PropertyEditor that
  ConfigDesigner uses.
-->
<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <q-btn flat round dense icon="arrow_back" class="btn-toolbar q-mr-sm" @click="goBack">
          <q-tooltip>Back</q-tooltip>
        </q-btn>
        <q-toolbar-title>
          {{ isNew ? "New agent" : (form.title || "Agent") }}
          <span v-if="dirty" class="q-ml-xs text-caption" style="color: var(--warning);">●</span>
        </q-toolbar-title>
        <q-space />
        <!-- Share — per-agent ACL. Disabled until the agent has been
             saved at least once (no id to attach grants to). -->
        <q-btn
          flat round dense
          icon="share"
          class="btn-icon q-mr-sm"
          :disable="isNew"
          @click="shareOpen = true"
        >
          <q-tooltip>{{
            isNew
              ? "Save the agent once before sharing"
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

        <div v-else class="q-pa-md column q-gutter-md" style="max-width: 820px;">
          <!-- Title -->
          <q-input
            v-model="form.title"
            dense outlined
            label="Title *"
            :error="!titleOk"
            :error-message="titleError"
            hint="Used as the lookup key from the `agent` plugin's `agent:` input. Letters, digits, spaces, underscores, dots, dashes."
          />

          <!-- AI provider config -->
          <div class="row items-center q-gutter-sm">
            <q-select
              v-model="form.config_name"
              :options="aiProviderOptions"
              option-label="label"
              option-value="name"
              emit-value map-options
              dense outlined
              label="AI provider config *"
              class="col"
              :error="!configOk"
              :error-message="configError"
              :hint="configHint"
            >
              <template v-slot:no-option>
                <q-item>
                  <q-item-section>
                    No <code>ai.provider</code> configurations found. Create one on the
                    <a href="#" @click.prevent="goToConfigs">Configurations</a> page first.
                  </q-item-section>
                </q-item>
              </template>
            </q-select>
            <q-btn
              flat dense round icon="open_in_new"
              :disable="!form.config_name"
              @click="openConfig(form.config_name)"
            >
              <q-tooltip>Open the linked configuration</q-tooltip>
            </q-btn>
          </div>

          <!-- Prompt — markdown editor with edit / split / preview tabs -->
          <MarkdownEditor
            v-model="form.prompt"
            label="System prompt"
            required
            :error="!promptOk"
            error-message="System prompt is required."
            placeholder="# Role&#10;You are a sentiment analyser. Respond in JSON.&#10;&#10;## Output schema&#10;```json&#10;{&#10;  &quot;sentiment&quot;: &quot;positive | neutral | negative&quot;,&#10;  &quot;confidence&quot;: 0.92&#10;}&#10;```"
            hint="Markdown is supported. Tell the agent who it is, what it does, and ask it to respond in JSON — the plugin parses the response onto output.result; non-JSON responses surface on output.raw."
            :min-height="300"
            default-mode="split"
          />

          <!-- Description -->
          <q-input
            v-model="form.description"
            dense outlined
            label="Description"
            hint="Optional. Shows on the Home page."
          />

          <!-- Workspace-share toggle. Visible to workspace admins ONLY
               and only on create — same constraints as the configs
               share toggle. A shared agent is callable from every
               project in the workspace; pair with a shared ai.provider
               config so the prompt + the credentials travel together. -->
          <q-card
            v-if="isNew && auth.user?.role === 'admin'"
            flat bordered class="q-mt-sm"
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
                Shared agents are usable by every project in this workspace.
                The referenced config must also be reachable (shared or named identically in each project).
              </div>
            </q-card-section>
          </q-card>

          <!-- Help / how to call this agent -->
          <q-card flat bordered class="q-mt-md">
            <q-card-section class="q-pa-md">
              <div class="text-subtitle2 q-mb-xs">How to use this agent</div>
              <div class="text-caption" style="color: var(--text-muted);">
                Add an <code>agent</code> node on the canvas, set
                <code>agent: "{{ form.title || '<title>' }}"</code>, and pass the text to
                analyse via <code>input</code>. The node returns
                <code>{ result, confidence, raw, usage }</code> — wire <code>result</code>
                into a downstream variable through the Outputs panel.
              </div>
            </q-card-section>
          </q-card>
        </div>
      </q-page>
    </q-page-container>

    <!-- Per-agent sharing dialog — same pattern as configs + workflows. -->
    <ShareResourceDialog
      v-if="!isNew"
      v-model:open="shareOpen"
      resource-type="agent"
      :resource-id="route.params.id"
      :resource-name="form.title"
    />
  </q-layout>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Agents, Configs } from "../api/client";
import MarkdownEditor from "../components/MarkdownEditor.vue";
import ShareResourceDialog from "../components/ShareResourceDialog.vue";
import { auth } from "../stores/auth.js";

const route  = useRoute();
const router = useRouter();
const $q     = useQuasar();

const isNew = computed(() => route.params.id === "new" || !route.params.id);

// Open state for the per-resource share dialog. Toolbar Share button
// flips it; ShareResourceDialog owns its own listing + grant flows.
const shareOpen = ref(false);

const loading   = ref(true);
const saving    = ref(false);
const loadError = ref("");
const dirty     = ref(false);

// Two server reads on mount: the agent row (existing only) + the list of
// ai.provider configurations to populate the picker. Configs are pulled
// here rather than via the registry endpoint because we need the actual
// stored rows (names) to reference, not the type schema.
const aiProviderConfigs = ref([]);
const aiProviderOptions = computed(() =>
  aiProviderConfigs.value.map(c => ({
    name:  c.name,
    label: c.name + (c.description ? ` — ${c.description}` : ""),
  })),
);

const form = reactive({
  title:       "",
  prompt:      "",
  config_name: "",
  description: "",
  // RBAC v2 sharing flag (workspace admin only, create-only).
  sharedAtWorkspace: false,
});
let original = "";

// ── Validation ─────────────────────────────────────────────────────────
const TITLE_RE = /^[A-Za-z0-9 _.\-]+$/;
const titleOk  = computed(() => !!form.title?.trim() && TITLE_RE.test(form.title.trim()));
const titleError = computed(() => {
  if (!form.title?.trim()) return "Title is required.";
  if (!TITLE_RE.test(form.title.trim())) return "Letters, digits, spaces, underscores, dots, and dashes only.";
  return "";
});
const promptOk = computed(() => !!form.prompt?.trim());
const configOk = computed(() => !!form.config_name);
const configError = computed(() => configOk.value ? "" : "Pick a stored ai.provider configuration.");
const configHint  = computed(() => {
  if (!form.config_name) return "Provides the API key + model the agent runs against.";
  const c = aiProviderConfigs.value.find(x => x.name === form.config_name);
  return c?.description || "Provides the API key + model the agent runs against.";
});

const canSave = computed(() => titleOk.value && promptOk.value && configOk.value && !saving.value);

watch(form, () => { dirty.value = JSON.stringify(form) !== original; }, { deep: true });

// ── Lifecycle ─────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    // Always load the configs list — needed for the picker on both new + edit.
    const allConfigs = await Configs.list();
    aiProviderConfigs.value = (allConfigs || []).filter(c => c.type === "ai.provider");

    if (!isNew.value) {
      const a = await Agents.get(route.params.id);
      form.title       = a.title       || "";
      form.prompt      = a.prompt      || "";
      form.config_name = a.config_name || "";
      form.description = a.description || "";
    }
    original = JSON.stringify(form);
  } catch (e) {
    loadError.value = errMsg(e);
  } finally {
    loading.value = false;
  }
});

// ── Actions ───────────────────────────────────────────────────────────
async function onSave() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const payload = {
      title:       form.title.trim(),
      prompt:      form.prompt,
      config_name: form.config_name,
      description: form.description || null,
    };
    if (isNew.value && form.sharedAtWorkspace) {
      // Sharing is create-only; backend rejects the flag on update.
      payload.sharedAtWorkspace = true;
    }
    if (isNew.value) {
      const created = await Agents.create(payload);
      original = JSON.stringify(form);
      dirty.value = false;
      $q.notify({ type: "positive", message: `Created "${payload.title}"`, position: "bottom" });
      router.replace({ path: `/agentDesigner/${created.id}` });
    } else {
      await Agents.update(route.params.id, payload);
      original = JSON.stringify(form);
      dirty.value = false;
      $q.notify({ type: "positive", message: `Saved "${payload.title}"`, position: "bottom" });
    }
  } catch (e) {
    $q.notify({ type: "negative", message: `Save failed: ${errMsg(e)}`, position: "bottom" });
  } finally {
    saving.value = false;
  }
}

function goBack() {
  if (dirty.value) {
    $q.dialog({
      title:   "Unsaved changes",
      message: "Discard changes and leave?",
      ok:     { label: "Discard", color: "negative", unelevated: true, "no-caps": true },
      cancel: { label: "Stay",   flat: true, "no-caps": true },
      persistent: true,
    }).onOk(_actuallyGoBack);
  } else {
    _actuallyGoBack();
  }
}
function _actuallyGoBack() {
  if (window.history.length > 1) router.back();
  else router.push("/");
}

function goToConfigs() {
  router.push({ path: "/" });   // Home page hosts the Configurations table
}
function openConfig(name) {
  const c = aiProviderConfigs.value.find(x => x.name === name);
  if (!c) return;
  router.push({ path: `/configDesigner/${c.id}` });
}

function errMsg(e) {
  return e?.response?.data?.message || e?.message || "unknown error";
}

// Warn on page reload / browser-close when there are unsaved changes.
window.addEventListener("beforeunload", (e) => {
  if (dirty.value) { e.preventDefault(); e.returnValue = ""; }
});
</script>

<style scoped>
.app-subtitle {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  margin-left: 8px;
}
code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
}
</style>
