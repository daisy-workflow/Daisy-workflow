<template>
    <q-layout view="hHh lpR fFf">
        <q-header class="app-header">
            <q-toolbar class="app-toolbar">
                  <q-btn
                    flat round dense
                    icon="arrow_back"
                    class="btn-toolbar q-mr-sm"
                    @click="goBack"
                >
                    <q-tooltip>Back</q-tooltip>
                </q-btn>
                <q-toolbar-title>
                    {{ isNew ? "New flow" : model.name }}
                    <span v-if="dirty" class="q-ml-xs text-caption" style="color: var(--warning);">●</span>
                </q-toolbar-title>
                <q-space />

                <q-btn flat round dense icon="upload"   class="btn-icon" @click="onImport">
                    <q-tooltip>Import JSON</q-tooltip>
                </q-btn>
                <q-btn flat round dense icon="download" class="btn-icon" @click="onExport">
                    <q-tooltip>Export JSON</q-tooltip>
                </q-btn>
                <q-btn
                    flat round dense
                    icon="archive"
                    class="btn-icon"
                    :disable="isNew || saving || archiving"
                    :loading="archiving"
                    @click="onArchive"
                >
                    <q-tooltip>{{
                        isNew ? "Save the flow once before archiving" : "Archive a snapshot of the current state"
                    }}</q-tooltip>
                </q-btn>
                <q-btn
                    flat round dense
                    icon="history"
                    class="btn-icon"
                    :disable="isNew"
                    @click="historyOpen = true"
                >
                    <q-tooltip>{{
                        isNew ? "Save the flow once before viewing history" : "View archive history"
                    }}</q-tooltip>
                </q-btn>
                <q-btn
                    flat round dense
                    icon="play_arrow"
                    class="btn-icon"
                    :loading="running"
                    :disable="running || saving || isNew"
                    @click="onRunClick"
                >
                    <q-tooltip>{{
                        isNew
                            ? "Save the flow once before running"
                            : "Run with input"
                    }}</q-tooltip>
                </q-btn>
                <q-btn
                    flat round dense
                    icon="save"
                    class="btn-icon-primary"
                    :loading="saving"
                    @click="onSave"
                >
                    <q-tooltip>Save</q-tooltip>
                </q-btn>
            </q-toolbar>

            <!-- Tabs differ by mode:
                   visual mode: Canvas (editable) + JSON (read-only viewer)
                   code mode:   DSL    (editable) + JSON (read-only viewer)
                 No in-editor mode switch — to flip modes the user goes
                 back to HomePage and clicks the other launcher button.
                 That avoids the "did my edits survive the switch?"
                 confusion entirely. -->
            <q-tabs
                v-model="tab"
                dense align="left" no-caps
                active-color="primary"
                indicator-color="primary"
                class="app-tabs"
            >
                <q-tab name="prompt"   label="Prompt" />
                <q-tab name="overview" label="Overview" />
                <q-tab v-if="mode === 'visual'" name="canvas" label="Flow editor" />
                <q-tab v-else                   name="dsl"    label="DSL editor" />
                <q-tab name="json"     label="JSON" />
            </q-tabs>
        </q-header>

        <q-page-container>
            <q-page>
                <q-banner v-if="loadError" dense class="bg-red-10 text-red-2">
                    <template v-slot:avatar><q-icon name="error_outline" /></template>
                    {{ loadError }}
                </q-banner>

                <div v-if="loading" class="row flex-center q-pa-lg">
                    <q-spinner-dots color="primary" size="32px" />
                </div>

                <q-tab-panels v-else v-model="tab" animated keep-alive class="full-tabs">
                    <q-tab-panel name="prompt" class="q-pa-none">
                        <PromptTab v-model="model" />
                    </q-tab-panel>
                    <q-tab-panel name="overview" class="q-pa-none">
                        <OverviewTab v-model="model" />
                    </q-tab-panel>
                    <!-- Only the editor for the current mode is mounted.
                         No CanvasTab in code mode, no DslEditorTab in
                         visual mode — that's how we get rid of the live
                         sync bugs that motivated this split. -->
                    <q-tab-panel v-if="mode === 'visual'" name="canvas" class="q-pa-none">
                        <CanvasTab v-model="model" :plugins="plugins" />
                    </q-tab-panel>
                    <q-tab-panel v-else name="dsl" class="q-pa-none">
                        <DslEditorTab ref="codeEditorRef" v-model="model" :plugins="plugins" />
                    </q-tab-panel>
                    <!-- JSON viewer — read-only in BOTH modes. Lets a
                         power user verify exactly what will be sent to
                         the server, including the non-DSL fields (retry,
                         retryDelay, meta.positions, etc.) that aren't
                         visible in the DSL surface. -->
                    <q-tab-panel name="json" class="q-pa-none">
                        <JsonTab v-model="model" />
                    </q-tab-panel>
                </q-tab-panels>

                <!-- Run dialog — collects optional JSON input then enqueues -->
                <RunDialog v-model="runDialogOpen" :initial="lastRunInput" @submit="onRunSubmit" />

                <!-- History drawer — lists archive snapshots, restore in one click -->
                <q-dialog v-model="historyOpen" position="right" full-height>
                    <q-card style="width: 360px; max-width: 92vw;" class="column no-wrap">
                        <q-toolbar class="app-toolbar">
                            <q-icon name="history" class="q-mr-sm" />
                            <q-toolbar-title>History</q-toolbar-title>
                            <q-btn flat round dense icon="close" v-close-popup />
                        </q-toolbar>
                        <q-separator />
                        <div v-if="historyLoading" class="row flex-center q-pa-lg">
                            <q-spinner-dots color="primary" size="32px" />
                        </div>
                        <div v-else-if="!archives.length"
                             class="text-caption text-grey q-pa-md text-center">
                            No archives yet. Click the
                            <q-icon name="archive" size="14px" class="q-mx-xs" />
                            button to snapshot the current state.
                        </div>
                        <q-list v-else dense separator class="col scroll">
                            <q-item v-for="a in archives" :key="a.id">
                                <q-item-section>
                                    <q-item-label>
                                        {{ new Date(a.archived_at).toLocaleString() }}
                                    </q-item-label>
                                    <q-item-label v-if="a.reason" caption>
                                        {{ a.reason }}
                                    </q-item-label>
                                </q-item-section>
                                <q-item-section side class="row no-wrap q-gutter-xs">
                                    <q-btn
                                        flat dense round size="sm"
                                        icon="download"
                                        :loading="exportingId === a.id"
                                        @click="onExportArchive(a)"
                                    >
                                        <q-tooltip>Export this snapshot as JSON</q-tooltip>
                                    </q-btn>
                                    <q-btn
                                        flat dense round size="sm"
                                        icon="restore"
                                        :loading="restoringId === a.id"
                                        @click="onRestore(a)"
                                    >
                                        <q-tooltip>Restore this snapshot</q-tooltip>
                                    </q-btn>
                                </q-item-section>
                            </q-item>
                        </q-list>
                    </q-card>
                </q-dialog>
            </q-page>
        </q-page-container>
    </q-layout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Plugins } from "../api/client";

import PromptTab from "../components/flow/PromptTab.vue";
import OverviewTab from "../components/flow/OverviewTab.vue";
import CanvasTab from "../components/flow/CanvasTab.vue";
import DslEditorTab from "../components/flow/DslEditorTab.vue";
import JsonTab from "../components/flow/JsonTab.vue";
import RunDialog from "../components/RunDialog.vue";
import {
    emptyModel,
    parseDslToModel,
    serializeModelToDsl,
    pickFileAsText,
    downloadText,
} from "../components/flow/flowModel.js";
import { getFlowMode, setFlowMode } from "../components/flow/flowMode.js";

const route = useRoute();
const router = useRouter();
const $q = useQuasar();

const isNew = computed(() => route.params.id === "new" || !route.params.id);

// Mode is part of the URL. The router declares /:mode(visual|code)? —
// when missing we fall back to the saved per-workflow preference (or
// "visual" if none) and replace the URL so bookmarks survive. There's
// no in-editor mode toggle: once you're in a mode you stay until you
// navigate back to the HomePage and pick the other launcher.
const mode = computed(() => {
    const m = route.params.mode;
    return m === "code" ? "code" : "visual";
});

// Default tab depends on mode:
//   - visual mode: start on Overview (or Prompt for new flows)
//   - code mode:   start on the code editor — the user opted in
//
// The active tab also has to follow mode changes (the visual mode's
// "canvas" tab and code mode's "code" tab are different names), so a
// watch below resets `tab` whenever mode flips.
const tab = ref("overview");
const loading = ref(true);
const saving = ref(false);
const loadError = ref("");
const dirty = ref(false);

// Ref to the mounted DslEditorTab so we can flush in-progress text on
// save. Visual mode leaves this null. The editor exposes applyBuffer()
// via defineExpose — see DslEditorTab.vue.
const codeEditorRef = ref(null);

const model = ref(emptyModel());
const plugins = ref([]);

// ── Run dialog state ───────────────────────────────────────────────────
// `runDialogOpen` toggles the JSON-input dialog. `running` is the loading
// flag that disables the toolbar Run button while we save + enqueue.
// `lastRunInput` is the last successful payload, prefilled into the
// dialog so users running the same flow repeatedly don't have to retype.
const runDialogOpen = ref(false);
const running       = ref(false);
const lastRunInput  = ref({});

// ── Archive / history state ────────────────────────────────────────────
// Archives are explicit snapshots stored server-side. Editor saves no
// longer create rows; only the Archive button does.
const archiving      = ref(false);
const historyOpen    = ref(false);
const historyLoading = ref(false);
const archives       = ref([]);
const restoringId    = ref(null);
// Per-row spinner for the History drawer's Export button. Same
// pattern as restoringId so two simultaneous clicks on different
// archives can both show their own loading state.
const exportingId    = ref(null);

// The text we last successfully saved — used as a cheap dirty-check via
// equality with the current serialised model.
let lastSavedDsl = "";

onMounted(async () => {
    // Plugins (for the canvas palette + property panel autocomplete).
    Plugins.list().then(list => { plugins.value = list || []; }).catch(() => { });

    // Normalise the URL so it always carries the current mode.
    // Bookmarks of /flowDesigner/:id (no mode) bounce through the saved
    // preference. New flows always start in visual mode — no preference
    // for "new" — but we still want /flowDesigner/new/visual in the URL
    // so a refresh stays here.
    if (!route.params.mode) {
        const pref = isNew.value ? "visual" : getFlowMode(route.params.id);
        router.replace({
            path: `/flowDesigner/${route.params.id || "new"}/${pref}`,
            query: route.query,
        });
    }

    // Default tab depends on mode + new-vs-existing.
    if (isNew.value) {
        // New flow: prompt-first UX in either mode.
        tab.value = "prompt";
        lastSavedDsl = serializeModelToDsl(model.value);
        loading.value = false;
        return;
    }
    // Existing flow: drop into the primary editor for the current mode.
    // Code mode → DSL editor; visual mode → Overview (one click from
    // the canvas, but lets users glance at the workflow shape first).
    tab.value = mode.value === "code" ? "dsl" : "overview";

    try {
        const g = await Graphs.get(route.params.id);
        model.value = parseDslToModel(g.dsl);
        lastSavedDsl = g.dsl;
    } catch (e) {
        loadError.value = errMsg(e);
    } finally {
        loading.value = false;
    }
});

// Mode rarely changes mid-session (no in-editor toggle) but it can
// happen when the user navigates from /flowDesigner/:id/visual to
// /flowDesigner/:id/code via a fresh URL paste. Keep `tab` valid for
// the new mode — otherwise the previously-selected tab name wouldn't
// match any rendered panel.
watch(mode, (m) => {
    if (m === "code"   && tab.value === "canvas") tab.value = "dsl";
    if (m === "visual" && tab.value === "dsl")    tab.value = "canvas";
});

// Track whether the model has diverged from the last saved version.
watch(model, (m) => {
    try { dirty.value = serializeModelToDsl(m) !== lastSavedDsl; }
    catch { dirty.value = true; }
}, { deep: true });

// ----- toolbar -----
//
// No in-editor mode toggle by design — see the toolbar template above
// for the rationale. To open this workflow in the other mode, the user
// goes back to HomePage and clicks the launcher button.

async function onSave() {
    // In code mode the textarea may still hold un-applied text. Flush
    // it to the model before serialising — otherwise a Ctrl+S while
    // typing would persist a stale model. Visual mode doesn't need
    // this because CanvasTab commits node/edge changes synchronously.
    if (codeEditorRef.value?.applyBuffer) {
        try { await codeEditorRef.value.applyBuffer({ quiet: true }); }
        catch { /* parse error already surfaced in the editor */ }
    }
    saving.value = true;
    try {
        const dsl = serializeModelToDsl(model.value);
        // Validate first — surfaces parser errors early. The server runs
        // the same parseDag that validates required inputs per plugin
        // (PR #65), so we let it be the source of truth rather than
        // duplicating schema checks on the client. A user typing invalid
        // JSON in the inputs editor will simply have a stale-but-valid
        // object persisted (the last successful parse).
        try { await Graphs.validate(dsl); }
        catch (e) { throw new Error(formatValidationErr(e)); }

        let saved;
        if (isNew.value) saved = await Graphs.create(dsl);
        else saved = await Graphs.update(route.params.id, dsl);

        lastSavedDsl = dsl;
        dirty.value = false;
        $q.notify({ type: "positive", message: `Saved "${saved.name}"`, position: "bottom" });
        // ID is stable for updates; only navigate after a successful create.
        // Preserve the current mode in the new URL so we don't kick the
        // user back to visual mode after a code-mode "first save".
        if (isNew.value) {
            setFlowMode(saved.id, mode.value);
            router.replace({ path: `/flowDesigner/${saved.id}/${mode.value}` });
        }
    } catch (e) {
        $q.notify({ type: "negative", message: `Save failed: ${e.message}`, position: "bottom" });
    } finally {
        saving.value = false;
    }
}

// ── Run flow ────────────────────────────────────────────────────────────
//
// Three steps, each with its own failure mode:
//   1. If the model has unsaved changes, prompt the user to save first.
//      We force a save (which validates server-side) before enqueueing
//      so the execution always runs against a real DB row.
//   2. Open RunDialog so the user can supply JSON input. The dialog
//      handles JSON validation; we receive the parsed value via @submit.
//   3. POST /graphs/:id/execute, then route the user to InstanceViewer
//      for the freshly-enqueued run so they can watch progress.
//
// The toolbar button is disabled while any of these are in flight, and
// also disabled for new (unsaved) flows — Graphs.execute requires an id.
async function onRunClick() {
    if (running.value) return;
    if (isNew.value) {
        $q.notify({
            type: "warning",
            message: "Save the flow once before running it.",
            position: "bottom",
        });
        return;
    }
    if (dirty.value) {
        const ok = await new Promise((resolve) => {
            $q.dialog({
                title: "Unsaved changes",
                message: "Save the flow before running?",
                ok: { label: "Save & run", color: "primary", unelevated: true, "no-caps": true },
                cancel: { label: "Cancel", flat: true, "no-caps": true },
                persistent: true,
            })
                .onOk(() => resolve(true))
                .onDismiss(() => resolve(false));
        });
        if (!ok) return;
        await onSave();
        if (dirty.value) return;          // save failed — bail
    }
    runDialogOpen.value = true;
}

async function onRunSubmit(payload) {
    // RunDialog now emits { context, tags }. Pre-tags callers passed
    // the bare context object — preserve that for any other dialog
    // that still emits the legacy shape.
    const context = (payload && payload.context !== undefined) ? payload.context : (payload || {});
    const tags    = (payload && Array.isArray(payload.tags))   ? payload.tags    : [];
    runDialogOpen.value = false;
    if (!route.params.id || isNew.value) return;
    running.value = true;
    try {
        const result = await Graphs.execute(route.params.id, context, tags);
        lastRunInput.value = context || {};
        $q.notify({
            type: "positive",
            message: `Execution queued (${(result.executionId || "").slice(0, 8)}…)`,
            position: "bottom",
            actions: [{
                label: "Open inspector",
                color: "white",
                handler: () => router.push({ name: "instanceViewer", params: { id: result.executionId } }),
            }],
            timeout: 4000,
        });
        // Route to the read-only instance viewer so the user sees per-node
        // progress as soon as the worker starts the run.
        router.push({ name: "instanceViewer", params: { id: result.executionId } });
    } catch (e) {
        $q.notify({
            type: "negative",
            message: `Run failed: ${errMsg(e)}`,
            position: "bottom",
        });
    } finally {
        running.value = false;
    }
}

// ── Archive / history ──────────────────────────────────────────────────
//
// Archive = explicit user-initiated snapshot copied into archived_graphs
// on the server. Distinct from save, which now always updates in place.
// Restoring an archive overwrites the live row with the snapshot's DSL —
// after restore we re-load the model from the live row so the editor
// reflects the new state.

async function onArchive() {
    if (archiving.value || isNew.value) return;
    if (dirty.value) {
        const ok = await new Promise((resolve) => {
            $q.dialog({
                title: "Unsaved changes",
                message: "Save the flow before archiving the snapshot?",
                ok: { label: "Save & archive", color: "primary", unelevated: true, "no-caps": true },
                cancel: { label: "Cancel", flat: true, "no-caps": true },
                persistent: true,
            })
                .onOk(() => resolve(true))
                .onDismiss(() => resolve(false));
        });
        if (!ok) return;
        await onSave();
        if (dirty.value) return;
    }
    archiving.value = true;
    try {
        const reason = window.prompt("Optional reason / label for this snapshot:") || "";
        const result = await Graphs.archive(route.params.id, reason);
        $q.notify({
            type: "positive",
            message: `Archived snapshot ${(result?.archiveId || "").slice(0, 8)}…`,
            position: "bottom",
        });
        if (historyOpen.value) await loadArchives();
    } catch (e) {
        $q.notify({ type: "negative", message: `Archive failed: ${errMsg(e)}`, position: "bottom" });
    } finally {
        archiving.value = false;
    }
}

async function loadArchives() {
    if (!route.params.id || isNew.value) return;
    historyLoading.value = true;
    try {
        archives.value = await Graphs.archives(route.params.id);
    } catch (e) {
        $q.notify({ type: "negative", message: `Could not load archives: ${errMsg(e)}`, position: "bottom" });
    } finally {
        historyLoading.value = false;
    }
}

watch(historyOpen, (open) => {
    if (open) loadArchives();
});

async function onRestore(archive) {
    if (!archive?.id || restoringId.value) return;
    if (dirty.value) {
        const ok = await new Promise((resolve) => {
            $q.dialog({
                title: "Discard unsaved changes?",
                message: "Restoring will replace the live workflow with the snapshot. Unsaved edits will be lost.",
                ok: { label: "Restore", color: "warning", unelevated: true, "no-caps": true },
                cancel: { label: "Cancel", flat: true, "no-caps": true },
                persistent: true,
            })
                .onOk(() => resolve(true))
                .onDismiss(() => resolve(false));
        });
        if (!ok) return;
    }
    restoringId.value = archive.id;
    try {
        await Graphs.restore(route.params.id, archive.id);
        // Re-load the live row so the editor mirrors what's on disk now.
        const g = await Graphs.get(route.params.id);
        model.value = parseDslToModel(g.dsl);
        lastSavedDsl = g.dsl;
        dirty.value = false;
        $q.notify({
            type: "positive",
            message: `Restored snapshot from ${new Date(archive.archived_at).toLocaleString()}`,
            position: "bottom",
        });
        historyOpen.value = false;
    } catch (e) {
        $q.notify({ type: "negative", message: `Restore failed: ${errMsg(e)}`, position: "bottom" });
    } finally {
        restoringId.value = null;
    }
}

// Export a specific archive (snapshot) as a JSON file. Solves the
// "pin to a historical version" use case without any backend / schema
// changes: the operator keeps the JSON locally (or in git) and can
// re-import it later via the Import button on the Workflows table.
//
// The listing rows (Graphs.archives) don't include the full DSL —
// the response shape there is summary-only — so we fetch the
// individual archive via Graphs.archiveGet first.
async function onExportArchive(archive) {
    if (!archive?.id || exportingId.value) return;
    exportingId.value = archive.id;
    try {
        const full = await Graphs.archiveGet(route.params.id, archive.id);
        // Prefer the canonical parsed shape; fall back to the raw dsl
        // string. Same precedence the bulk Workflows export uses.
        const dsl = full?.parsed
            ?? (typeof full?.dsl === "string" ? JSON.parse(full.dsl) : full?.dsl)
            ?? null;
        if (!dsl) throw new Error("snapshot has no DSL content");
        // Filename pattern: <flow-name>__<archived-at-iso>.json so
        // multiple archives of the same flow sort chronologically.
        const safeName = (model.value.name || "flow").replace(/[^A-Za-z0-9_.-]/g, "_");
        const tsTag = new Date(archive.archived_at).toISOString().replace(/[:.]/g, "-");
        downloadText(`${safeName}__${tsTag}.json`, JSON.stringify(dsl, null, 2), "application/json");
        $q.notify({
            type: "positive",
            message: `Exported snapshot from ${new Date(archive.archived_at).toLocaleString()}`,
            position: "bottom",
        });
    } catch (e) {
        $q.notify({ type: "negative", message: `Export failed: ${errMsg(e)}`, position: "bottom" });
    } finally {
        exportingId.value = null;
    }
}

async function onImport() {
    const text = await pickFileAsText(".json,.txt");
    if (!text) return;
    try {
        model.value = parseDslToModel(text);
        $q.notify({ type: "positive", message: "Imported", timeout: 1500, position: "bottom" });
    } catch (e) {
        $q.notify({ type: "negative", message: `Import failed: ${e.message}`, position: "bottom" });
    }
}

function onExport() {
    const dsl = serializeModelToDsl(model.value);
    const safeName = (model.value.name || "flow").replace(/[^A-Za-z0-9_.-]/g, "_");
    downloadText(`${safeName}.json`, dsl, "application/json");
}

async function goBack() {
    // Code editor edits aren't reflected in `model.value` until applyBuffer
    // runs (on blur or explicit Apply). Flush before checking dirty so the
    // user gets an accurate "are there unsaved changes?" gate.
    if (codeEditorRef.value?.applyBuffer) {
        try { await codeEditorRef.value.applyBuffer({ quiet: true }); }
        catch { /* parse error already surfaced */ }
    }
    if (dirty.value) {
        $q.dialog({
            title: "Unsaved changes",
            message: "Discard changes and leave?",
            ok: { label: "Discard", color: "negative", unelevated: true, "no-caps": true },
            cancel: { label: "Stay", flat: true, "no-caps": true },
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

// Warn on page reload / browser-close when there are unsaved changes.
window.addEventListener("beforeunload", (e) => {
    if (dirty.value) { e.preventDefault(); e.returnValue = ""; }
});

function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
function formatValidationErr(e) {
    const data = e?.response?.data;
    if (!data) return e?.message || "validation failed";
    const details = (data.details || []).map(d => ` • ${d.path || ""} ${d.message || ""}`).join("\n");
    return `${data.message}${details ? "\n" + details : ""}`;
}
</script>

<style scoped>
/* Header height = 52 (toolbar) + 32 (tabs) ≈ 84px. */
.full-tabs {
    height: calc(100vh - 85px);
}
.full-tabs :deep(.q-tab-panel) {
    height: 100%;
    padding: 0;
}
</style>
