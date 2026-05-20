<!--
  Model Routes (Phase E) — named indirections from a workflow node to
  an agent. Three strategies:

    • static    — pin one agent. Swap models project-wide by editing
                   the route, not every workflow.
    • tier      — three slots (cheap / balanced / strong). The caller
                   picks a tier at call time; the route resolves to the
                   bound agent.
    • fallback  — ordered chain; the dispatcher retries down the list
                   on non-fatal errors.

  Layout matches Prompt Templates: left list + inline editor on the right.
-->
<template>
  <div class="page q-pa-md mr-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Model routes</div>
        <div class="text-caption text-grey-7">
          Named indirections from a workflow node to an agent. Wire
          <code>model.route</code> nodes against these so swapping
          models is a one-edit change.
        </div>
      </div>
      <q-space />
      <q-btn color="primary" unelevated no-caps icon="add" label="New route" @click="openCreate" />
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
              v-for="r in rows" :key="r.id"
              clickable :active="selected?.id === r.id"
              active-class="mr-active"
              @click="select(r)"
            >
              <q-item-section>
                <q-item-label>
                  {{ r.title }}
                  <q-chip dense square size="10px"
                    :color="strategyColor(r.strategy)" text-color="white" class="q-ml-xs"
                  >{{ r.strategy }}</q-chip>
                </q-item-label>
                <q-item-label v-if="r.description" caption>{{ r.description }}</q-item-label>
              </q-item-section>
            </q-item>
            <q-item v-if="!rows.length">
              <q-item-section class="text-grey-7 text-center">No routes yet.</q-item-section>
            </q-item>
          </q-list>
        </q-card>
      </div>

      <!-- editor -->
      <div class="col-12 col-md-8">
        <q-card v-if="selected" flat bordered>
          <q-toolbar class="app-toolbar">
            <q-icon name="alt_route" class="q-mr-sm" />
            <q-toolbar-title>{{ selected.title }}</q-toolbar-title>
            <q-btn flat dense icon="delete" color="negative" @click="onDelete">
              <q-tooltip>Delete</q-tooltip>
            </q-btn>
          </q-toolbar>
          <q-separator />
          <q-card-section>
            <q-input v-model="editForm.title" outlined dense label="Title" class="q-mb-sm" />
            <q-input v-model="editForm.description" outlined dense label="Description" class="q-mb-sm" />
            <q-select
              v-model="editForm.strategy"
              :options="['static','tier','fallback']"
              outlined dense label="Strategy"
              class="q-mb-md"
              @update:model-value="onStrategyChange"
            />

            <!-- Per-strategy editor -->
            <template v-if="editForm.strategy === 'static'">
              <q-select
                v-model="editForm.config.agent"
                :options="agentOptions" emit-value map-options
                outlined dense label="Agent"
                hint="Every model.route call lands on this agent."
              />
            </template>

            <template v-else-if="editForm.strategy === 'tier'">
              <div class="text-caption text-grey-7 q-mb-xs">
                Define one or more tiers (typically cheap / balanced / strong).
                The caller picks via the <code>tier</code> input on the
                <code>model.route</code> node; falls back to the default below.
              </div>
              <div v-for="(t, i) in editForm.config.tiersList" :key="i" class="row q-col-gutter-sm q-mb-sm">
                <div class="col-3">
                  <q-input v-model="t.name" outlined dense label="Tier name" />
                </div>
                <div class="col-7">
                  <q-select
                    v-model="t.agent" :options="agentOptions"
                    emit-value map-options outlined dense label="Agent"
                  />
                </div>
                <div class="col-2 text-right">
                  <q-btn flat dense icon="delete" color="negative"
                    @click="editForm.config.tiersList.splice(i, 1)"
                  />
                </div>
              </div>
              <q-btn flat dense color="primary" no-caps icon="add" label="Tier"
                @click="editForm.config.tiersList.push({ name: '', agent: '' })"
              />
              <q-select
                v-model="editForm.config.default"
                :options="tierNameOptions" emit-value map-options
                outlined dense label="Default tier" class="q-mt-sm"
              />
            </template>

            <template v-else-if="editForm.strategy === 'fallback'">
              <div class="text-caption text-grey-7 q-mb-xs">
                Try in order; on error (non-fatal) the dispatcher tries the next.
                Guardrail blocks and quota errors don't trigger fallback.
              </div>
              <div v-for="(c, i) in editForm.config.chain" :key="i" class="row q-col-gutter-sm q-mb-sm items-center">
                <div class="col-1 text-grey-7">#{{ i + 1 }}</div>
                <div class="col-9">
                  <q-select
                    v-model="editForm.config.chain[i]"
                    :options="agentOptions" emit-value map-options
                    outlined dense :label="`Agent ${i + 1}`"
                  />
                </div>
                <div class="col-2 text-right">
                  <q-btn flat dense icon="delete" color="negative"
                    @click="editForm.config.chain.splice(i, 1)"
                  />
                </div>
              </div>
              <q-btn flat dense color="primary" no-caps icon="add" label="Agent"
                @click="editForm.config.chain.push('')"
              />
            </template>

            <q-btn unelevated color="primary" no-caps icon="save"
              label="Save" :loading="saving" :disable="!canSave"
              class="q-mt-md"
              @click="onSave"
            />
          </q-card-section>
        </q-card>
        <q-banner v-else class="bg-blue-1 text-blue-9">
          Pick a route on the left to edit it, or create a new one.
        </q-banner>
      </div>
    </div>

    <!-- Create dialog -->
    <q-dialog v-model="createOpen" persistent>
      <q-card style="min-width: 460px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="add" class="q-mr-sm" />
          <q-toolbar-title>New model route</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input v-model="newForm.title" outlined dense label="Title" class="q-mb-sm" />
          <q-input v-model="newForm.description" outlined dense label="Description (optional)" class="q-mb-sm" />
          <q-select v-model="newForm.strategy" :options="['static','tier','fallback']"
            outlined dense label="Strategy" class="q-mb-sm"
          />
          <div class="text-caption text-grey-7">
            Strategy details get filled in after creation.
          </div>
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn unelevated color="primary" no-caps label="Create"
            :loading="creating" :disable="!newForm.title"
            @click="onCreate"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { ModelRoutes, Agents } from "../api/client.js";

const $q = useQuasar();

const rows         = ref([]);
const loadError    = ref("");
const selected     = ref(null);
const saving       = ref(false);
const agentOptions = ref([]);

const editForm = reactive({
  title: "", description: "", strategy: "static",
  // Per-strategy in-memory editor state. We translate to + from the
  // API's `config` shape on load/save (tiers is an object on the
  // server but a list-of-{name,agent} in the editor for ordering).
  config: { agent: "", tiersList: [], default: "balanced", chain: [""] },
});

const tierNameOptions = computed(() =>
  (editForm.config.tiersList || []).map(t => t.name).filter(Boolean).map(n => ({ label: n, value: n })),
);

const canSave = computed(() => {
  if (!editForm.title?.trim()) return false;
  if (editForm.strategy === "static")   return !!editForm.config.agent;
  if (editForm.strategy === "tier")     return editForm.config.tiersList.length > 0 && editForm.config.tiersList.every(t => t.name && t.agent);
  if (editForm.strategy === "fallback") return editForm.config.chain.filter(Boolean).length > 0;
  return false;
});

// ─── load ─────────────────────────────────────────
async function reload() {
  loadError.value = "";
  try {
    [rows.value, agentOptions.value] = await Promise.all([
      ModelRoutes.list(),
      Agents.list().then(list => list.map(a => ({ label: a.title, value: a.title }))),
    ]);
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message;
  }
}

async function select(r) {
  selected.value = r;
  try {
    const full = await ModelRoutes.get(r.id);
    selected.value = full;
    editForm.title = full.title;
    editForm.description = full.description || "";
    editForm.strategy = full.strategy;
    hydrateConfig(full.strategy, full.config || {});
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

function hydrateConfig(strategy, c) {
  if (strategy === "static") {
    editForm.config.agent = c.agent || "";
  } else if (strategy === "tier") {
    editForm.config.tiersList = Object.entries(c.tiers || {}).map(([name, agent]) => ({ name, agent }));
    editForm.config.default = c.default || (editForm.config.tiersList[0]?.name || "");
  } else if (strategy === "fallback") {
    editForm.config.chain = Array.isArray(c.chain) && c.chain.length ? [...c.chain] : [""];
  }
}

function dehydrateConfig() {
  if (editForm.strategy === "static") {
    return { agent: editForm.config.agent };
  }
  if (editForm.strategy === "tier") {
    const tiers = {};
    for (const t of editForm.config.tiersList) {
      if (t.name && t.agent) tiers[t.name] = t.agent;
    }
    return { tiers, default: editForm.config.default || Object.keys(tiers)[0] };
  }
  if (editForm.strategy === "fallback") {
    return { chain: editForm.config.chain.filter(Boolean) };
  }
  return {};
}

function onStrategyChange(s) {
  // Reset editor state to match the new strategy's shape; preserves
  // accidental cross-talk between editors when the user switches.
  if (s === "static")   editForm.config = { ...editForm.config, agent: "" };
  if (s === "tier")     editForm.config = { ...editForm.config, tiersList: [{ name: "balanced", agent: "" }], default: "balanced" };
  if (s === "fallback") editForm.config = { ...editForm.config, chain: [""] };
}

async function onSave() {
  saving.value = true;
  try {
    await ModelRoutes.update(selected.value.id, {
      title: editForm.title.trim(),
      description: editForm.description || null,
      strategy: editForm.strategy,
      config: dehydrateConfig(),
    });
    $q.notify({ type: "positive", message: "Saved" });
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { saving.value = false; }
}

async function onDelete() {
  $q.dialog({
    title: "Delete route?",
    message: `“${selected.value.title}” — workflows referencing this route by title will start failing until they're rewired.`,
    ok: { label: "Delete", color: "negative", noCaps: true },
    cancel: { label: "Cancel", flat: true, noCaps: true },
    persistent: true,
  }).onOk(async () => {
    try { await ModelRoutes.remove(selected.value.id); selected.value = null; await reload(); }
    catch (e) { $q.notify({ type: "negative", message: e?.response?.data?.message || e.message }); }
  });
}

// ─── create ────────────────────────────────────────
const createOpen = ref(false);
const creating   = ref(false);
const newForm    = reactive({ title: "", description: "", strategy: "static" });

function openCreate() {
  newForm.title = ""; newForm.description = ""; newForm.strategy = "static";
  createOpen.value = true;
}

async function onCreate() {
  creating.value = true;
  try {
    // Seed sensible defaults so the new row is valid on create. The
    // user fills in the details in the editor right after.
    const seedConfig = newForm.strategy === "static"
      ? { agent: "PLACEHOLDER" }
      : newForm.strategy === "tier"
        ? { tiers: { balanced: "PLACEHOLDER" }, default: "balanced" }
        : { chain: ["PLACEHOLDER"] };
    await ModelRoutes.create({
      title: newForm.title.trim(),
      description: newForm.description || null,
      strategy: newForm.strategy,
      config: seedConfig,
    });
    createOpen.value = false;
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { creating.value = false; }
}

// ─── helpers ───────────────────────────────────────
function strategyColor(s) {
  return { static: "blue-7", tier: "teal-7", fallback: "orange-9" }[s] || "grey-7";
}

onMounted(reload);
</script>

<style scoped>
.mr-page .page-header { display: flex; align-items: center; }
.mr-active { background: #eef5ff; }
.app-toolbar { background: #f5f5f5; min-height: 36px; }
</style>
