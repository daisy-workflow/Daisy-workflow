// Shared model + (de)serialization for the FlowDesigner.
//
// The visual editor works on a normalized in-memory model:
//
//   {
//     name, description,
//     data:   { ... },                                 // top-level constants
//     meta: {
//       prompt:    "...",                              // AI generation prompt
//       positions: { <nodeName>: { x, y } },           // canvas layout
//     },
//     nodes: [{ name, action, description, inputs, outputs,
//                executeIf, retry, retryDelay, onError, batchOver }],
//     edges: [{ from, to }],
//   }
//
// The on-disk + on-the-wire format is **JSON**. (Earlier revisions stored
// YAML; that format is gone end-to-end.)
//
// `version` is intentionally NOT part of the authored model — it is managed
// server-side (auto-incremented per save). Legacy files that carry a
// `version` key are accepted on parse but the value is dropped on
// re-serialization, so saved JSON never contains it.

export function emptyModel(name = "new-flow") {
  return {
    name,
    description: "",
    data: {},
    meta: { prompt: "", positions: {} },
    nodes: [
      {
        name: "hello",
        action: "log",
        description: "",
        inputs: { message: "hi" },
        outputs: {},
        executeIf: "",
        retry: 0,
        retryDelay: 0,
        onError: "terminate",
        batchOver: "",
      },
    ],
    edges: [],
  };
}

/**
 * Parse a DSL string into the normalized model.
 *
 * Accepts:
 *   - JSON text (preferred)
 *   - an empty string  → empty model
 *
 * Throws on malformed JSON.
 */
export function parseDslToModel(text) {
  if (text == null || text === "") return normalize({});
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  return normalize(parsed || {});
}

// Backwards-compatible alias for the old callsites that still import the
// YAML-named function. New code should call parseDslToModel().
export const parseYamlToModel = parseDslToModel;

/** Take any (parsed or raw) shape and produce the normalized in-memory model. */
export function normalize(parsed) {
  const meta = { prompt: "", positions: {}, notes: [], ...(parsed.meta || {}) };
  // notes is an annotation layer over the canvas — text, position,
  // optional id. Normalised here so the canvas + serializer don't have
  // to defensively guard each field downstream.
  meta.notes = (meta.notes || []).map((n, i) => ({
    id:   String(n.id || `note-${i}-${Date.now()}`),
    text: String(n.text || ""),
    x:    Number.isFinite(n.x) ? Number(n.x) : 100 + i * 24,
    y:    Number.isFinite(n.y) ? Number(n.y) : 100 + i * 24,
  }));
  return {
    name:        parsed.name || "untitled",
    description: parsed.description || "",
    data:        parsed.data || {},
    meta,
    nodes:       (parsed.nodes || []).map(normalizeNode),
    edges:       (parsed.edges || []).map(e => ({ from: e.from, to: e.to })),
  };
}

function normalizeNode(n) {
  return {
    name:        n.name || "",
    action:      n.action || "",
    description: n.description || "",
    inputs:      kvFromAny(n.inputs),
    outputs:     kvFromAny(n.outputs),
    executeIf:   n.executeIf || "",
    retry:       n.retry || 0,
    retryDelay:  n.retryDelay || 0,
    onError:     n.onError || "terminate",
    batchOver:   n.batchOver || "",
    outputVar:   n.outputVar || "",
  };
}

/** Accept either object form { k: v } or array form [{ k: v }] and return a flat object. */
function kvFromAny(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out = {};
    for (const item of value) {
      if (item && typeof item === "object") Object.assign(out, item);
    }
    return out;
  }
  return { ...value };
}

/**
 * Serialize the normalized model to JSON.
 *
 * Empty / default fields are pruned so the output stays compact and human-
 * readable. The `inputs` / `outputs` maps are emitted as plain objects
 * (the engine accepts both forms but objects are the natural JSON shape).
 */
export function serializeModelToDsl(model) {
  const out = { name: model.name };
  if (model.description) out.description = model.description;

  const meta = {};
  if (model.meta?.prompt) meta.prompt = model.meta.prompt;
  if (model.meta?.positions && Object.keys(model.meta.positions).length) {
    meta.positions = model.meta.positions;
  }
  if (Array.isArray(model.meta?.notes) && model.meta.notes.length) {
    // Only include notes that actually have content — empty ones the
    // user dropped and abandoned shouldn't pollute the saved DSL.
    const kept = model.meta.notes
      .filter(n => n && (String(n.text || "").trim() !== ""))
      .map(n => ({
        id:   String(n.id),
        text: String(n.text || ""),
        x:    Math.round(Number(n.x) || 0),
        y:    Math.round(Number(n.y) || 0),
      }));
    if (kept.length) meta.notes = kept;
  }
  if (Object.keys(meta).length) out.meta = meta;

  if (model.data && Object.keys(model.data).length) out.data = model.data;

  out.nodes = (model.nodes || []).map(serializeNode);
  if (model.edges?.length) out.edges = model.edges.map(e => ({ from: e.from, to: e.to }));

  return JSON.stringify(out, null, 2);
}

// Backwards-compatible alias for the old callsites.
export const serializeModelToYaml = serializeModelToDsl;

function serializeNode(n) {
  const out = { name: n.name, action: n.action };
  if (n.description)     out.description = n.description;
  if (n.inputs  && Object.keys(n.inputs).length)  out.inputs  = { ...n.inputs };
  if (n.outputs && Object.keys(n.outputs).length) out.outputs = { ...n.outputs };
  if (n.executeIf)              out.executeIf  = n.executeIf;
  if (n.retry)                  out.retry      = n.retry;
  if (n.retryDelay)             out.retryDelay = n.retryDelay;
  if (n.onError && n.onError !== "terminate") out.onError = n.onError;
  if (n.batchOver)              out.batchOver  = n.batchOver;
  if (n.outputVar)              out.outputVar  = n.outputVar;
  return out;
}

/** Generate a unique node name based on a prefix (action shortname). */
export function uniqueNodeName(model, prefix) {
  const taken = new Set((model.nodes || []).map(n => n.name));
  const base = (prefix || "node").split(".").pop().replace(/[^A-Za-z0-9_-]/g, "_") || "node";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base + "-" + Date.now();
}

/** Trigger a browser download of `text` as `filename`. */
export function downloadText(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Compute auto-layout positions for nodes that have no entry in
 * `existingPositions`. Surviving nodes keep their user-tuned coordinates;
 * dagre runs over the whole graph but only its output for newly-added
 * ("orphan") nodes is adopted. This is the merge used by the code editor
 * when saving — code-mode users never touch positions directly, so we
 * fill them in here.
 *
 * Lives in flowModel.js (not useLayout.js) because this is a pure-data
 * helper — no VueFlow ids, no DOM. Callers pass the normalised model
 * keyed by node NAME and get positions keyed by node NAME back.
 *
 * @param {object} model  normalised flow model — nodes/edges by name
 * @param {object} existingPositions  { [nodeName]: { x, y } }
 * @returns {object}  merged positions keyed by node name
 */
export async function mergePositionsWithLayout(model, existingPositions = {}) {
  const out = {};
  // Phase 1: carry over surviving positions.
  const existing = existingPositions || {};
  const live = new Set((model.nodes || []).map(n => n.name));
  for (const name of live) {
    const p = existing[name];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out[name] = { x: p.x, y: p.y };
    }
  }
  // Phase 2: orphans get coords from a fresh dagre layout.
  const orphans = (model.nodes || []).filter(n => !out[n.name]);
  if (!orphans.length) return out;

  // Dynamic import keeps dagre out of the critical-path bundle for
  // callers that don't ever hit the merge (visual-mode users).
  const dagre = (await import("dagre")).default;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 80 });
  for (const n of model.nodes || []) {
    g.setNode(n.name, { width: 170, height: 60 });
  }
  for (const e of model.edges || []) {
    if (e && e.from && e.to) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  for (const n of orphans) {
    const node = g.node(n.name);
    if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      // Match useLayout's centre→origin shift (170×60 box).
      out[n.name] = { x: node.x - 85, y: node.y - 30 };
    }
  }
  return out;
}

/** Read a single user-selected file as text. Returns a Promise<string>. */
export function pickFileAsText(accept = ".json,.txt") {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
