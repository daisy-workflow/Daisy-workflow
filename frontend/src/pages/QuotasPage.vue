<!--
  Project quotas — view + admin.

  Everyone with quota.read (project admin + editor + workspace admin)
  sees the current usage and limits. Only workspace admins (quota.write)
  can change them — the toggle / edit controls are gated client-side
  to match.

  Three quota kinds in v1:
    • tokens_per_month   — agent token consumption per calendar month
    • executions_per_day — workflows started per UTC day
    • storage_bytes      — schema-only in v1, displayed for parity
                           (the runtime doesn't enforce it yet)
-->
<template>
  <div class="page q-pa-md quotas-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Project quotas</div>
        <div class="text-caption text-grey-7">
          Cap how much this project can consume. Tokens are charged
          when an agent call returns; executions are charged when a
          run is enqueued.
        </div>
      </div>
      <q-space />
      <q-btn icon="refresh" flat dense @click="reload" />
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <div class="row q-col-gutter-md">
      <div v-for="q in rows" :key="q.kind" class="col-12 col-md-6">
        <q-card flat bordered>
          <q-card-section>
            <div class="row items-center q-mb-xs">
              <q-icon :name="iconFor(q.kind)" class="q-mr-sm" />
              <div class="text-subtitle1">{{ labelFor(q.kind) }}</div>
              <q-space />
              <q-chip
                v-if="q.limit === null"
                dense square size="11px" color="grey-6" text-color="white"
              >unlimited</q-chip>
              <q-chip
                v-else-if="q.usage >= q.limit"
                dense square size="11px" color="negative" text-color="white"
              >exceeded</q-chip>
              <q-chip
                v-else-if="q.limit > 0 && q.usage / q.limit > 0.8"
                dense square size="11px" color="warning" text-color="black"
              >near limit</q-chip>
              <q-chip
                v-else-if="q.limit > 0"
                dense square size="11px" color="positive" text-color="white"
              >ok</q-chip>
            </div>
            <div class="text-caption text-grey-7 q-mb-md">{{ descriptionFor(q.kind) }}</div>

            <div class="row items-baseline q-mb-xs">
              <div class="text-h6">{{ formatValue(q.kind, q.usage) }}</div>
              <div class="q-mx-sm text-grey-7">used of</div>
              <div class="text-h6">
                <template v-if="q.limit !== null">{{ formatValue(q.kind, q.limit) }}</template>
                <template v-else>∞</template>
              </div>
            </div>
            <q-linear-progress
              v-if="q.limit !== null && q.limit > 0"
              :value="Math.min(1, q.usage / q.limit)"
              :color="barColor(q)"
              size="8px" rounded
              class="q-mb-xs"
            />
            <div class="text-caption text-grey-7">
              Period: {{ periodLabel(q.period) }}
              <template v-if="q.kind === 'storage_bytes'">
                <q-chip dense square size="10px" color="grey-5" text-color="white" class="q-ml-sm">
                  enforcement WIP
                </q-chip>
              </template>
            </div>
          </q-card-section>

          <q-separator />

          <q-card-actions class="q-pa-md" v-if="canEdit">
            <q-input
              :model-value="editValues[q.kind]"
              @update:model-value="(v) => editValues[q.kind] = v"
              dense outlined type="number" min="0"
              :label="q.limit === null ? 'Set a limit' : 'Update limit'"
              style="max-width: 220px;"
            />
            <q-space />
            <q-btn
              v-if="q.limit !== null"
              flat no-caps icon="close" label="Remove"
              color="negative"
              @click="onUnset(q)"
            />
            <q-btn
              unelevated no-caps color="primary"
              :label="q.limit === null ? 'Set' : 'Save'"
              :disable="!isValidLimitInput(editValues[q.kind])"
              @click="onSet(q)"
            />
          </q-card-actions>
        </q-card>
      </div>
    </div>

    <q-banner v-if="!canEdit" class="bg-blue-1 text-blue-9 q-mt-md">
      <template v-slot:avatar><q-icon name="info" /></template>
      Only workspace admins can change quotas. You're seeing the
      project's current usage in read-only mode.
    </q-banner>

    <!-- Per-model + per-agent breakdowns ─────────────────────── -->
    <div class="row q-col-gutter-md q-mt-md">
      <div class="col-12 col-md-7">
        <q-card flat bordered>
          <q-card-section>
            <div class="row items-center q-mb-sm">
              <q-icon name="psychology" class="q-mr-sm" />
              <div class="text-subtitle1">Spend by model</div>
              <q-space />
              <q-btn-toggle
                v-model="windowDays"
                :options="[
                  { label: 'Month-to-date', value: 0 },
                  { label: '7d',  value: 7  },
                  { label: '30d', value: 30 },
                ]"
                dense unelevated no-caps size="sm"
                color="grey-3" text-color="grey-9"
                toggle-color="primary" toggle-text-color="white"
                @update:model-value="loadBreakdowns"
              />
            </div>
            <div class="text-caption text-grey-7 q-mb-sm">
              Total this {{ windowDays === 0 ? "month" : `${windowDays} days` }}:
              <b>{{ formatDollars(totalCostMicros) }}</b>
              · {{ Intl.NumberFormat().format(totalTokens) }} tokens
              · {{ totalCalls }} calls
              <span v-if="cacheSavingsMicros > 0" class="q-ml-sm text-positive">
                · saved {{ formatDollars(cacheSavingsMicros) }} from cache
              </span>
            </div>
            <q-table
              :rows="modelRows"
              :columns="modelColumns"
              row-key="model"
              flat dense
              hide-pagination
              :pagination="{ rowsPerPage: 0 }"
              :loading="loadingBreakdown"
            >
              <template v-slot:body-cell-cost="props">
                <q-td :props="props">{{ formatDollars(props.row.cost_micros) }}</q-td>
              </template>
              <template v-slot:body-cell-tokens="props">
                <q-td :props="props">
                  {{ Intl.NumberFormat().format(Number(props.row.input_tokens) + Number(props.row.output_tokens)) }}
                </q-td>
              </template>
              <template v-slot:body-cell-cache_hits="props">
                <q-td :props="props">
                  <span v-if="props.row.cache_hits">
                    {{ props.row.cache_hits }} / {{ props.row.calls }}
                  </span>
                  <span v-else class="text-grey-5">—</span>
                </q-td>
              </template>
              <template v-slot:body-cell-latency="props">
                <q-td :props="props">
                  <span v-if="props.row.avg_latency_ms != null">
                    {{ Math.round(props.row.avg_latency_ms) }}ms
                  </span>
                  <span v-else class="text-grey-5">—</span>
                </q-td>
              </template>
            </q-table>
            <div v-if="!loadingBreakdown && modelRows.length === 0" class="text-caption text-grey-6 q-mt-sm">
              No agent calls yet in this window.
            </div>
          </q-card-section>
        </q-card>
      </div>

      <div class="col-12 col-md-5">
        <q-card flat bordered>
          <q-card-section>
            <div class="row items-center q-mb-sm">
              <q-icon name="smart_toy" class="q-mr-sm" />
              <div class="text-subtitle1">Spend by agent</div>
            </div>
            <q-table
              :rows="agentRows"
              :columns="agentColumns"
              row-key="agent_title"
              flat dense
              hide-pagination
              :pagination="{ rowsPerPage: 0 }"
              :loading="loadingBreakdown"
            >
              <template v-slot:body-cell-cost="props">
                <q-td :props="props">{{ formatDollars(props.row.cost_micros) }}</q-td>
              </template>
            </q-table>
            <div v-if="!loadingBreakdown && agentRows.length === 0" class="text-caption text-grey-6 q-mt-sm">
              No agent calls yet in this window.
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { Quotas } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const loading   = ref(false);
const loadError = ref("");
const editValues = reactive({});   // kind → current input value (string|number)

// quota.write is workspace-admin only on the server. We mirror that
// guard client-side so the controls only render for users who can
// actually mutate. Non-admins still see the usage / limit panels.
const canEdit = computed(() => auth.isWorkspaceAdmin || auth.user?.role === "admin");

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    rows.value = await Quotas.list();
    // Prime the input fields with the current limits so the admin can
    // tweak a value in-place rather than typing the full number again.
    for (const r of rows.value) {
      editValues[r.kind] = r.limit ?? "";
    }
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message || "load failed";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  if (!auth.activeProjectId) {
    const picked = await auth.ensureActiveProject();
    if (!picked) { router.replace({ name: "home" }); return; }
  }
  await reload();
  await loadBreakdowns();
});

// ── Per-model / per-agent breakdowns ────────────────────────
const windowDays         = ref(0);            // 0 = month-to-date
const loadingBreakdown   = ref(false);
const modelRows          = ref([]);
const agentRows          = ref([]);

const modelColumns = [
  { name: "provider", label: "Provider", field: "provider", align: "left",  style: "width: 120px;" },
  { name: "model",    label: "Model",    field: "model",    align: "left" },
  { name: "calls",    label: "Calls",    field: "calls",    align: "right", style: "width: 70px;" },
  { name: "cache_hits", label: "Cached", align: "left",  style: "width: 90px;" },
  { name: "tokens",   label: "Tokens",   align: "right", style: "width: 110px;" },
  { name: "latency",  label: "p50 ms",   align: "right", style: "width: 80px;" },
  { name: "cost",     label: "Spend",    align: "right", style: "width: 110px;" },
];
const agentColumns = [
  { name: "agent_title", label: "Agent", field: "agent_title", align: "left" },
  { name: "calls",       label: "Calls", field: "calls",       align: "right", style: "width: 70px;" },
  { name: "cost",        label: "Spend", align: "right", style: "width: 110px;" },
];

const totalCostMicros = computed(() =>
  modelRows.value.reduce((s, r) => s + Number(r.cost_micros || 0), 0),
);
const totalTokens = computed(() =>
  modelRows.value.reduce((s, r) =>
    s + Number(r.input_tokens || 0) + Number(r.output_tokens || 0), 0),
);
const totalCalls = computed(() =>
  modelRows.value.reduce((s, r) => s + Number(r.calls || 0), 0),
);
// "What we would have spent without the cache": tokens × rate for the
// cache_hits portion. The events table tracks input/output tokens for
// cached rows too (cost_micros is zero, but the original would-have-
// spent figure lives on the un-cached neighbours). We approximate by
// scaling the un-cached cost by (cache_hits / non_cached_calls).
const cacheSavingsMicros = computed(() => {
  let saved = 0;
  for (const r of modelRows.value) {
    const nonCached = (r.calls || 0) - (r.cache_hits || 0);
    if (nonCached > 0 && r.cache_hits > 0) {
      const perCallMicros = Number(r.cost_micros || 0) / nonCached;
      saved += perCallMicros * r.cache_hits;
    }
  }
  return Math.round(saved);
});

async function loadBreakdowns() {
  loadingBreakdown.value = true;
  try {
    const params = windowDays.value ? { days: windowDays.value } : {};
    const [m, a] = await Promise.all([
      Quotas.usageByModel(params),
      Quotas.usageByAgent(params),
    ]);
    modelRows.value = m.rows || [];
    agentRows.value = a.rows || [];
  } catch (e) {
    $q.notify({
      type: "negative",
      message: `Couldn't load usage breakdown: ${e?.response?.data?.message || e.message}`,
      position: "bottom",
    });
    modelRows.value = [];
    agentRows.value = [];
  } finally {
    loadingBreakdown.value = false;
  }
}

function formatDollars(micros) {
  const d = (Number(micros) || 0) / 1_000_000;
  if (d === 0)    return "$0.00";
  if (d < 0.01)   return `$${d.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (d < 1)      return `$${d.toFixed(4)}`;
  if (d < 1000)   return `$${d.toFixed(2)}`;
  return `$${Intl.NumberFormat().format(Math.round(d))}`;
}

// ── Mutations ──────────────────────────────────────────────
async function onSet(q) {
  const raw = editValues[q.kind];
  const limit = Math.floor(Number(raw));
  if (!isValidLimitInput(raw)) return;
  try {
    await Quotas.set(q.kind, limit);
    await reload();
    $q.notify({ type: "positive", message: "Quota updated", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

async function onUnset(q) {
  try {
    await Quotas.unset(q.kind);
    await reload();
    $q.notify({ type: "positive", message: "Quota removed (now unlimited)", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  }
}

// ── Helpers ─────────────────────────────────────────────────
function isValidLimitInput(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && v !== "" && v !== null;
}

function iconFor(kind) {
  if (kind === "tokens_per_month")   return "psychology";
  if (kind === "executions_per_day") return "play_circle";
  if (kind === "storage_bytes")      return "storage";
  return "data_usage";
}

function labelFor(kind) {
  if (kind === "tokens_per_month")   return "AI tokens per month";
  if (kind === "executions_per_day") return "Executions per day";
  if (kind === "storage_bytes")      return "Storage";
  return kind;
}

function descriptionFor(kind) {
  if (kind === "tokens_per_month")
    return "Sum of input + output tokens across every agent call this calendar month.";
  if (kind === "executions_per_day")
    return "Workflows started in the active project. Counts both manual runs and trigger-fired runs.";
  if (kind === "storage_bytes")
    return "Total bytes of execution + memory data persisted for the project. v1: not yet enforced — usage is reported when a sweeper job lands.";
  return "";
}

function periodLabel(p) {
  if (p === "month") return "calendar month (resets on the 1st)";
  if (p === "day")   return "UTC day (resets at 00:00 UTC)";
  return "no period — running total";
}

function formatValue(kind, n) {
  if (kind === "storage_bytes") return formatBytes(n);
  return Intl.NumberFormat().format(n);
}
function formatBytes(b) {
  if (b < 1024)            return `${b} B`;
  if (b < 1024 * 1024)     return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)       return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function barColor(q) {
  if (!q.limit) return "primary";
  const ratio = q.usage / q.limit;
  if (ratio >= 1)  return "negative";
  if (ratio >= 0.8) return "warning";
  return "primary";
}
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
</style>
