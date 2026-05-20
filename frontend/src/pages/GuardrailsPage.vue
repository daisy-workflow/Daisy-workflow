<!--
  Guardrails — project-level policy editor + violation feed.

  Layout:
    • Top: apply-scope toggle (input / output / both / none) + Save
    • Each detector renders as an expansion-item with enabled toggle,
      mode select, and detector-specific fields (types, threshold).
    • Right column: "Try it" panel — pastes text, runs against the
      in-progress (unsaved) policy via POST /guardrails/test, shows
      whether it was blocked / redacted / warned + per-detector
      evidence.
    • Bottom: paginated violation feed for the project.

  Per-agent overrides live in AgentDesigner, not here.
-->
<template>
  <div class="page q-pa-md gr-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Guardrails</div>
        <div class="text-caption text-grey-7">
          Content filters applied to every agent call. PII, toxicity,
          and jailbreak heuristics — configure per detector. Agents can
          override individual settings on their own page.
        </div>
      </div>
      <q-space />
      <q-btn
        unelevated color="primary" no-caps icon="save"
        label="Save policy"
        :loading="saving"
        @click="onSave"
      />
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>
    <q-banner v-if="policy?._isDefault" dense class="bg-blue-1 text-blue-9 q-mb-md">
      <template v-slot:avatar><q-icon name="info" /></template>
      No policy saved yet — these are the defaults. Click Save to persist.
    </q-banner>

    <div class="row q-col-gutter-md">
      <!-- Left: policy editor ─────────────────────────────────────── -->
      <div class="col-12 col-md-7">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-subtitle2 q-mb-sm">Apply scope</div>
            <q-btn-toggle
              v-model="form.apply_to"
              :options="applyToOptions.map(o => ({ label: o, value: o }))"
              dense unelevated no-caps
              color="grey-3" toggle-color="primary" text-color="grey-9" toggle-text-color="white"
            />
            <div class="text-caption text-grey-7 q-mt-xs">
              Whether guardrails scan the user input, the model output,
              both, or are temporarily off. <code>none</code> keeps the
              config but skips all checks.
            </div>
          </q-card-section>
          <q-separator />

          <q-expansion-item
            v-for="d in catalog?.detectors || []"
            :key="d.name"
            :label="d.label"
            :caption="d.description"
            header-class="text-weight-medium"
            switch-toggle-side
            default-opened
          >
            <q-card-section>
              <div class="row items-center q-mb-sm">
                <q-toggle
                  v-model="form.config[d.name].enabled"
                  :label="form.config[d.name].enabled ? 'Enabled' : 'Disabled'"
                  color="primary"
                />
                <q-space />
                <q-select
                  v-model="form.config[d.name].mode"
                  :options="d.modes"
                  label="Mode" outlined dense
                  style="min-width: 140px"
                />
              </div>

              <!-- PII: types multi-select -->
              <template v-if="d.name === 'pii'">
                <q-select
                  v-model="form.config.pii.types"
                  :options="d.fields.types.options"
                  emit-value map-options multiple
                  use-chips
                  label="Entity types"
                  outlined dense
                />
              </template>

              <!-- Toxicity: threshold + categories -->
              <template v-if="d.name === 'toxicity'">
                <q-input
                  v-model.number="form.config.toxicity.threshold"
                  type="number" step="0.05" min="0" max="1"
                  label="Score threshold (0–1)"
                  outlined dense class="q-mb-sm"
                />
                <q-select
                  v-model="form.config.toxicity.categories"
                  :options="d.fields.categories.options"
                  emit-value map-options multiple use-chips clearable
                  label="Restrict to categories (empty = any)"
                  outlined dense
                />
              </template>

              <!-- Jailbreak: threshold -->
              <template v-if="d.name === 'jailbreak'">
                <q-input
                  v-model.number="form.config.jailbreak.threshold"
                  type="number" step="0.05" min="0" max="1"
                  label="Score threshold (0–1)"
                  outlined dense
                />
              </template>
            </q-card-section>
            <q-separator />
          </q-expansion-item>
        </q-card>
      </div>

      <!-- Right: try-it panel ─────────────────────────────────────── -->
      <div class="col-12 col-md-5">
        <q-card flat bordered>
          <q-toolbar class="app-toolbar">
            <q-icon name="science" class="q-mr-sm" />
            <q-toolbar-title>Try it</q-toolbar-title>
          </q-toolbar>
          <q-separator />
          <q-card-section>
            <q-btn-toggle
              v-model="tryForm.side"
              :options="[{ label: 'Input', value: 'input' }, { label: 'Output', value: 'output' }]"
              dense unelevated no-caps
              color="grey-3" toggle-color="primary" text-color="grey-9" toggle-text-color="white"
              class="q-mb-sm"
            />
            <q-input
              v-model="tryForm.text"
              outlined dense type="textarea" autogrow
              label="Sample text"
              hint="Runs against the policy above (unsaved changes count)."
              class="q-mb-sm"
            />
            <q-btn
              unelevated color="primary" no-caps icon="play_arrow"
              label="Test"
              :loading="testing"
              :disable="!tryForm.text"
              @click="onTest"
            />
            <q-banner v-if="testError" dense class="bg-red-10 text-red-2 q-mt-sm">
              {{ testError }}
            </q-banner>
            <template v-if="testResult">
              <q-separator class="q-my-md" />
              <q-banner
                dense
                :class="testResult.blocked ? 'bg-red-10 text-red-2' : (testResult.violations?.length ? 'bg-orange-10 text-orange-2' : 'bg-green-10 text-green-2')"
              >
                <template v-slot:avatar>
                  <q-icon :name="testResult.blocked ? 'block' : (testResult.violations?.length ? 'warning' : 'check_circle')" />
                </template>
                {{ testResult.blocked
                    ? `Blocked by ${testResult.detector || 'guardrails'}`
                    : (testResult.violations?.length
                        ? `${testResult.violations.length} violation(s): ${[...new Set(testResult.violations.map(v => v.detector))].join(', ')}`
                        : 'Clean — no detectors flagged.') }}
              </q-banner>
              <div v-if="!testResult.blocked && testResult.text" class="q-mt-sm">
                <div class="text-caption text-grey-7 q-mb-xs">Result text</div>
                <pre class="gr-pre">{{ testResult.text }}</pre>
              </div>
              <div v-if="testResult.violations?.length" class="q-mt-sm">
                <q-list dense>
                  <q-item v-for="(v, i) in testResult.violations" :key="i" dense>
                    <q-item-section avatar>
                      <q-icon :name="iconForAction(v.action_taken)" :color="colorForAction(v.action_taken)" />
                    </q-item-section>
                    <q-item-section>
                      <q-item-label>
                        <code>{{ v.detector }}</code> · {{ v.action_taken }}
                      </q-item-label>
                      <q-item-label caption>
                        {{ shortDetails(v.details) }}
                      </q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>
              </div>
            </template>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <!-- Violations feed -->
    <q-card flat bordered class="q-mt-md">
      <q-toolbar class="app-toolbar">
        <q-icon name="report" class="q-mr-sm" />
        <q-toolbar-title>Recent violations</q-toolbar-title>
        <q-btn flat dense icon="refresh" @click="reloadViolations" />
      </q-toolbar>
      <q-separator />
      <q-list separator>
        <q-item v-for="v in violations" :key="v.id">
          <q-item-section avatar>
            <q-icon :name="iconForAction(v.action_taken)" :color="colorForAction(v.action_taken)" />
          </q-item-section>
          <q-item-section>
            <q-item-label>
              <code>{{ v.detector }}</code> · {{ v.side }} · {{ v.action_taken }}
              <span v-if="v.agent_title"> · agent <b>{{ v.agent_title }}</b></span>
              <span v-if="v.node"> · node <b>{{ v.node }}</b></span>
            </q-item-label>
            <q-item-label caption>
              {{ shortDetails(v.details) }} · {{ relativeTime(v.created_at) }}
            </q-item-label>
          </q-item-section>
        </q-item>
        <q-item v-if="!violations.length">
          <q-item-section class="text-grey-7 text-center">
            No violations recorded yet.
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from "vue";
import { useQuasar } from "quasar";
import { Guardrails } from "../api/client.js";

const $q = useQuasar();

const loadError       = ref("");
const saving          = ref(false);
const catalog         = ref(null);
const policy          = ref(null);
const applyToOptions  = ref(["input", "output", "both", "none"]);

// The editable form. Initialised from `catalog.defaultPolicy` so we
// always have valid shape even before the policy fetch resolves.
const form = ref({
  apply_to: "both",
  config: {
    pii:       { enabled: false, mode: "redact", types: [] },
    toxicity:  { enabled: false, mode: "warn",   threshold: 0.5, categories: [] },
    jailbreak: { enabled: false, mode: "warn",   threshold: 0.5 },
  },
});

async function load() {
  loadError.value = "";
  try {
    const [cat, pol] = await Promise.all([
      Guardrails.detectors(),
      Guardrails.getPolicy(),
    ]);
    catalog.value = cat;
    applyToOptions.value = cat.applyToOptions || applyToOptions.value;
    policy.value = pol;
    // Hydrate the form. Merge the persisted (or default) policy on top
    // of the empty shell to make sure every detector key exists even if
    // the row was saved before a detector was added.
    form.value = {
      apply_to: pol.apply_to || "both",
      config: {
        pii:       { ...form.value.config.pii,       ...(pol.config?.pii       || {}) },
        toxicity:  { ...form.value.config.toxicity,  ...(pol.config?.toxicity  || {}) },
        jailbreak: { ...form.value.config.jailbreak, ...(pol.config?.jailbreak || {}) },
      },
    };
    // PII types default = pick all if the policy didn't carry any.
    if (!form.value.config.pii.types?.length) {
      const t = catalog.value.detectors.find(d => d.name === "pii");
      form.value.config.pii.types = t?.fields?.types?.default || [];
    }
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message;
  }
}

async function onSave() {
  saving.value = true;
  try {
    const saved = await Guardrails.setPolicy({
      apply_to: form.value.apply_to,
      config:   form.value.config,
    });
    policy.value = saved;
    $q.notify({ type: "positive", message: "Policy saved" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally {
    saving.value = false;
  }
}

// ─── try-it ────────────────────────────────────────────────────
const tryForm    = ref({ text: "", side: "input" });
const testing    = ref(false);
const testResult = ref(null);
const testError  = ref("");

async function onTest() {
  testing.value = true; testError.value = ""; testResult.value = null;
  try {
    // Send the in-progress form so the user can see effects of
    // unsaved changes.
    testResult.value = await Guardrails.test({
      text:   tryForm.value.text,
      side:   tryForm.value.side,
      policy: { apply_to: form.value.apply_to, config: form.value.config },
    });
  } catch (e) {
    testError.value = e?.response?.data?.message || e.message;
  } finally {
    testing.value = false;
  }
}

// ─── violations feed ──────────────────────────────────────────
const violations = ref([]);

async function reloadViolations() {
  try {
    const r = await Guardrails.violations({ limit: 100 });
    violations.value = r.rows || [];
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

// ─── helpers ──────────────────────────────────────────────────
function iconForAction(a) {
  return { blocked: "block", redacted: "edit_off", warned: "warning" }[a] || "info";
}
function colorForAction(a) {
  return { blocked: "negative", redacted: "orange-9", warned: "amber-8" }[a] || "grey-7";
}
function shortDetails(d) {
  if (!d) return "";
  if (d.counts) {
    return Object.entries(d.counts).map(([k, n]) => `${n} ${k}`).join(", ");
  }
  if (d.categories) {
    return d.categories.slice(0, 3).map(c => `${c.category} ${c.score?.toFixed(2)}`).join(", ");
  }
  if (typeof d.score === "number") return `score ${d.score.toFixed(2)}${d.rules?.length ? ` · ${d.rules.join(", ")}` : ""}`;
  return JSON.stringify(d).slice(0, 80);
}
function relativeTime(ts) {
  if (!ts) return "";
  const sec = (Date.now() - new Date(ts).getTime()) / 1000;
  if (sec < 60)    return `${sec | 0}s ago`;
  if (sec < 3600)  return `${(sec/60)|0}m ago`;
  if (sec < 86400) return `${(sec/3600)|0}h ago`;
  return `${(sec/86400)|0}d ago`;
}

onMounted(async () => {
  await load();
  await reloadViolations();
});
</script>

<style scoped>
.gr-page .page-header { display: flex; align-items: center; }
.gr-pre {
  white-space: pre-wrap;
  font-size: 12px;
  line-height: 1.45;
  background: #fafafa;
  border-radius: 4px;
  padding: 8px;
  margin: 0;
  max-height: 280px;
  overflow: auto;
}
.app-toolbar { background: #f5f5f5; min-height: 36px; }
</style>
