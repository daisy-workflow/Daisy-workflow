// CodeMirror 6 language + completion provider for the Daisy DSL.
//
// Why StreamLanguage and not a Lezer grammar?
//   StreamLanguage is a tiny line-at-a-time tokenizer — perfect for a
//   shallow surface-syntax DSL like ours. Lezer pays for itself when you
//   need real incremental parsing for things like LSP-grade analysis;
//   we only want colours + bracket pairs + keyword highlighting.
//
// Token categories we emit match @codemirror/language's defaultHighlightStyle:
//   keyword       → step, iterate, executeif
//   comment       → "# ..." to EOL
//   string        → "..." with \-escapes, and `...` with only \` as an escape
//   operator      → -->   (the edge arrow)
//   punctuation   → ( ) , : =
//   variableName  → identifiers (action names, step names, field names)
//   atom          → ${...} template references
//
// The completion provider is context-aware:
//   * after `=` on a step line   → suggest plugin action names
//   * inside an action's (…) ,   → suggest that plugin's input field names
//   * everywhere else            → suggest top-level keywords
//
// The plugin list comes in as a closure parameter (see dslCompletions
// factory below) so the editor stays decoupled from the FlowDesigner
// page — the host passes whichever plugin catalogue is in scope.

import { StreamLanguage, LanguageSupport } from "@codemirror/language";

const KEYWORDS = new Set(["step", "iterate", "executeif"]);

// ── Stream-based tokenizer ────────────────────────────────────────────
// `state` is just a placeholder here — we have no multi-line tokens
// (string literals stay on a single line by design). The structure is
// kept around in case we want to add fenced blocks later.
const dslStream = StreamLanguage.define({
  startState() { return {}; },

  token(stream /*, state */) {
    if (stream.eatSpace()) return null;

    // Line comment.
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "lineComment";
    }

    // Edge arrow — must be checked BEFORE plain "-" / ">" punctuation.
    if (stream.match("-->")) return "operator";

    // Double-quoted string: backslash escapes any single character.
    if (stream.match('"')) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") { stream.next(); continue; }
        if (ch === '"') return "string";
      }
      // Unterminated — still colour it as string so the user sees the
      // missing closer instead of cascading the entire rest of the file
      // as a syntax error.
      return "string";
    }

    // Backtick string: only \` is an escape; everything else is literal,
    // including ${…} template refs (we re-emit those as `atom` for
    // visibility via a separate token below if they appear OUTSIDE a
    // string — inside a backtick they're already coloured `string`).
    if (stream.match("`")) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\" && stream.peek() === "`") { stream.next(); continue; }
        if (ch === "`") return "string";
      }
      return "string";
    }

    // Template reference outside of strings (rare but valid in our DSL
    // surface — e.g. inside an unquoted FEEL expression). Highlight so
    // users notice the substitution.
    if (stream.match(/^\$\{[^}]*\}/)) return "atom";

    // Single-char punctuation.
    if (stream.match(/^[(),:=]/)) return "punctuation";

    // Identifier — keyword vs name. Action names allow dots (file.write)
    // and hyphens (some plugin authors use them).
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_.\-]*/)) {
      const tok = stream.current();
      if (KEYWORDS.has(tok)) return "keyword";
      return "variableName";
    }

    // Anything else — advance one char so we don't loop forever.
    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "#" },
    closeBrackets: { brackets: ["(", '"', "`"] },
    autocomplete: undefined,   // wired separately via autocompletion()
  },
});

/**
 * Wrap the StreamLanguage in a LanguageSupport bundle so callers can
 * pass a single extension to EditorState.
 */
export function dslLanguageSupport() {
  return new LanguageSupport(dslStream);
}

// ── Completion provider ───────────────────────────────────────────────
//
// Returns a completion function suitable for `autocompletion({override:[…]})`.
// The host passes the live plugin catalogue so completions stay accurate
// when new plugins are installed.

/**
 * Build a CompletionSource that knows about the current plugin list.
 *
 * @param {() => Array<Plugin>} getPlugins  reactive accessor — called each
 *   time completion is requested so we always see the latest catalogue.
 */
export function dslCompletions(getPlugins) {
  return (context) => {
    const pluginList = (typeof getPlugins === "function" ? getPlugins() : getPlugins) || [];

    // What's the word right before the cursor?
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.\-]*/);
    const explicit = context.explicit;
    if (!word && !explicit) return null;
    const from = word ? word.from : context.pos;

    // Slice of source preceding the cursor — used for heuristics.
    const before = context.state.doc.sliceString(0, from);

    // ── Case 1: inside an action's (… , … , …) parameter list ──
    // Walk back to find an unclosed "(" (depth = 0). If we find one
    // AND the bit immediately before it looks like `= actionName`,
    // suggest that plugin's input field names.
    {
      let depth = 0, openIdx = -1;
      for (let i = before.length - 1; i >= 0; i--) {
        const c = before[i];
        if (c === ")") depth++;
        else if (c === "(") {
          if (depth === 0) { openIdx = i; break; }
          depth--;
        }
      }
      if (openIdx >= 0) {
        const tail = before.slice(0, openIdx);
        const m = tail.match(/=\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*$/);
        if (m) {
          const actionName = m[1];
          const plugin = pluginList.find(p => p.name === actionName);
          if (plugin) {
            // Try both shapes — some plugins ship the JSON-Schema
            // wrapper, others a flat { fieldName: type } map.
            const fields = plugin.inputSchema?.properties
                        ?? plugin.inputSchema
                        ?? {};
            const options = Object.keys(fields).map(k => ({
              label: k,
              type:  "property",
              detail: typeof fields[k] === "string"
                ? fields[k]
                : (fields[k]?.type || ""),
              info:   typeof fields[k] === "object" ? fields[k]?.description : undefined,
              apply:  k + ": ",
            }));
            if (options.length) return { from, options };
          }
        }
      }
    }

    // ── Case 2: just after `=` on a step line → action names ──
    // Look at the current line: did we cross an `=` since the previous
    // newline (and no `(` between the `=` and the cursor)?
    {
      const nl = before.lastIndexOf("\n");
      const lineToCursor = before.slice(nl + 1);
      const eq = lineToCursor.lastIndexOf("=");
      const op = lineToCursor.lastIndexOf("(");
      if (eq >= 0 && eq > op && /\bstep\b/.test(lineToCursor.slice(0, eq))) {
        const options = pluginList.map(p => ({
          label:  p.name,
          type:   "function",
          detail: p.category || "",
          info:   p.description || "",
        }));
        if (options.length) return { from, options };
      }
    }

    // ── Case 3: anywhere else → keywords + edge arrow ──
    return {
      from,
      options: [
        { label: "step",      type: "keyword", info: "Declare a workflow step" },
        { label: "iterate",   type: "keyword", info: "Batch over a list expression" },
        { label: "executeif", type: "keyword", info: "Conditional execution gate" },
        { label: "-->",       type: "keyword", info: "Edge: connect step to step" },
      ],
    };
  };
}
