<script setup>
import { ref, computed, watch } from "vue";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  initial: { type: Object, default: () => ({}) },
});
// submit now carries both the parsed input context AND any tags the
// user typed in. Caller signature: handler({ context, tags }).
const emit = defineEmits(["update:modelValue", "submit"]);

const text = ref("{}");
// q-select with new-value-mode="add-unique" lets the user type a tag
// and press Enter to chip-ify it. Backend normalises (trim/lower/dedupe)
// so we don't need to enforce anything here.
const tags = ref([]);
// Mirror the q-select's in-flight input buffer via @input-value. We
// commit it as a tag on submit so a user who types and clicks Run
// without pressing Enter doesn't silently lose the text. Pure-JS
// approach — doesn't depend on calling q-select's internal add()
// which has been flaky across Quasar minor versions.
const tagInputBuffer = ref("");

const parsed = computed(() => {
  try { return { ok: true, value: JSON.parse(text.value || "{}") }; }
  catch (e) { return { ok: false, error: e.message }; }
});

watch(() => props.modelValue, (open) => {
  if (open) {
    text.value           = JSON.stringify(props.initial || {}, null, 2);
    tags.value           = [];   // start clean each open — tags are per-run, not sticky
    tagInputBuffer.value = "";
  }
});

function close() { emit("update:modelValue", false); }
function submit() {
  if (!parsed.value.ok) return;
  // Pick up any in-flight text the user typed but didn't Enter on
  // (the most common "tag didn't save" complaint). Dedupe by exact
  // string match — backend will lower-case and re-dedupe anyway.
  const buf = String(tagInputBuffer.value || "").trim();
  if (buf && !tags.value.includes(buf)) tags.value.push(buf);
  emit("submit", { context: parsed.value.value, tags: tags.value });
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
}
</script>

<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    persistent
  >
    <q-card style="min-width: 520px; max-width: 92vw;">
      <q-card-section class="row items-center q-pb-sm">
        <q-icon name="play_arrow" class="q-mr-sm" />
        <div class="text-subtitle1">Run with input</div>
        <q-space />
        <q-btn dense flat round icon="close" v-close-popup @click="close" />
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-caption text-grey q-mb-xs">
          JSON input — exposed inside the workflow as
          <code>${var}</code> and <code>${data.var}</code>.
          Pass <code>{ "items": [ ... ] }</code> or a bare array to run the flow once per item.
        </div>
        <q-input
          v-model="text"
          type="textarea"
          dense
           
          outlined
          autogrow
          input-style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; min-height: 240px;"
          :error="!parsed.ok"
          :error-message="parsed.error"
          @keydown="onKeydown"
        />
        <div v-if="parsed.ok" class="text-caption text-grey q-mt-xs">
          Valid JSON · {{ Array.isArray(parsed.value) ? parsed.value.length + ' item(s)' : Object.keys(parsed.value || {}).length + ' top-level keys' }}
        </div>

        <!-- Tags input — chip-style q-select with type-to-add.
             `new-value-mode="add-unique"` handles Enter-to-add natively;
             empty-string and dedupe are taken care of by Quasar + the
             backend's normalizeTags (which trims/lowercases/dedupes). -->
        <q-select
          v-model="tags"
          dense outlined
          use-input use-chips multiple hide-dropdown-icon
          input-debounce="0"
          new-value-mode="add-unique"
          :options="[]"
          class="q-mt-md"
          label="Tags (optional)"
          hint="Stamped onto this execution so you can filter the Instances list later. Press Enter after each tag, or just click Run."
          @input-value="(v) => tagInputBuffer = v"
        />
      </q-card-section>

      <q-card-actions align="right" class="q-pa-sm">
        <q-btn dense flat no-caps label="Cancel" v-close-popup @click="close" />
        <q-btn
          outline  no-caps
          color="primary"
          icon-right="play_arrow"
          label="Run"
          class="run-button"
          data-testid="run-dialog-submit"
          :disable="!parsed.ok"
          @click="submit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>
