<!--
  Evals — project-scoped suites + cases + runs.

  Two modes:
    • Suite list (default)
    • Suite detail when one is selected:
        - Cases table (CRUD)
        - Runs list with totals
        - "Run now" button → kicks off a synchronous run
        - Run results drawer when a run is opened
-->
<template>
  <div class="page q-pa-md ev-page">
    <!-- ─── List mode ───────────────────────────────────────── -->
    <template v-if="!selectedSuite">
      <div class="page-header q-mb-md">
        <div>
          <div class="text-h6">Evals</div>
          <div class="text-caption text-grey-7">
            Regression-test suites for your agents. Each case = one
            agent call + a set of scorers (exact / contains / regex /
            JSON / LLM-as-judge).
          </div>
        </div>
        <q-space />
        <q-btn color="primary" unelevated no-caps icon="add" label="New suite" @click="openCreate" />
      </div>
      <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
        {{ loadError }}
      </q-banner>
      <q-table
        :rows="suites" :columns="suiteCols"
        row-key="id" flat dense bordered
        :loading="loading"
        :pagination="{ rowsPerPage: 50, sortBy: 'title', descending: false }"
      >
        <template v-slot:top-right>
          <q-btn icon="refresh" flat dense size="sm" @click="reloadSuites" />
        </template>
        <template v-slot:body-cell-title="props">
          <q-td :props="props">
            <span class="text-primary cursor-pointer" @click="selectSuite(props.row)">
              {{ props.row.title }}
            </span>
            <div v-if="props.row.description" class="text-caption text-grey-7">
              {{ props.row.description }}
            </div>
          </q-td>
        </template>
        <template v-slot:body-cell-agent="props">
          <q-td :props="props">
            <span v-if="props.row.agent_title">{{ props.row.agent_title }}</span>
            <span v-else class="text-grey-5">(unbound)</span>
          </q-td>
        </template>
        <template v-slot:body-cell-actions="props">
          <q-td :props="props" auto-width>
            <q-btn flat dense size="sm" icon="open_in_new" @click="selectSuite(props.row)" />
            <q-btn flat dense size="sm" icon="delete" color="negative" @click="onDeleteSuite(props.row)" />
          </q-td>
        </template>
        <template v-slot:no-data>
          <div class="full-width text-center q-pa-md text-grey-7">
            No suites yet.
          </div>
        </template>
      </q-table>
    </template>

    <!-- ─── Detail mode ─────────────────────────────────────── -->
    <template v-else>
      <div class="page-header q-mb-md">
        <q-btn flat dense icon="arrow_back" no-caps label="All suites" @click="selectedSuite = null" />
        <q-space />
        <div class="column items-end">
          <div class="text-h6">{{ selectedSuite.title }}</div>
          <div class="text-caption text-grey-7">
            agent: <code>{{ selectedSuite.agent_title || '—' }}</code> · {{ cases.length }} case(s)
          </div>
        </div>
      </div>

      <div class="row q-col-gutter-md">
        <!-- left: cases -->
        <div class="col-12 col-md-7">
          <q-card flat bordered>
            <q-toolbar class="app-toolbar">
              <q-icon name="rule" class="q-mr-sm" />
              <q-toolbar-title>Cases</q-toolbar-title>
              <q-btn flat dense icon="add" no-caps label="Case" @click="openCaseDialog(null)" />
            </q-toolbar>
            <q-separator />
            <q-list separator>
              <q-item v-for="c in cases" :key="c.id">
                <q-item-section>
                  <q-item-label>{{ c.title }}</q-item-label>
                  <q-item-label caption>
                    <q-chip v-for="s in c.scorers" :key="s.type" dense square size="10px" color="grey-3">
                      {{ s.type }}
                    </q-chip>
                    <span class="q-ml-sm">
                      input: <i>{{ caseInputPreview(c) }}</i>
                    </span>
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <div>
                    <q-btn flat dense size="sm" icon="edit" @click="openCaseDialog(c)" />
                    <q-btn flat dense size="sm" icon="delete" color="negative" @click="onDeleteCase(c)" />
                  </div>
                </q-item-section>
              </q-item>
              <q-item v-if="!cases.length">
                <q-item-section class="text-grey-7 text-center">
                  No cases yet. Add one to start running the suite.
                </q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </div>

        <!-- right: runs -->
        <div class="col-12 col-md-5">
          <q-card flat bordered>
            <q-toolbar class="app-toolbar">
              <q-icon name="play_circle" class="q-mr-sm" />
              <q-toolbar-title>Runs</q-toolbar-title>
              <q-btn
                unelevated color="primary" no-caps icon="play_arrow"
                label="Run now"
                :loading="running"
                :disable="!cases.length || !selectedSuite.agent_id"
                @click="onRunNow"
              />
            </q-toolbar>
            <q-separator />
            <q-list separator>
              <q-item v-for="r in runs" :key="r.id" clickable @click="openRun(r)">
                <q-item-section avatar>
                  <q-icon :name="statusIcon(r.status)" :color="statusColor(r.status)" />
                </q-item-section>
                <q-item-section>
                  <q-item-label>
                    {{ r.status }}
                    <span v-if="r.totals">
                      · {{ r.totals.passed }}/{{ (r.totals.passed||0) + (r.totals.failed||0) }} passed
                      · score {{ (r.totals.score ?? 0).toFixed(2) }}
                    </span>
                  </q-item-label>
                  <q-item-label caption>
                    {{ relativeTime(r.started_at) }}
                    <span v-if="r.totals?.durationMs">· {{ (r.totals.durationMs / 1000).toFixed(1) }}s</span>
                    <span v-if="r.totals?.totalCostMicros != null">· {{ formatDollars(r.totals.totalCostMicros) }}</span>
                  </q-item-label>
                  <q-item-label v-if="r.error" caption class="text-negative">{{ r.error }}</q-item-label>
                </q-item-section>
              </q-item>
              <q-item v-if="!runs.length">
                <q-item-section class="text-grey-7 text-center">No runs yet.</q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </div>
      </div>
    </template>

    <!-- Create suite dialog -->
    <q-dialog v-model="createOpen" persistent>
      <q-card style="min-width: 460px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="add" class="q-mr-sm" />
          <q-toolbar-title>New eval suite</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input v-model="newSuite.title" outlined dense label="Title" class="q-mb-sm" />
          <q-input v-model="newSuite.description" outlined dense label="Description (optional)" class="q-mb-sm" />
          <q-select
            v-model="newSuite.agent_id"
            :options="agentOptions" emit-value map-options
            outlined dense label="Agent (the suite tests this agent)"
            hint="Pick the agent every case in this suite will call."
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn unelevated color="primary" no-caps label="Create"
            :loading="creatingSuite" :disable="!newSuite.title"
            @click="onCreateSuite"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Case dialog (create + edit) -->
    <q-dialog v-model="caseDialogOpen" persistent>
      <q-card style="min-width: 640px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon :name="caseEditing?.id ? 'edit' : 'add'" class="q-mr-sm" />
          <q-toolbar-title>{{ caseEditing?.id ? "Edit case" : "New case" }}</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input v-model="caseForm.title" outlined dense label="Title" class="q-mb-sm" />
          <q-input
            v-model="caseForm.inputText"
            outlined dense type="textarea" autogrow
            label="Agent input"
            hint="The text passed to the agent for this case."
            class="q-mb-sm"
          />
          <q-input
            v-model="caseForm.varsText"
            outlined dense type="textarea" autogrow
            label="Template vars (JSON, optional)"
            hint='e.g. {"name": "Alice"} — used when the agent is bound to a prompt template.'
            class="q-mb-sm"
          />
          <q-separator class="q-my-md" />
          <div class="text-subtitle2 q-mb-sm">Scorers</div>
          <q-card flat bordered v-for="(sc, i) in caseForm.scorers" :key="i" class="q-mb-sm">
            <q-card-section class="q-pa-sm row items-center">
              <q-select
                v-model="sc.type" :options="scorerNames"
                dense outlined label="Type" style="min-width: 160px"
              />
              <q-space />
              <q-btn flat dense size="sm" icon="delete" color="negative" @click="caseForm.scorers.splice(i, 1)" />
            </q-card-section>
            <q-separator />
            <q-card-section class="q-pa-sm">
              <component
                :is="'div'"
                v-if="sc.type === 'exact'"
              >
                <q-input v-model="sc.expectedText" outlined dense type="textarea" autogrow label="Expected output" />
              </component>
              <div v-else-if="sc.type === 'contains'">
                <q-input v-model="sc.expectedText" outlined dense
                  label="Required substring (comma-separated for multiple)"
                  hint="ALL must appear by default. Use mode=any below for OR." class="q-mb-sm"
                />
                <q-select v-model="sc.mode" :options="['all','any']" outlined dense label="Mode" />
              </div>
              <div v-else-if="sc.type === 'regex'">
                <q-input v-model="sc.pattern" outlined dense label="Pattern (JS regex)" class="q-mb-sm" />
                <q-input v-model="sc.flags" outlined dense label="Flags" placeholder="i" />
              </div>
              <div v-else-if="sc.type === 'json'">
                <q-input v-model="sc.requiredKeysText" outlined dense
                  label="Required dotted paths (comma-separated)"
                  hint="e.g. intent, entities.0.type"
                />
              </div>
              <div v-else-if="sc.type === 'llm_judge'">
                <q-input v-model="sc.judgeAgent" outlined dense label="Judge agent (title)" class="q-mb-sm" />
                <q-input v-model="sc.rubric" outlined dense type="textarea" autogrow label="Rubric / criteria" class="q-mb-sm" />
                <q-input v-model.number="sc.threshold" outlined dense type="number" step="0.05" min="0" max="1"
                  label="Pass threshold" placeholder="0.7"
                />
              </div>
            </q-card-section>
          </q-card>
          <q-btn flat dense color="primary" no-caps icon="add" label="Add scorer" @click="addScorer" />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn unelevated color="primary" no-caps label="Save"
            :loading="savingCase" :disable="!caseForm.title"
            @click="onSaveCase"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Run results drawer -->
    <q-dialog v-model="runResultsOpen">
      <q-card style="min-width: 720px; max-width: 96vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="play_circle" class="q-mr-sm" />
          <q-toolbar-title>Run results</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section v-if="runDetail">
          <div class="text-caption text-grey-7 q-mb-sm">
            <span :class="statusColorClass(runDetail.status)">{{ runDetail.status }}</span>
            · {{ runDetail.totals?.passed ?? 0 }}/{{ (runDetail.totals?.passed||0) + (runDetail.totals?.failed||0) }} passed
            · score {{ (runDetail.totals?.score ?? 0).toFixed(2) }}
            · {{ (runDetail.totals?.durationMs/1000).toFixed(1) }}s
          </div>
          <q-list separator>
            <q-item v-for="r in runResults" :key="r.id">
              <q-item-section avatar>
                <q-icon :name="statusIcon(r.status)" :color="statusColor(r.status)" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ r.case_title }}</q-item-label>
                <q-item-label caption>
                  score {{ (r.score ?? 0).toFixed(2) }}
                  · {{ r.input_tokens || 0 }} in · {{ r.output_tokens || 0 }} out
                  <span v-if="r.latency_ms != null">· {{ r.latency_ms }}ms</span>
                </q-item-label>
                <pre v-if="r.output_text" class="ev-pre">{{ r.output_text }}</pre>
                <div v-for="(sr, i) in r.scorer_results" :key="i" class="q-mt-xs">
                  <q-chip dense square size="10px"
                    :color="sr.passed ? 'positive' : 'negative'"
                    text-color="white"
                  >
                    {{ sr.type }} {{ sr.passed ? '✓' : '✗' }}
                  </q-chip>
                  <span class="text-caption q-ml-sm">{{ shortDetail(sr) }}</span>
                </div>
                <div v-if="r.error" class="text-negative q-mt-xs">{{ r.error }}</div>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { Evals, Agents } from "../api/client.js";

const $q = useQuasar();

const suites    = ref([]);
const loading   = ref(false);
const loadError = ref("");
const selectedSuite = ref(null);
const cases     = ref([]);
const runs      = ref([]);
const scorers   = ref([]);

const suiteCols = [
  { name: "title",  label: "Title",  field: "title",  align: "left", sortable: true },
  { name: "agent",  label: "Agent",  field: "agent_title", align: "left" },
  { name: "cases",  label: "Cases",  field: "case_count", align: "left" },
  { name: "actions", label: "",      field: "id", align: "right" },
];

const scorerNames = computed(() => scorers.value.map(s => s.name));

async function reloadSuites() {
  loading.value = true; loadError.value = "";
  try {
    [suites.value, scorers.value] = await Promise.all([
      Evals.listSuites(),
      Evals.scorers(),
    ]);
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message;
  } finally { loading.value = false; }
}

async function selectSuite(s) {
  selectedSuite.value = s;
  cases.value = [];
  runs.value = [];
  try {
    [cases.value, runs.value] = await Promise.all([
      Evals.listCases(s.id),
      Evals.listRuns(s.id),
    ]);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

// ─── create suite ───────────────────────────────────────
const createOpen    = ref(false);
const creatingSuite = ref(false);
const newSuite      = reactive({ title: "", description: "", agent_id: null });
const agentOptions  = ref([]);

async function openCreate() {
  createOpen.value = true;
  try {
    const all = await Agents.list();
    agentOptions.value = all.map(a => ({ label: a.title, value: a.id }));
  } catch { /* user can save without — but UX-warned */ }
}
async function onCreateSuite() {
  creatingSuite.value = true;
  try {
    await Evals.createSuite({
      title: newSuite.title.trim(),
      description: newSuite.description || null,
      agent_id: newSuite.agent_id || null,
    });
    createOpen.value = false;
    newSuite.title = ""; newSuite.description = ""; newSuite.agent_id = null;
    await reloadSuites();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { creatingSuite.value = false; }
}

async function onDeleteSuite(s) {
  $q.dialog({
    title: "Delete suite?",
    message: `“${s.title}” — all cases + runs are deleted too.`,
    ok: { label: "Delete", color: "negative", noCaps: true },
    cancel: { label: "Cancel", flat: true, noCaps: true },
    persistent: true,
  }).onOk(async () => {
    try { await Evals.deleteSuite(s.id); await reloadSuites(); }
    catch (e) { $q.notify({ type: "negative", message: e?.response?.data?.message || e.message }); }
  });
}

// ─── case dialog ────────────────────────────────────────
const caseDialogOpen = ref(false);
const savingCase     = ref(false);
const caseEditing    = ref(null);
const caseForm       = reactive({
  title: "", inputText: "", varsText: "",
  scorers: [],
});

function openCaseDialog(c) {
  caseEditing.value = c;
  if (c) {
    caseForm.title     = c.title;
    caseForm.inputText = (c.inputs?.input ?? (typeof c.inputs === "string" ? c.inputs : "")) || "";
    caseForm.varsText  = c.inputs?.vars ? JSON.stringify(c.inputs.vars, null, 2) : "";
    caseForm.scorers   = (c.scorers || []).map(sc => hydrateScorer(sc, c.expected));
  } else {
    caseForm.title = ""; caseForm.inputText = ""; caseForm.varsText = "";
    caseForm.scorers = [];
  }
  caseDialogOpen.value = true;
}

function addScorer() {
  caseForm.scorers.push({ type: "exact", expectedText: "" });
}

async function onSaveCase() {
  savingCase.value = true;
  try {
    const inputs = { input: caseForm.inputText };
    if (caseForm.varsText.trim()) {
      try { inputs.vars = JSON.parse(caseForm.varsText); }
      catch (e) { throw new Error(`vars JSON parse: ${e.message}`); }
    }
    const { scorers: payloadScorers, expected } = dehydrateScorers(caseForm.scorers);
    const body = {
      title:   caseForm.title.trim(),
      inputs,
      expected,
      scorers: payloadScorers,
    };
    if (caseEditing.value) {
      await Evals.updateCase(selectedSuite.value.id, caseEditing.value.id, body);
    } else {
      await Evals.createCase(selectedSuite.value.id, body);
    }
    caseDialogOpen.value = false;
    cases.value = await Evals.listCases(selectedSuite.value.id);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { savingCase.value = false; }
}

async function onDeleteCase(c) {
  try {
    await Evals.deleteCase(selectedSuite.value.id, c.id);
    cases.value = await Evals.listCases(selectedSuite.value.id);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

// ─── runs ───────────────────────────────────────────────
const running        = ref(false);
const runResultsOpen = ref(false);
const runDetail      = ref(null);
const runResults     = ref([]);

async function onRunNow() {
  running.value = true;
  try {
    const r = await Evals.startRun(selectedSuite.value.id);
    $q.notify({
      type: r.totals.failed > 0 ? "warning" : "positive",
      message: `Run finished: ${r.totals.passed}/${r.totals.passed + r.totals.failed} passed (score ${r.totals.score.toFixed(2)})`,
    });
    runs.value = await Evals.listRuns(selectedSuite.value.id);
    // Auto-open the new run so the user sees per-case details.
    const newest = runs.value[0];
    if (newest) await openRun(newest);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { running.value = false; }
}

async function openRun(r) {
  try {
    [runDetail.value, runResults.value] = await Promise.all([
      Evals.getRun(r.id),
      Evals.runResults(r.id),
    ]);
    runResultsOpen.value = true;
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

// ─── helpers ────────────────────────────────────────────
function caseInputPreview(c) {
  const t = c.inputs?.input ?? (typeof c.inputs === "string" ? c.inputs : "");
  return (t || "").slice(0, 80) + ((t || "").length > 80 ? "…" : "");
}
function statusIcon(s) {
  return { passed: "check_circle", failed: "cancel", errored: "error", complete: "check_circle", running: "schedule", pending: "schedule", failed_run: "error" }[s] || "help";
}
function statusColor(s) {
  return { passed: "positive", failed: "negative", errored: "negative", complete: "positive", running: "info", pending: "grey-7" }[s] || "grey-7";
}
function statusColorClass(s) {
  return { complete: "text-positive", failed: "text-negative", running: "text-info" }[s] || "text-grey-7";
}
function formatDollars(micros) {
  if (micros == null) return "—";
  const d = micros / 1_000_000;
  return d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
}
function relativeTime(ts) {
  if (!ts) return "";
  const sec = (Date.now() - new Date(ts).getTime()) / 1000;
  if (sec < 60)    return `${sec | 0}s ago`;
  if (sec < 3600)  return `${(sec/60)|0}m ago`;
  if (sec < 86400) return `${(sec/3600)|0}h ago`;
  return `${(sec/86400)|0}d ago`;
}
function shortDetail(sr) {
  const d = sr.details || {};
  if (d.error) return d.error;
  if (d.failures?.length) return `${d.failures.length} failure(s)`;
  if (d.wanted) return d.wanted.filter(w => !w.present).map(w => `missing "${w.phrase}"`).join(", ");
  if (typeof d.score === "number") return `score ${d.score.toFixed(2)}`;
  if (d.reasoning) return d.reasoning.slice(0, 120);
  return "";
}

/** UI ↔ API translation for scorer rows. */
function hydrateScorer(sc, expected) {
  const t = sc.type;
  const out = { type: t, ...sc.config };
  if (t === "exact") {
    out.expectedText = expected?.exact ?? sc.config?.expected ?? "";
  } else if (t === "contains") {
    const e = expected?.contains ?? sc.config?.expected;
    out.expectedText = Array.isArray(e) ? e.join(", ") : (e || "");
    out.mode = sc.config?.mode || "all";
  } else if (t === "regex") {
    out.pattern = sc.config?.pattern || expected?.regex || "";
    out.flags   = sc.config?.flags || "i";
  } else if (t === "json") {
    const keys = sc.config?.requiredKeys || expected?.json?.requiredKeys || [];
    out.requiredKeysText = keys.join(", ");
  } else if (t === "llm_judge") {
    out.judgeAgent = sc.config?.agent || "";
    out.rubric     = sc.config?.rubric || expected?.llm_judge?.rubric || "";
    out.threshold  = sc.config?.threshold ?? 0.7;
  }
  return out;
}
function dehydrateScorers(uiScorers) {
  const scorersOut = [];
  const expected   = {};
  for (const sc of uiScorers) {
    if (sc.type === "exact") {
      scorersOut.push({ type: "exact", weight: 1, config: {} });
      expected.exact = sc.expectedText || "";
    } else if (sc.type === "contains") {
      scorersOut.push({ type: "contains", weight: 1, config: { mode: sc.mode || "all" } });
      expected.contains = (sc.expectedText || "").split(",").map(s => s.trim()).filter(Boolean);
    } else if (sc.type === "regex") {
      scorersOut.push({ type: "regex", weight: 1, config: { pattern: sc.pattern || "", flags: sc.flags || "i" } });
    } else if (sc.type === "json") {
      scorersOut.push({
        type: "json", weight: 1,
        config: { requiredKeys: (sc.requiredKeysText || "").split(",").map(s => s.trim()).filter(Boolean) },
      });
    } else if (sc.type === "llm_judge") {
      scorersOut.push({
        type: "llm_judge", weight: 1,
        config: {
          agent: sc.judgeAgent || "",
          rubric: sc.rubric || "",
          threshold: Number(sc.threshold) || 0.7,
        },
      });
    }
  }
  return { scorers: scorersOut, expected };
}

onMounted(reloadSuites);
</script>

<style scoped>
.ev-page .page-header { display: flex; align-items: center; }
.ev-pre {
  white-space: pre-wrap;
  background: #fafafa;
  border-radius: 4px;
  padding: 8px;
  margin: 4px 0;
  font-size: 12px;
  max-height: 200px;
  overflow: auto;
}
.app-toolbar { background: #f5f5f5; min-height: 36px; }
</style>
