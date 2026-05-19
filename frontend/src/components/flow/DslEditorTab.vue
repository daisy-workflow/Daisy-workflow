<!--
  Code-mode editor — full-tab Daisy DSL editor backed by CodeMirror 6.

  Why a real editor (not <textarea>) ?
    * Syntax highlighting for keywords, strings, comments, edges, ${refs}
    * Bracket / quote matching + auto-close
    * Context-aware autocomplete (plugin names + plugin input field names)
    * Line numbers + active-line highlight — the small things you miss the
      moment you're past 20 lines

  What the DSL editor can express (round-trips losslessly via parse/serialize):
    name, nodes (name + action + inputs + outputs + executeIf + iterate),
    edges.

  What it CANNOT express (preserved across edits via applyBuffer):
    description, data, meta.{prompt, positions, notes}, retry, retryDelay,
    onError, outputVar, per-node description.

  Sync model:
    The CodeMirror EditorView owns the live document. We mirror its
    content into a `buffer` ref so the rest of the component (the apply
    pipeline, the parent's beforeunmount, etc.) can read it without
    reaching into the view. Vue's watch keeps the editor synced when the
    parent model changes externally — except while the editor is
    focused, where we never trample in-progress edits.

  Theme:
    Pulls colours from the app's CSS custom properties (–-bg, --surface,
    --text, --border, --primary, etc.) so dark/light mode toggles
    propagate without an extra reconfigure.
-->
<template>
  <div class="column full-height code-tab">
    <q-toolbar dense class="code-toolbar">
      <q-icon name="code" class="q-mr-sm" style="color: var(--text-muted);" />
      <div class="text-subtitle2" style="color: var(--text);">DSL editor</div>
      <q-space />
      <q-btn dense size="sm" flat no-caps icon="task_alt" label="Apply"
             class="btn-secondary q-ml-xs" @click="onApply" />
      <q-btn dense size="sm" flat no-caps icon="content_copy" label="Copy"
             class="btn-secondary q-ml-xs" @click="onCopy" />
    </q-toolbar>

    <!-- CodeMirror mounts inside this element. We set tabindex so the
         parent .col-* layout doesn't swallow focus first. -->
    <div ref="editorHost" class="cm-host col" tabindex="-1"></div>

    <div v-if="error" class="code-error">
      <q-icon name="error_outline" class="q-mr-xs" />
      {{ error }}
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useQuasar } from "quasar";

import { EditorState } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor,
} from "@codemirror/view";
import {
  bracketMatching, foldGutter, indentOnInput,
  syntaxHighlighting, defaultHighlightStyle,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";

import { parse as parseDsl, serialize as serializeDsl } from "../../dsl/index.js";
import { dslLanguageSupport, dslCompletions } from "../../dsl/codemirror.js";
import { mergePositionsWithLayout } from "./flowModel.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  // The plugin catalogue — used by the autocomplete provider to suggest
  // action names + input field names. The same prop CanvasTab takes.
  plugins:    { type: Array,  default: () => [] },
});
const emit = defineEmits(["update:modelValue"]);

const $q = useQuasar();

const buffer  = ref("");
const error   = ref("");
const focused = ref(false);
const editorHost = ref(null);

// CodeMirror view + its committed-text snapshot. The snapshot lets us
// detect "model changed externally but the editor's content matches
// what we last rendered, so don't bother dispatching a transaction."
let view = null;
let lastRenderedFromModel = "";

// ── Model ↔ buffer plumbing ──────────────────────────────────────────

function toDslShape(model) {
  return {
    name: model?.name || "untitled",
    nodes: (model?.nodes || []).map(n => {
      const out = { name: n.name, action: n.action };
      if (n.inputs  && Object.keys(n.inputs).length)  out.inputs  = { ...n.inputs };
      if (n.outputs && Object.keys(n.outputs).length) out.outputs = { ...n.outputs };
      if (n.executeIf) out.executeIf = n.executeIf;
      if (n.batchOver) out.batchOver = n.batchOver;
      return out;
    }),
    edges: (model?.edges || []).map(e => ({ from: e.from, to: e.to })),
  };
}

function renderFromModel(model) {
  try { return serializeDsl(toDslShape(model)); }
  catch (e) { return `# Failed to serialize: ${e.message}`; }
}

// External model change → reflect in the editor (only when unfocused
// so we don't trample the user's keystrokes).
watch(() => props.modelValue, (m) => {
  if (focused.value) return;
  const text = renderFromModel(m);
  buffer.value = text;
  lastRenderedFromModel = text;
  // If the view exists and shows different text, sync it. The
  // length check skips no-op transactions.
  if (view && view.state.doc.toString() !== text) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  }
}, { immediate: true, deep: true });

// ── Apply: parse buffer → merge into model ────────────────────────────

async function applyBuffer({ quiet = false } = {}) {
  let parsed;
  try {
    parsed = parseDsl(buffer.value);
  } catch (e) {
    error.value = e.message || String(e);
    if (!quiet) {
      $q.notify({ type: "negative", message: error.value, position: "bottom" });
    }
    return false;
  }
  error.value = "";

  const current = props.modelValue || {};
  const existingByName = new Map(
    (current.nodes || []).map(n => [n.name, n]),
  );
  const next = {
    ...current,
    name:  parsed.name,
    edges: (parsed.edges || []).map(e => ({ from: e.from, to: e.to })),
    nodes: (parsed.nodes || []).map(pn => {
      const ex = existingByName.get(pn.name) || {};
      return {
        name:        pn.name,
        action:      pn.action,
        inputs:      pn.inputs  || {},
        outputs:     pn.outputs || {},
        executeIf:   pn.executeIf || "",
        batchOver:   pn.batchOver || "",
        description: ex.description || "",
        retry:       ex.retry      || 0,
        retryDelay:  ex.retryDelay || 0,
        onError:     ex.onError    || "terminate",
        outputVar:   ex.outputVar  || "",
      };
    }),
  };

  const existingPositions = current?.meta?.positions || {};
  const mergedPositions = await mergePositionsWithLayout(next, existingPositions);
  next.meta = {
    ...(current.meta || {}),
    positions: mergedPositions,
  };

  lastRenderedFromModel = renderFromModel(next);
  emit("update:modelValue", next);
  if (!quiet) {
    $q.notify({ type: "positive", message: "Applied", timeout: 1200, position: "bottom" });
  }
  return true;
}

function onApply() { applyBuffer({ quiet: false }); }

function onCopy() {
  navigator.clipboard.writeText(buffer.value).then(
    () => $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" }),
    (e) => $q.notify({ type: "negative", message: `Copy failed: ${e?.message || e}`, position: "bottom" }),
  );
}

defineExpose({ applyBuffer });

// ── CodeMirror lifecycle ──────────────────────────────────────────────

// A theme that pulls colours from the app's CSS variables. Light/dark
// mode toggles work without re-creating the editor — variables resolve
// fresh on every paint.
const cmTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine":       { backgroundColor: "rgba(47, 109, 243, 0.04)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(47, 109, 243, 0.06)" },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(47, 109, 243, 0.20)",
  },
  ".cm-matchingBracket":     { backgroundColor: "rgba(47, 109, 243, 0.18)", color: "inherit" },
  ".cm-nonmatchingBracket":  { backgroundColor: "rgba(220, 38, 38, 0.18)" },
  // Autocomplete popup
  ".cm-tooltip": {
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border)",
    color: "var(--text)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "rgba(47, 109, 243, 0.18)",
    color: "var(--text)",
  },
});

onMounted(() => {
  const initialDoc = buffer.value || renderFromModel(props.modelValue || {});
  lastRenderedFromModel = initialDoc;

  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      history(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      dslLanguageSupport(),
      autocompletion({
        // The factory captures `props.plugins` lazily so a refresh of
        // the plugin list propagates without re-creating the editor.
        override: [dslCompletions(() => props.plugins || [])],
        activateOnTyping: true,
        closeOnBlur: true,
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      cmTheme,
      EditorView.lineWrapping,
      // Mirror doc changes into our `buffer` ref for the apply pipeline.
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          buffer.value = update.state.doc.toString();
        }
      }),
      // Focus tracking — CM doesn't surface focus/blur through
      // updateListener so we hook the DOM events directly.
      EditorView.domEventHandlers({
        focus: () => { focused.value = true; },
        blur:  () => {
          focused.value = false;
          // Same behaviour as the old textarea: apply pending edits on
          // blur so tab-switches commit naturally.
          if (buffer.value !== lastRenderedFromModel) {
            applyBuffer({ quiet: true });
          }
        },
      }),
    ],
  });

  view = new EditorView({ state, parent: editorHost.value });
});

onBeforeUnmount(async () => {
  // Best-effort commit so nav-away or mode toggle picks up the latest
  // text. Errors are swallowed — they've already been shown in the
  // editor's error bar.
  if (focused.value || buffer.value !== lastRenderedFromModel) {
    try { await applyBuffer({ quiet: true }); } catch { /* ignore */ }
  }
  view?.destroy();
  view = null;
});
</script>

<style scoped>
.code-tab { background: var(--bg); }
.code-toolbar {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.cm-host {
  width: 100%;
  min-height: 0;        /* let flex shrink the editor */
  overflow: hidden;
  background: var(--surface);
}
:deep(.cm-editor) {
  height: 100%;
  outline: none;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
.code-error {
  padding: 6px 12px;
  background: rgba(220, 38, 38, 0.08);
  color: #b91c1c;
  border-top: 1px solid rgba(220, 38, 38, 0.2);
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
