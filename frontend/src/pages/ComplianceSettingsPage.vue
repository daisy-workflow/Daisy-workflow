<!--
  Compliance & data residency (Phase F) — workspace-admin page under
  /admin?view=compliance.

  Three concerns on one page:
    1. Mode + residency picker (top)
    2. "What's enforced" panel (right) — read from /compliance
    3. Data-subject actions (bottom) — list users + Export / Erase per
       row + recent erasure log

  Data-subject actions only appear when the current mode has them
  enabled (GDPR by default).
-->
<template>
  <div class="page q-pa-md cs-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Compliance &amp; data residency</div>
        <div class="text-caption text-grey-7">
          Workspace-wide compliance mode + data-residency region.
          Changes here gate provider configs, guardrail policies, and
          which features (URL fetches etc.) are allowed.
        </div>
      </div>
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <div class="row q-col-gutter-md">
      <!-- Mode + residency form -->
      <div class="col-12 col-md-6">
        <q-card flat bordered>
          <q-toolbar class="app-toolbar">
            <q-icon name="policy" class="q-mr-sm" />
            <q-toolbar-title>Workspace policy</q-toolbar-title>
          </q-toolbar>
          <q-separator />
          <q-card-section>
            <q-select
              v-model="form.mode"
              :options="modeOptions" emit-value map-options
              outlined dense label="Compliance mode" class="q-mb-sm"
            />
            <div class="text-caption text-grey-7 q-mb-md">
              {{ activeMode?.description }}
            </div>

            <q-select
              v-model="form.residency"
              :options="regionOptions" emit-value map-options
              outlined dense label="Data residency"
              hint="Restricts which provider endpoints are allowed."
              class="q-mb-md"
            />

            <q-separator class="q-my-sm" />
            <div class="text-subtitle2 q-mb-xs">Contacts</div>
            <q-input
              v-model="form.settings.gdprDpoEmail"
              outlined dense label="GDPR Data Protection Officer email"
              class="q-mb-sm"
            />
            <q-input
              v-model="form.settings.hipaaContactEmail"
              outlined dense label="HIPAA officer email"
              class="q-mb-sm"
            />
            <q-input
              v-model="form.settings.customMessage"
              outlined dense type="textarea" autogrow
              label="Custom compliance message (shown on the workspace dashboard)"
            />
          </q-card-section>
          <q-card-actions align="right" class="q-pa-md">
            <q-btn unelevated color="primary" no-caps icon="save"
              label="Save" :loading="saving" @click="onSave"
            />
          </q-card-actions>
        </q-card>
      </div>

      <!-- Enforcement summary -->
      <div class="col-12 col-md-6">
        <q-card flat bordered>
          <q-toolbar class="app-toolbar">
            <q-icon name="verified_user" class="q-mr-sm" />
            <q-toolbar-title>What's enforced</q-toolbar-title>
          </q-toolbar>
          <q-separator />
          <q-card-section v-if="enforced">
            <div class="text-subtitle2 q-mb-xs">Allowed providers</div>
            <div class="q-mb-md">
              <q-chip v-for="p in enforced.allowedProviders || []" :key="p" dense square>{{ p }}</q-chip>
              <span v-if="!enforced.allowedProviders" class="text-grey-7">No restriction (any provider).</span>
            </div>

            <div class="text-subtitle2 q-mb-xs">Required guardrails</div>
            <div class="q-mb-md">
              <template v-if="enforced.requiredGuardrails && Object.keys(enforced.requiredGuardrails).length">
                <q-chip v-for="(req, k) in enforced.requiredGuardrails" :key="k" dense square color="positive" text-color="white">
                  {{ k }} = {{ req.mode || '(enabled)' }}
                </q-chip>
              </template>
              <span v-else class="text-grey-7">None enforced.</span>
            </div>

            <div class="text-subtitle2 q-mb-xs">Disabled features</div>
            <div class="q-mb-md">
              <template v-if="disabledFeatures.length">
                <q-chip v-for="f in disabledFeatures" :key="f" dense square color="negative" text-color="white">
                  {{ f }}
                </q-chip>
              </template>
              <span v-else class="text-grey-7">All features available.</span>
            </div>

            <div class="text-subtitle2 q-mb-xs">Audit retention</div>
            <div class="q-mb-md">
              {{ enforced.auditRetentionDays }} days
              ({{ (enforced.auditRetentionDays / 365).toFixed(1) }} years)
            </div>

            <div class="text-subtitle2 q-mb-xs">Data-subject endpoints</div>
            <div>
              <q-chip dense square :color="enforced.endpoints?.export ? 'positive' : 'grey-5'" text-color="white">
                export {{ enforced.endpoints?.export ? '✓' : '—' }}
              </q-chip>
              <q-chip dense square :color="enforced.endpoints?.erasure ? 'positive' : 'grey-5'" text-color="white">
                erasure {{ enforced.endpoints?.erasure ? '✓' : '—' }}
              </q-chip>
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <!-- Data-subject actions -->
    <q-card v-if="enforced?.endpoints?.export || enforced?.endpoints?.erasure"
      flat bordered class="q-mt-md"
    >
      <q-toolbar class="app-toolbar">
        <q-icon name="person" class="q-mr-sm" />
        <q-toolbar-title>Data-subject actions</q-toolbar-title>
      </q-toolbar>
      <q-separator />
      <q-card-section>
        <q-input
          v-model="userQuery"
          outlined dense
          label="User email" hint="Type an exact email to export or erase that user's data."
          @keydown.enter.prevent="onLookup"
          class="q-mb-sm"
        />
        <q-btn flat dense color="primary" no-caps icon="search" label="Look up" @click="onLookup" />
        <div v-if="lookupResult" class="q-mt-md">
          <q-banner class="bg-blue-1 text-blue-9">
            <template v-slot:avatar><q-icon name="info" /></template>
            User: <code>{{ lookupResult.email }}</code> · role {{ lookupResult.role }} · status {{ lookupResult.status }}
            <template v-slot:action>
              <q-btn
                v-if="enforced.endpoints.export"
                flat dense no-caps icon="download" label="Export"
                @click="onExport(lookupResult)"
              />
              <q-btn
                v-if="enforced.endpoints.erasure"
                flat dense no-caps icon="delete_forever" color="negative" label="Erase"
                @click="onErase(lookupResult)"
              />
            </template>
          </q-banner>
        </div>
        <div v-if="lookupError" class="text-negative q-mt-sm">{{ lookupError }}</div>
      </q-card-section>

      <q-separator />
      <q-toolbar class="app-toolbar">
        <q-icon name="history" class="q-mr-sm" />
        <q-toolbar-title>Erasure log</q-toolbar-title>
        <q-btn flat dense icon="refresh" @click="reloadErasureLog" />
      </q-toolbar>
      <q-list separator>
        <q-item v-for="row in erasureLog" :key="row.id">
          <q-item-section avatar>
            <q-icon name="person_remove" color="negative" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ row.user_email_at_erasure }}</q-item-label>
            <q-item-label caption>
              {{ new Date(row.created_at).toLocaleString() }}
              · memories deleted: {{ row.details?.memories ?? 0 }}
              · audit rows anonymised: {{ row.details?.audit_anon ?? 0 }}
              <span v-if="row.reason"> · reason: {{ row.reason }}</span>
            </q-item-label>
          </q-item-section>
        </q-item>
        <q-item v-if="!erasureLog.length">
          <q-item-section class="text-grey-7 text-center">No erasures recorded.</q-item-section>
        </q-item>
      </q-list>
    </q-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { Compliance, Users } from "../api/client.js";

const $q = useQuasar();

const loadError = ref("");
const saving    = ref(false);
const modes     = ref([]);
const regions   = ref([]);
const enforced  = ref(null);

const form = reactive({
  mode:      "none",
  residency: "global",
  settings:  { gdprDpoEmail: "", hipaaContactEmail: "", customMessage: "" },
});

const modeOptions   = computed(() => modes.value.map(m => ({ label: m.label, value: m.key })));
const regionOptions = computed(() => regions.value.map(r => ({ label: r.label, value: r.key })));
const activeMode    = computed(() => modes.value.find(m => m.key === form.mode));
const disabledFeatures = computed(() => {
  if (!enforced.value?.features) return [];
  return Object.entries(enforced.value.features).filter(([, v]) => v === false).map(([k]) => k);
});

async function reload() {
  loadError.value = "";
  try {
    const [catalog, current] = await Promise.all([Compliance.modes(), Compliance.get()]);
    modes.value   = catalog.modes;
    regions.value = catalog.regions;
    form.mode      = current.mode;
    form.residency = current.residency;
    form.settings  = {
      gdprDpoEmail:      current.settings?.gdprDpoEmail || "",
      hipaaContactEmail: current.settings?.hipaaContactEmail || "",
      customMessage:     current.settings?.customMessage || "",
    };
    enforced.value = current.enforced;
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message;
  }
}

async function onSave() {
  saving.value = true;
  try {
    await Compliance.set({
      mode:      form.mode,
      residency: form.residency,
      settings:  form.settings,
    });
    $q.notify({ type: "positive", message: "Compliance saved" });
    await reload();
    await reloadErasureLog();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { saving.value = false; }
}

// ─── Data-subject lookup ───────────────────────────────
const userQuery    = ref("");
const lookupResult = ref(null);
const lookupError  = ref("");

async function onLookup() {
  lookupError.value = ""; lookupResult.value = null;
  if (!userQuery.value.trim()) return;
  try {
    const all = await Users.list();
    const found = (all || []).find(u => u.email?.toLowerCase() === userQuery.value.trim().toLowerCase());
    if (!found) {
      lookupError.value = "No user with that email in this workspace.";
      return;
    }
    lookupResult.value = found;
  } catch (e) {
    lookupError.value = e?.response?.data?.message || e.message;
  }
}

async function onExport(user) {
  try {
    const data = await Compliance.exportUser(user.id);
    // Browser-side download — no server-side temp file required.
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `user-${user.id}-export.json`; a.click();
    URL.revokeObjectURL(url);
    $q.notify({ type: "positive", message: "Export downloaded" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

async function onErase(user) {
  $q.dialog({
    title:   "Erase user data?",
    message: `“${user.email}” will be anonymised. Memories will be deleted. Audit log entries will be retained with the email anonymised. This is irreversible.`,
    prompt:  { model: "", label: "Reason (optional, recorded in the erasure log)" },
    ok:      { label: "Erase", color: "negative", noCaps: true },
    cancel:  { label: "Cancel", flat: true, noCaps: true },
    persistent: true,
  }).onOk(async (reason) => {
    try {
      const r = await Compliance.eraseUser(user.id, { reason });
      $q.notify({
        type: "positive",
        message: `Erased: ${r.counts.memories} memories, ${r.counts.audit_anon} audit rows anonymised`,
      });
      userQuery.value = ""; lookupResult.value = null;
      await reloadErasureLog();
    } catch (e) {
      $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
    }
  });
}

// ─── Erasure log ──────────────────────────────────────
const erasureLog = ref([]);
async function reloadErasureLog() {
  try { erasureLog.value = await Compliance.erasureLog({ limit: 100 }); }
  catch { erasureLog.value = []; }
}

onMounted(async () => {
  await reload();
  await reloadErasureLog();
});
</script>

<style scoped>
.cs-page .page-header { display: flex; align-items: center; }
.app-toolbar { min-height: 36px; padding-right:0px!important; }
</style>
