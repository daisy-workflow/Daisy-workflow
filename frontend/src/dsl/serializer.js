// Serializer — Daisy JSON model → DSL text.
//
// Inverse of parser.js. Formatting choices:
//
//   • Workflow name on its own line, followed by a blank line.
//   • One step per logical statement. Inputs / outputs land on indented
//     lines inside the parens — readable when there are more than ~2
//     args, otherwise we collapse to a one-liner.
//   • Edges go at the bottom, one per line, separated from steps by a
//     blank line.
//   • Field order inside a step is deterministic:
//       step <name> [iterate "..."] [executeif "..."] = <action>(
//         <input1>: "...",
//         <input2>: "...",
//       ) : (
//         <output1>: "...",
//       )
//     so two semantically-equal workflows always serialise to the same
//     text, regardless of how their JSON was authored.

const ONE_LINE_THRESHOLD = 2;   // collapse inputs/outputs to one line at <= this many entries

export function serialize(model) {
  if (!model || typeof model !== "object") {
    throw new TypeError("serialize: model must be an object");
  }

  const out = [];
  out.push(quote(String(model.name ?? "")));

  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  if (nodes.length) out.push("");
  for (const node of nodes) {
    out.push(serializeStep(node));
  }

  const edges = Array.isArray(model.edges) ? model.edges : [];
  if (edges.length) out.push("");
  for (const e of edges) {
    if (e?.from && e?.to) {
      out.push(`${e.from} --> ${e.to}`);
    }
  }

  return out.join("\n") + "\n";
}

function serializeStep(node) {
  const parts = [`step ${node.name}`];

  // Additions order: iterate first, executeif second. Both optional.
  // The grammar wraps additions in `( ... )` to disambiguate them from
  // the `=` that follows; we emit the wrapper only when there's at
  // least one addition — empty wrappers are legal but visually noisy.
  const additions = [];
  if (node.batchOver) additions.push(`iterate ${quote(node.batchOver)}`);
  if (node.executeIf) additions.push(`executeif ${quote(node.executeIf)}`);
  if (additions.length) parts.push(`(${additions.join(", ")})`);

  parts.push("=");
  parts.push(node.action);

  const head = parts.join(" ");
  const inputsBlock  = renderArgs(node.inputs  || {});
  const outputsBlock = renderArgs(node.outputs || {});

  if (!Object.keys(node.outputs || {}).length) {
    return `${head}${inputsBlock}`;
  }
  return `${head}${inputsBlock} : ${outputsBlock}`;
}

function renderArgs(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return "()";

  if (entries.length <= ONE_LINE_THRESHOLD) {
    const inline = entries.map(([k, v]) => `${k}: ${quote(String(v))}`).join(", ");
    // Quick check — if the rendered one-liner would be very long (e.g. a
    // single FEEL expression that's 200 chars), prefer the multi-line
    // form anyway. Keeps `step` lines from running off the screen.
    if (`(${inline})`.length <= 80) return `(${inline})`;
  }

  const lines = entries.map(([k, v]) => `  ${k}: ${quote(String(v))},`);
  return "(\n" + lines.join("\n") + "\n)";
}

// Quote a value as a DSL string literal. We prefer the style that
// produces the least escape noise:
//
//   • If the value contains a `"` and NO `` ` ``, emit a backtick
//     literal — no escaping needed for the inner quotes, which is the
//     whole reason backticks exist.
//   • Otherwise emit a standard `"..."` with \"  \\  \n  escapes.
//
// This keeps re-serialised FEEL expressions and snippets readable:
//
//     `${verdict.urgency = "high"}`         ← preferred
//     "${verdict.urgency = \"high\"}"        ← only when value has both " AND `
//
// Round-trip parses both back to the same string.
export function quote(s) {
  const text = String(s);
  const hasDouble   = text.includes('"');
  const hasBacktick = text.includes("`");

  // Prefer backticks when they save us escape noise.
  if (hasDouble && !hasBacktick) {
    return "`" + text + "`";          // nothing to escape inside backticks
  }

  // Standard double-quoted form. Order matters — escape backslashes
  // first so subsequent escape-injections don't get re-escaped.
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}
