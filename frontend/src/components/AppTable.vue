<template>
  <q-table v-model:selected="selected" :rows="filteredRows" :columns="columns" :title="title" row-key="id" flat dense
    bordered :selection="readOnly ? 'none' : 'multiple'">
    <template v-slot:top-right>
      <q-input v-model="filter" borderless dense debounce="300" placeholder="Search" class="q-mr-sm">
        <template v-slot:append>
          <q-icon name="search" size="sm"/>
        </template>
      </q-input>

      <!-- Refresh — emits a `refresh` event for the parent to re-fetch.
           Available in both read-only and editable modes since reloading
           a list never mutates anything. Parent enables it by listening
           to @refresh; if no listener is attached the button is hidden
           to keep older tables tidy. -->
      <q-btn
        v-if="hasRefreshListener"
        icon="refresh" flat dense size="sm"
        :loading="refreshing"
        @click="onRefresh"
      >
        <q-tooltip>Refresh</q-tooltip>
      </q-btn>

      <!-- Import / Export — same listener-gated pattern as Refresh so
           tables that don't care don't get the buttons. Export is safe
           in read-only mode (it doesn't mutate); Import is mutating so
           we hide it under readOnly. -->
      <q-btn
        v-if="hasExportListener"
        icon="download" flat dense size="sm"
        @click="onExport"
      >
        <q-tooltip>Export to JSON file</q-tooltip>
      </q-btn>
      <q-btn
        v-if="hasImportListener && !readOnly"
        icon="upload" flat dense size="sm"
        @click="onImport"
      >
        <q-tooltip>Import from JSON file</q-tooltip>
      </q-btn>

      <!-- Mutating buttons disappear entirely in read-only mode (editor
           view, Instances, Running triggers). Quasar's q-table still
           shows the title + search even without these. -->
      <template v-if="!readOnly">
        <q-btn icon="add" flat dense @click="onAdd" size="sm" data-testid="add-button">
          <q-tooltip>Add new item</q-tooltip>
        </q-btn>

        <q-btn size="sm" icon="delete" flat dense :disable="selected.length === 0" @click="onDeleteSelected">
          <q-tooltip>Delete selected</q-tooltip>
        </q-btn>
      </template>
    </template>

    <!-- Leftmost "action" column — render-only pass-through for parents
         that want per-row launcher buttons (e.g. HomePage workflows
         table: "Open in code" / "Open in visual"). Other tables that
         declare the same column name just get an empty cell, which is
         the historic behaviour — this slot is opt-in. Different name
         from "actions" (plural, on the right) so the two stay clearly
         distinct. -->
    <template v-slot:body-cell-action="props">
      <q-td :props="props" auto-width>
        <slot name="row-action" :row="props.row" />
      </q-td>
    </template>

    <!-- Name column — primary clickable label that opens the row editor.
         Triggers / Workflows / Configurations use a "name" column;
         Agents use "title"; Executions reuse "name" with the field
         function pulling from row.graph_name. Both render the same
         way. We bind to `props.value` (the column's resolved value)
         instead of `props.row.name` so any table can declare a
         column named "name" with whatever underlying field it likes.
         When `clickable=false` the cell renders as plain text so
         view-only tables don't dangle a click affordance. -->
    <template v-slot:body-cell-name="props">
      <q-td :props="props">
        <span
          v-if="clickable"
          class="text-primary cursor-pointer"
          @click="onEdit(props.row)"
        >
          {{ props.value }}
        </span>
        <span v-else>{{ props.value }}</span>
        <q-btn
          v-if="props.value"
          flat dense round size="xs"
          icon="content_copy"
          class="cell-id-copy"
          @click.stop="onCopyId(props.value)"
        >
          <q-tooltip>Copy</q-tooltip>
        </q-btn>
      </q-td>
    </template>

    <!-- Title column — same link affordance for tables keyed on `title`. -->
    <template v-slot:body-cell-title="props">
      <q-td :props="props">
        <span
          v-if="clickable"
          class="text-primary cursor-pointer"
          @click="onEdit(props.row)"
        >
          {{ props.value }}
        </span>
        <span v-else>{{ props.value }}</span>
      </q-td>
    </template>

    <!-- Id column — shows the row's UUID truncated to 8 chars with a
         copy-to-clipboard button. The full id is in the title attribute
         so a hover tooltip exposes it for inspection. Used by the
         Workflows table on Home so the user can grab a graphId for
         workflow.fire / API calls without leaving the page. -->
    <template v-slot:body-cell-id="props">
      <q-td :props="props" class="cell-id" >
        <code :title="props.row.id" class="cell-id-text" >
          {{ props.row.id }}
        </code>
        <q-btn
          flat dense round size="xs"
          icon="content_copy"
          class="cell-id-copy"
          @click.stop="onCopyId(props.row.id)"
        >
          <q-tooltip>Copy full id</q-tooltip>
        </q-btn>
      </q-td>
    </template>
   

    <!-- Tags column — recognised by name, like `name`/`title`/`id` above.
         Renders each entry of the row's `tags` array as a clickable
         q-chip. Click emits `tag-click` upward so the parent can toggle
         a filter (no built-in filtering — parent owns that state, same
         pattern as @edit/@delete). Empty cell shows an em-dash so the
         column isn't suspiciously blank. -->
    <template v-slot:body-cell-tags="props">
      <q-td :props="props">
        <template v-if="Array.isArray(props.value) && props.value.length">
          <q-chip
            v-for="t in props.value" :key="t"
            dense square size="11px"
            class="q-mr-xs cursor-pointer"
            clickable
            @click.stop="emit('tag-click', t)"
          >
            {{ t }}
          </q-chip>
        </template>
        <span v-else class="text-grey-5">—</span>
      </q-td>
    </template>

    <!-- Actions Column — read-only tables still get the `row-actions`
         slot, so callers (e.g. HomePage "Running triggers") can drop
         in Run / Stop buttons that don't fit the Edit/Delete menu.
         The slot receives `{ row }` and renders to the left of the
         more_vert menu. -->
    <template v-slot:body-cell-actions="props">
      <q-td :props="props" auto-width>
        <slot name="row-actions" :row="props.row" />
        <q-btn v-if="!readOnly" icon="more_vert" flat size="sm" dense>
          <q-tooltip>Row actions</q-tooltip>
          <q-menu>
            <q-list dense style="min-width: 200px">
              <q-item dense clickable v-close-popup @click="onEdit(props.row)">
                <q-item-section avatar>
                  <q-icon name="edit" size="18px" />
                </q-item-section>
                <q-item-section>Edit</q-item-section>
              </q-item>
              <q-item dense clickable v-close-popup @click="onDelete(props.row)">
                <q-item-section avatar>
                  <q-icon name="delete" size="18px" color="negative" />
                </q-item-section>
                <q-item-section>Delete</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </q-td>
    </template>
  </q-table>
</template>

<script setup>
import { computed, ref, watch, getCurrentInstance } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();
const instance = getCurrentInstance();

// Whether the parent attached an @refresh / @import / @export handler.
// The corresponding buttons are hidden when nobody's listening —
// keeps older callers untouched and avoids buttons that do nothing
// visible.
const hasRefreshListener = computed(() => {
  const vnode = instance?.vnode;
  return !!(vnode?.props?.onRefresh);
});
const hasImportListener = computed(() => {
  const vnode = instance?.vnode;
  return !!(vnode?.props?.onImport);
});
const hasExportListener = computed(() => {
  const vnode = instance?.vnode;
  return !!(vnode?.props?.onExport);
});

const props = defineProps({
  rows: {
    type: Array,
    default: () => [],
  },
  columns: {
    type: Array,
    default: () => [],
  },
  title: {
    type: String,
    default: "",
  },
  // When true: no Add button, no Delete-selected button, no per-row
  // actions menu, and row-selection checkboxes are removed. The
  // primary name/title cell still emits 'edit' on click — turn that
  // off via `clickable=false`. Used for the editor's Configurations
  // view-only table, Instances, and Running triggers.
  readOnly: {
    type: Boolean,
    default: false,
  },
  // Whether the name/title cell renders as a clickable link. Default
  // true matches the legacy behaviour; set to false for tables that
  // shouldn't drill into an editor (e.g. editor viewing Configurations).
  clickable: {
    type: Boolean,
    default: true,
  },
});

const emit = defineEmits([
  "edit",
  "add",
  "delete",
  "delete-selected",
  "selection-change",
  // Fires when the user clicks the refresh icon. Parent should
  // re-fetch its rows; the button shows a spinner until the parent
  // either resets the busy prop or the next render flushes.
  "refresh",
  // Import / export. Export receives no payload — parent owns
  // serialisation + file download. Import is fire-and-forget —
  // parent opens its own file picker.
  "import",
  "export",
  // Fires when the user clicks a tag chip in any column named "tags".
  // The parent decides what to do — typically toggle the chip into a
  // filter list. Payload is the tag string.
  "tag-click",
]);

const selected = ref([]);
const filter = ref("");
const refreshing = ref(false);

function onRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  // Vue 3 emit doesn't return a Promise, so we can't await the
  // parent's reload here. A short fixed delay gives the user
  // visible feedback that the click registered.
  emit("refresh");
  setTimeout(() => { refreshing.value = false; }, 400);
}

function onImport() { emit("import"); }
function onExport() { emit("export"); }

const filteredRows = computed(() => {
  if (!filter.value) return props.rows;

  const search = filter.value.toLowerCase();

  return props.rows.filter((row) =>
    Object.values(row).some((value) =>
      String(value).toLowerCase().includes(search),
    ),
  );
});

function onEdit(row) {
  emit("edit", row);
}

function onAdd() {
  emit("add");
}

function onDelete(row) {
  emit("delete", row);
}

function onDeleteSelected() {
  emit("delete-selected", selected.value);
}

// Copy the full row id to the clipboard. Wrapped in a try/catch so a
// permissions-denied (e.g. non-HTTPS in some browsers) doesn't surface
// as a stack trace; surface it as a notify instead.
async function onCopyId(id) {
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: `Copy failed: ${e?.message || e}`, position: "bottom" });
  }
}

watch(selected, (value) => {
  emit("selection-change", value);
});
</script>

<style scoped>
.cell-id        { white-space: nowrap; }
.cell-id-text   {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
.cell-id-copy   { margin-left: 4px; }
</style>
