<!--
  FlowInspector — operational dashboard.

  Layout mirrors HomePage (q-header + two stacked AppTables in the page
  body) but the contents are run-time information rather than authoring
  artefacts:

    1) Active executions  — anything still queued / running. Click a row
       to drill into the read-only InstanceViewer for that execution.

    2) Triggers           — same triggers as HomePage but with a Start /
       Stop control inline so the user can flip a subscription on/off
       without going through the editor.

  We poll both lists every few seconds so the page reflects worker
  progress without needing a manual refresh.
-->
<template>
    <q-layout view="hHh lpR fFf">
        <q-header class="app-header">
            <q-toolbar class="app-toolbar">
                     <q-img 
                      :src="$q.dark.isActive ? '/dag_logo_dark.png' : '/dag_logo_light.png'"
                       style="width: 28px; height: 28px;" class="q-mr-sm" @click="goHome" />
                <q-toolbar-title>
                   Flow Inspector
                   
                </q-toolbar-title>
                <q-space />
                <q-btn
                    flat round dense
                    icon="refresh"
                    class="btn-icon"
                    :loading="loading"
                    @click="reload"
                >
                    <q-tooltip>Refresh</q-tooltip>
                </q-btn>
            </q-toolbar>
        </q-header>

        <q-page-container>
            <q-page class="app-page">
                <div class="q-gutter-md">
                    <!-- 1. Executions ────────────────────────────────────────── -->
                    <q-table
                        v-model:pagination="execPagination"
                        v-model:selected="execSelected"
                        :rows="filteredExecRows"
                        :columns="exec_columns"
                        :title="execTableTitle"
                        row-key="id"
                        flat dense bordered
                        selection="multiple"
                        :rows-per-page-options="[10, 25, 50, 100]"
                        :no-data-label="execEmptyLabel"
                        @row-click="(_, row) => openExecution(row)"
                    >
                        <template v-slot:top-right>
                            <q-btn
                                v-if="execSelected.length"
                                flat dense no-caps icon="delete"
                                color="negative"
                                :label="`Delete (${deletableSelectedCount})`"
                                :disable="deletableSelectedCount === 0 || bulkDeleting"
                                :loading="bulkDeleting"
                                class="q-mr-md"
                                @click="deleteSelectedExecutions"
                            >
                                <q-tooltip v-if="execSelected.length && deletableSelectedCount === 0">
                                    Selected rows are still running — they can't be deleted.
                                </q-tooltip>
                                <q-tooltip v-else-if="deletableSelectedCount < execSelected.length">
                                    {{ execSelected.length - deletableSelectedCount }} of
                                    {{ execSelected.length }} are still running and will be skipped.
                                </q-tooltip>
                            </q-btn>
                            <q-select
                                v-model="statusFilter"
                                :options="STATUS_OPTIONS"
                                emit-value map-options
                                dense outlined
                                label="Status"
                                style="min-width: 140px;"
                                class="q-mr-md"
                            />
                            <!-- Tag filter — chip-style with type-to-add,
                                 same shape as the RunDialog input. Multi-tag
                                 entries use overlap semantics (rows match
                                 when ANY tag is present). -->
                            <q-select
                                v-model="tagFilter"
                                dense outlined
                                use-input use-chips multiple hide-dropdown-icon
                                input-debounce="0"
                                new-value-mode="add-unique"
                                :options="[]"
                                label="Tags"
                                style="min-width: 180px;"
                                class="q-mr-md"
                            />
                            <q-input v-model="execFilter" borderless dense debounce="200" placeholder="Search">
                                <template v-slot:append><q-icon name="search" /></template>
                            </q-input>
                            <q-btn
                                flat dense round
                                icon="refresh"
                                class="q-ml-sm"
                                :loading="loading"
                                @click="reload"
                            >
                                <q-tooltip>Refresh executions</q-tooltip>
                            </q-btn>
                        </template>

                        <template v-slot:body-cell-status="props">
                            <q-td :props="props">
                                <span class="status-pill" :class="`status-${props.row.status}`">
                                    {{ props.row.status }}
                                </span>
                            </q-td>
                        </template>

                        <!-- Tag chips. Click → seed the tagFilter so the user
                             can pivot from one execution into "show me all
                             others with this tag". em-dash when empty so the
                             cell isn't suspiciously blank. -->
                        <template v-slot:body-cell-tags="props">
                            <q-td :props="props">
                                <template v-if="(props.row.tags || []).length">
                                    <q-chip
                                        v-for="t in props.row.tags" :key="t"
                                        dense square size="11px"
                                        class="q-mr-xs cursor-pointer"
                                        clickable
                                        @click.stop="onTagChipClick(t)"
                                    >
                                        {{ t }}
                                    </q-chip>
                                </template>
                                <span v-else class="text-grey-5">—</span>
                            </q-td>
                        </template>

                        <template v-slot:body-cell-actions="props">
                            <q-td :props="props" auto-width>
                                <q-btn
                                    icon="open_in_new" flat round dense size="sm"
                                    @click.stop="openExecution(props.row)"
                                >
                                    <q-tooltip>Inspect</q-tooltip>
                                </q-btn>
                                <q-btn
                                    icon="delete" flat round dense size="sm" color="negative"
                                    :disable="isInFlight(props.row) || !!execBusy[props.row.id]"
                                    :loading="!!execBusy[props.row.id]"
                                    @click.stop="deleteExecution(props.row)"
                                >
                                    <q-tooltip>{{
                                        isInFlight(props.row)
                                            ? "Can't delete while still " + props.row.status
                                            : "Delete this execution"
                                    }}</q-tooltip>
                                </q-btn>
                            </q-td>
                        </template>
                    </q-table>

                    <!-- 2. Triggers ───────────────────────────────────────────── -->
                    <q-table
                        v-model:pagination="triggerPagination"
                        :rows="filteredTriggers"
                        :columns="trigger_columns"
                        title="Triggers"
                        row-key="id"
                        flat dense bordered
                        :rows-per-page-options="[10, 25, 50, 100]"
                        no-data-label="No triggers configured."
                    >
                        <template v-slot:top-right>
                            <q-input v-model="triggerFilter" borderless dense debounce="200" placeholder="Search">
                                <template v-slot:append><q-icon name="search" /></template>
                            </q-input>
                        </template>

                        <template v-slot:body-cell-status="props">
                            <q-td :props="props">
                                <span
                                    class="status-pill"
                                    :class="props.row.enabled
                                        ? (props.row.last_error ? 'status-failed' : 'status-running')
                                        : 'status-skipped'"
                                >
                                    {{ triggerStatusLabel(props.row) }}
                                </span>
                            </q-td>
                        </template>

                        <template v-slot:body-cell-actions="props">
                            <q-td :props="props" auto-width>
                                <!-- Run-now is always available (whether subscribed or not). -->
                                <q-btn
                                    icon="play_arrow" flat round dense size="sm" color="positive"
                                    :loading="busy[props.row.id]"
                                    @click.stop="fireTrigger(props.row)"
                                >
                                    <q-tooltip>Run now</q-tooltip>
                                </q-btn>
                                <q-btn
                                    v-if="!props.row.enabled"
                                    icon="power_settings_new" flat round dense size="sm" color="grey-7"
                                    :loading="busy[props.row.id]"
                                    @click.stop="startTrigger(props.row)"
                                >
                                    <q-tooltip>Enable subscription</q-tooltip>
                                </q-btn>
                                <q-btn
                                    v-else
                                    icon="stop" flat round dense size="sm" color="negative"
                                    :loading="busy[props.row.id]"
                                    @click.stop="stopTrigger(props.row)"
                                >
                                    <q-tooltip>Stop (disable subscription)</q-tooltip>
                                </q-btn>
                            </q-td>
                        </template>
                    </q-table>
                </div>
            </q-page>
        </q-page-container>
    </q-layout>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Executions, Triggers, Graphs } from "../api/client";

const router = useRouter();
const $q = useQuasar();

// ── State ──────────────────────────────────────────────────────────────────
const exec_rows     = ref([]);
const trigger_rows  = ref([]);
const wf_rows       = ref([]);   // graphs lookup for displaying flow names
const execFilter    = ref("");
const triggerFilter = ref("");
const loading       = ref(false);
// Status dropdown — one option per real engine state, plus a synthetic
// "all" / "active" pair so the user can pivot quickly. Persisted across
// visits via localStorage so the page remembers the last filter.
const STATUS_OPTIONS = [
    { value: "all",     label: "All" },
    { value: "active",  label: "Active (queued + running)" },
    { value: "queued",  label: "Queued" },
    { value: "running", label: "Running" },
    { value: "success", label: "Success" },
    { value: "failed",  label: "Failed" },
];
const statusFilter = ref((() => {
    try {
        const saved = localStorage.getItem("flowInspector.statusFilter");
        if (STATUS_OPTIONS.some(o => o.value === saved)) return saved;
    } catch { /* ignore */ }
    return "all";
})());

// Tag filter — list of tags the user wants to keep visible. Empty array
// means "no tag filter". Multi-tag entries use OR semantics (overlap).
// Persisted to localStorage so it survives reloads, same as statusFilter.
const tagFilter = ref((() => {
    try {
        const saved = JSON.parse(localStorage.getItem("flowInspector.tagFilter") || "[]");
        return Array.isArray(saved) ? saved : [];
    } catch { return []; }
})());

// Clicking a tag chip in the table seeds the filter with that tag (or
// removes it on second click — toggling matches the user's mental model
// of "filter by this / now don't").
function onTagChipClick(tag) {
    const i = tagFilter.value.indexOf(tag);
    if (i >= 0) tagFilter.value.splice(i, 1);
    else        tagFilter.value.push(tag);
}
// Per-trigger busy flag so flipping one button doesn't disable the others.
const busy = reactive({});
// Per-execution busy flag while a delete is in flight.
const execBusy = reactive({});

// Multi-select state for the bulk-delete control. Quasar's q-table writes
// the full selected row objects into this array (not just ids).
const execSelected = ref([]);
const bulkDeleting = ref(false);

// Pagination — page index always starts at 1 on a fresh visit, but the
// rows-per-page choice is sticky across visits.
function readPageSize(key, fallback) {
    try {
        const n = Number(localStorage.getItem(key));
        return Number.isFinite(n) && n > 0 ? n : fallback;
    } catch {
        return fallback;
    }
}
const execPagination = ref({
    sortBy: "started",
    descending: true,
    page: 1,
    rowsPerPage: readPageSize("flowInspector.execRowsPerPage", 10),
});
const triggerPagination = ref({
    sortBy: "name",
    descending: false,
    page: 1,
    rowsPerPage: readPageSize("flowInspector.triggerRowsPerPage", 10),
});

// What counts as "still in flight" — gates the delete button so we don't
// remove rows while the worker is mid-write.
const IN_FLIGHT = new Set(["queued", "running", "retrying", "pending"]);
function isInFlight(row) {
    return IN_FLIGHT.has(row?.status);
}

// ── Columns ────────────────────────────────────────────────────────────────
const exec_columns = [
    {
        name: "id", label: "Execution", field: "id", align: "left",
         
       
    },
    {
        name: "graph", label: "Flow", align: "left", sortable: true,
        field: row => formatGraph(row),
         style: "width: 90px;"
    },
    { name: "status", label: "Status", field: "status", align: "left", style: "width: 90px;" },
    // Tags column — chips rendered via a body-cell slot below so the
    // template can iterate row.tags into individual q-chip elements.
    { name: "tags", label: "Tags", field: row => row.tags || [], align: "left", style: "max-width: 220px;" },
    {
        name: "started", label: "Started", align: "left",
        field: row => row.started_at || row.created_at,
        format: v => v ? new Date(v).toLocaleString() : "—",
    },

    { name: "actions", label: "", align: "right", style: "width: 90px;" },
];

const trigger_columns = [
    { name: "status", label: "Status", field: row => triggerStatusLabel(row), align: "left", style: "width: 80px;" },
    { name: "name",   label: "Name",   field: "name", align: "left", sortable: true },
    { name: "type",   label: "Type",   field: "type", align: "left", sortable: true, style: "width: 80px;" },
    { name: "graph",  label: "Flow",   field: row => graphName(row.graph_id), align: "left" },
    { name: "fires",  label: "Fires",  field: "fire_count", align: "right", style: "width: 60px;" },
    {
        name: "lastFired", label: "Last fired", field: "last_fired_at", align: "left",
        format: v => v ? new Date(v).toLocaleString() : "—",
    },
    { name: "actions", label: "", align: "right", style: "width: 50px;" },
];

// ── Derived ────────────────────────────────────────────────────────────────
function statusMatches(filter, status) {
    if (filter === "all")    return true;
    if (filter === "active") return IN_FLIGHT.has(status);
    return status === filter;
}

const filteredExecRows = computed(() => {
    const q = execFilter.value.toLowerCase();
    const f = statusFilter.value;
    // Overlap semantics for tags — a row matches when ANY selected tag
    // is present on the row. Empty filter means "no tag filter".
    const wantedTags = (tagFilter.value || []).map(t => String(t).toLowerCase());
    return exec_rows.value.filter(r => {
        if (!statusMatches(f, r.status)) return false;
        if (wantedTags.length) {
            const rowTags = (r.tags || []).map(t => String(t).toLowerCase());
            if (!wantedTags.some(t => rowTags.includes(t))) return false;
        }
        if (!q) return true;
        const haystack = `${r.status} ${formatGraph(r)} ${r.id || ""} ${(r.tags || []).join(" ")}`.toLowerCase();
        return haystack.includes(q);
    });
});

// How many of the currently-selected rows are eligible for delete (i.e.
// not still queued/running). Used both to label the button and to gate
// it when the user has only selected in-flight rows.
const deletableSelectedCount = computed(() =>
    execSelected.value.filter(r => !isInFlight(r)).length
);

const execTableTitle = computed(() => {
    const opt = STATUS_OPTIONS.find(o => o.value === statusFilter.value);
    if (!opt || statusFilter.value === "all") return "Recent executions";
    return `Executions — ${opt.label.toLowerCase()}`;
});
const execEmptyLabel = computed(() => {
    const f = statusFilter.value;
    if (f === "all")    return "No executions yet — run a flow from the Home page.";
    if (f === "active") return "No executions are currently queued or running.";
    return `No "${f}" executions in the last 200.`;
});

const filteredTriggers = computed(() => {
    const q = triggerFilter.value.toLowerCase();
    if (!q) return trigger_rows.value;
    return trigger_rows.value.filter(r =>
        Object.values(r).some(v => String(v ?? "").toLowerCase().includes(q))
    );
});

// Persist the dropdown choice whenever it changes.
watch(statusFilter, (v) => {
    try { localStorage.setItem("flowInspector.statusFilter", v); }
    catch { /* private mode — ignore */ }
});

// Same shape for the tag-filter chips. JSON-serialised because it's
// an array; we don't bother with versioning since the contents are
// just strings.
watch(tagFilter, (v) => {
    try { localStorage.setItem("flowInspector.tagFilter", JSON.stringify(v || [])); }
    catch { /* ignore */ }
}, { deep: true });

// Persist rows-per-page changes (but not the current page index — every
// fresh visit should land on page 1).
watch(() => execPagination.value.rowsPerPage, (n) => {
    try { localStorage.setItem("flowInspector.execRowsPerPage", String(n)); }
    catch { /* ignore */ }
});
watch(() => triggerPagination.value.rowsPerPage, (n) => {
    try { localStorage.setItem("flowInspector.triggerRowsPerPage", String(n)); }
    catch { /* ignore */ }
});

// When the active filter narrows the result set, snap back to page 1 so
// the user isn't stranded on an empty page (e.g. they were on page 5 of
// "All" and switched to "Failed" with only 3 rows).
watch([statusFilter, execFilter, tagFilter], () => { execPagination.value.page = 1; }, { deep: true });
watch(triggerFilter, () => { triggerPagination.value.page = 1; });

// ── Helpers ────────────────────────────────────────────────────────────────
//
// Workflows are single-row now (versioning removed in migration 008), so
// the label is just the workflow name. Earlier revisions appended
// `(v<version>)`, which rendered as `(vundefined)` once the column was
// dropped — keep these helpers cleanly version-free.
function formatGraph(row) {
    if (row.graph_name) return row.graph_name;
    return graphName(row.graph_id);
}
function graphName(graphId) {
    const g = wf_rows.value.find(x => x.id === graphId);
    if (g) return g.name;
    return graphId ? graphId.slice(0, 8) + "…" : "";
}
function triggerStatusLabel(row) {
    if (!row?.enabled) return "stopped";
    if (row?.last_error) return "error";
    return "running";
}

// ── Data loading + polling ────────────────────────────────────────────────
//
// We always fetch the recent-execution list (no server-side status filter),
// then narrow client-side based on the "Active only" toggle. That way the
// table is never empty just because nothing is in flight — the user still
// sees recent runs and can drill in to inspect them — and toggling the
// filter is instant (no extra round-trip).
async function reload() {
    if (loading.value) return;
    loading.value = true;
    try {
        const [execs, triggers, graphs] = await Promise.all([
            // Pull a generous slice so the client-side paginator has plenty
            // to work with across the status filters.
            Executions.list({ limit: 200 }).catch(() => []),
            Triggers.list().catch(() => []),
            // Graphs only used to decorate trigger rows when the API didn't join.
            Graphs.list().catch(() => []),
        ]);
        exec_rows.value    = execs    || [];
        trigger_rows.value = triggers || [];
        wf_rows.value      = graphs   || [];
    } finally {
        loading.value = false;
    }
}

let pollTimer = null;
onMounted(() => {
    reload();
    pollTimer = setInterval(reload, 4000);
});
onBeforeUnmount(() => {
    if (pollTimer) clearInterval(pollTimer);
});

// ── Actions ────────────────────────────────────────────────────────────────
function openExecution(row) {
    if (!row?.id) return;
    router.push({ name: "instanceViewer", params: { id: row.id } });
}

async function deleteExecution(row) {
    if (!row?.id || isInFlight(row) || execBusy[row.id]) return;
    const confirmed = await confirmDialog(
        `Delete execution ${row.id.slice(0, 8)}…? This cannot be undone.`
    );
    if (!confirmed) return;
    execBusy[row.id] = true;
    try {
        await Executions.remove(row.id);
        // Drop it from the local list immediately so the UI updates without
        // waiting for the next poll cycle.
        exec_rows.value = exec_rows.value.filter(r => r.id !== row.id);
        notify(`Deleted execution ${row.id.slice(0, 8)}…`, "positive");
    } catch (e) {
        notify(`Delete failed: ${errMsg(e)}`, "negative");
    } finally {
        execBusy[row.id] = false;
    }
}

async function deleteSelectedExecutions() {
    if (bulkDeleting.value) return;
    // Drop in-flight rows up front — the user has been told they'll be
    // skipped via the button tooltip.
    const targets = execSelected.value.filter(r => !isInFlight(r));
    if (!targets.length) return;
    const skipped = execSelected.value.length - targets.length;
    const msg = skipped
        ? `Delete ${targets.length} execution(s)? ${skipped} still-running row(s) will be skipped. This cannot be undone.`
        : `Delete ${targets.length} execution(s)? This cannot be undone.`;
    if (!await confirmDialog(msg)) return;

    bulkDeleting.value = true;
    let failed = 0;
    try {
        // Run sequentially — each delete is cheap, and serial keeps the
        // error reporting + UI updates simple. If this ever feels slow we
        // can batch with Promise.allSettled.
        for (const row of targets) {
            execBusy[row.id] = true;
            try {
                await Executions.remove(row.id);
                exec_rows.value = exec_rows.value.filter(r => r.id !== row.id);
            } catch {
                failed++;
            } finally {
                execBusy[row.id] = false;
            }
        }
        // Clear the selection of anything we successfully deleted (rows that
        // failed stay selected so the user can retry).
        const survivingIds = new Set(exec_rows.value.map(r => r.id));
        execSelected.value = execSelected.value.filter(r => survivingIds.has(r.id));

        const ok = targets.length - failed;
        if (failed === 0) {
            notify(`Deleted ${ok} execution(s)`, "positive");
        } else {
            notify(`Deleted ${ok} of ${targets.length} (${failed} failed)`,
                ok ? "warning" : "negative");
        }
    } finally {
        bulkDeleting.value = false;
    }
}

function confirmDialog(message) {
    return new Promise((resolve) => {
        $q.dialog({
            title: "Confirm",
            message,
            persistent: true,
            ok:     { label: "Delete", color: "negative", unelevated: true, "no-caps": true },
            cancel: { label: "Cancel", flat: true,  "no-caps": true },
        })
            .onOk(() => resolve(true))
            .onDismiss(() => resolve(false));
    });
}

async function startTrigger(row) {
    if (busy[row.id]) return;
    busy[row.id] = true;
    try {
        await Triggers.update(row.id, { enabled: true });
        notify(`Started "${row.name}"`, "positive");
        await reload();
    } catch (e) {
        notify(`Start failed: ${errMsg(e)}`, "negative");
    } finally {
        busy[row.id] = false;
    }
}
async function stopTrigger(row) {
    if (busy[row.id]) return;
    busy[row.id] = true;
    try {
        await Triggers.update(row.id, { enabled: false });
        notify(`Stopped "${row.name}"`, "positive");
        await reload();
    } catch (e) {
        notify(`Stop failed: ${errMsg(e)}`, "negative");
    } finally {
        busy[row.id] = false;
    }
}
// Manual fire — works regardless of `enabled`. Opens the resulting
// execution in the InstanceViewer so the user can watch it run.
async function fireTrigger(row) {
    if (busy[row.id]) return;
    busy[row.id] = true;
    try {
        const { executionId } = await Triggers.fire(row.id);
        notify(`Fired "${row.name}"`, "positive");
        await reload();
        if (executionId) router.push(`/instanceViewer/${executionId}`);
    } catch (e) {
        notify(`Run failed: ${errMsg(e)}`, "negative");
    } finally {
        busy[row.id] = false;
    }
}

function goHome() { router.push("/"); }

// ── Util ───────────────────────────────────────────────────────────────────
function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
function notify(message, type = "positive") {
    $q.notify({ type, message, timeout: 1800, position: "bottom" });
}
</script>

<style scoped>
/* Status pills + table polish are defined globally in styles.css so they
   stay consistent across Inspector / InstanceViewer / GraphView. */
</style>
