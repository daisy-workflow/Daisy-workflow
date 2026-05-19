// Parser — recursive-descent over the token stream.
//
// Returns the Daisy JSON model directly (no separate AST) — the grammar
// maps 1:1 onto the engine's workflow shape, so an intermediate AST
// would just be a renaming pass.
//
// Output:
//   {
//     name:  "workflow display name",
//     nodes: [{ name, action, inputs, outputs?, batchOver?, executeIf? }],
//     edges: [{ from, to }]
//   }
//
// Error reporting: every parser throw carries the offending token's
// line + column so the editor can squiggle the right spot. We never
// silently recover — the first syntax error halts and surfaces.

import { tokenize } from "./lexer.js";

export function parse(source) {
  const tokens = tokenize(source);
  const p = new Parser(tokens);
  return p.program();
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos    = 0;
  }

  // ── primitives ──────────────────────────────────────────────────────
  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  eof()            { return this.peek().type === "EOF"; }

  match(type, value) {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  consume(type, value, ctx = "") {
    const t = this.peek();
    if (!this.match(type, value)) {
      const want = value !== undefined ? `${type}(${JSON.stringify(value)})` : type;
      this.fail(`expected ${want}${ctx ? " " + ctx : ""}, got ${describe(t)}`, t);
    }
    this.pos++;
    return t;
  }

  fail(msg, token) {
    const err = new Error(
      `Parse error: ${msg} (line ${token.line}, col ${token.col})`,
    );
    err.name = "DslParseError";
    err.line = token.line;
    err.col  = token.col;
    throw err;
  }

  // ── productions ─────────────────────────────────────────────────────
  //
  // program ::= name step* edge*

  program() {
    const name = this.consume("STRING", undefined, "for workflow name").value;
    const nodes = [];
    const edges = [];

    // Steps must precede edges (per the grammar). Stop step-parsing as
    // soon as we see an edge-shaped run (IDENT ARROW), or EOF.
    while (this.match("KEYWORD", "step")) {
      nodes.push(this.step());
    }

    while (!this.eof()) {
      // Anything that's not an edge at this point is a syntax error —
      // the grammar doesn't allow steps after edges. The dedicated
      // message helps users who accidentally interleave them.
      if (!(this.match("IDENT") && this.peek(1)?.type === "ARROW")) {
        if (this.match("KEYWORD", "step")) {
          this.fail("steps must precede edges; move this `step` above the first --> line", this.peek());
        }
        this.fail(`unexpected ${describe(this.peek())} — expected an edge (a --> b) or end of file`, this.peek());
      }
      edges.push(this.edge());
    }

    return { name, nodes, edges };
  }

  // step ::= "step" step_name ( "(" additions? ")" )? "=" plugin_name inputs ( ":" outputs )?
  step() {
    this.consume("KEYWORD", "step");
    const nameTok = this.consume("IDENT", undefined, "for step name");

    // Additions wrapper `( ... )` is optional. When present it may also
    // be empty — `step n () = ...` is legal but vacuous. The wrapper
    // disambiguates additions from the `=` that follows.
    const additions = this.additionsWrapperOpt();

    this.consume("PUNCT", "=", "after step name (and additions wrapper, if any)");

    const pluginTok = this.consume("IDENT", undefined, "for plugin name");
    const inputs    = this.inputs();

    let outputs;
    if (this.match("PUNCT", ":")) {
      this.pos++;
      outputs = this.outputs();
    }

    const node = {
      name:    nameTok.value,
      action:  pluginTok.value,
      inputs,
    };
    if (outputs && Object.keys(outputs).length) node.outputs = outputs;
    if (additions.batchOver !== undefined)      node.batchOver = additions.batchOver;
    if (additions.executeIf !== undefined)      node.executeIf = additions.executeIf;
    return node;
  }

  // additions-wrapper ::= "(" additions? ")"   — whole wrapper is optional,
  // so when we don't see an opening "(" we return {} immediately.
  // When we DO see "(", an empty pair `()` is allowed (vacuous wrapper).
  additionsWrapperOpt() {
    if (!this.match("PUNCT", "(")) return {};
    this.pos++;                              // consume "("
    const out = {};
    if (this.match("PUNCT", ")")) { this.pos++; return out; }  // empty wrapper

    while (true) {
      const t = this.peek();
      if (t.type !== "KEYWORD" || (t.value !== "iterate" && t.value !== "executeif")) {
        this.fail(`expected "iterate" or "executeif" inside the step's additions wrapper, got ${describe(t)}`, t);
      }
      this.pos++;
      const exprTok = this.consume("STRING", undefined, `for ${t.value} expression`);
      if (t.value === "iterate")    out.batchOver = exprTok.value;
      if (t.value === "executeif")  out.executeIf = exprTok.value;
      if (!this.match("PUNCT", ",")) break;
      this.pos++;
    }
    this.consume("PUNCT", ")", "to close the step's additions wrapper");
    return out;
  }

  // inputs ::= "(" ( arg ( "," arg )* )? ")"
  inputs() { return this.args("inputs"); }

  // outputs ::= "(" ( arg ( "," arg )* )? ")"
  outputs() { return this.args("outputs"); }

  args(kind) {
    this.consume("PUNCT", "(", `to start ${kind}`);
    const out = {};
    if (this.match("PUNCT", ")")) { this.pos++; return out; }  // empty list

    while (true) {
      const keyTok = this.consume("IDENT", undefined, `for ${kind} key`);
      this.consume("PUNCT", ":", `after ${kind} key "${keyTok.value}"`);
      const valTok = this.consume("STRING", undefined, `for ${kind}.${keyTok.value} value`);
      out[keyTok.value] = valTok.value;
      if (!this.match("PUNCT", ",")) break;
      this.pos++;
      // Trailing comma is permitted — many editors auto-insert one when
      // the user adds a line, and reordering args by line is a common
      // operation. Treat `,` followed immediately by `)` as the end of
      // the list rather than a syntax error.
      if (this.match("PUNCT", ")")) break;
    }
    this.consume("PUNCT", ")", `to close ${kind}`);
    return out;
  }

  // edge ::= step_name "-->" step_name
  edge() {
    const from = this.consume("IDENT", undefined, "for edge source").value;
    this.consume("ARROW");
    const to   = this.consume("IDENT", undefined, "for edge target").value;
    return { from, to };
  }
}

function describe(token) {
  if (token.type === "EOF") return "end of file";
  if (token.type === "STRING") return `string ${JSON.stringify(token.value)}`;
  if (token.type === "IDENT" || token.type === "KEYWORD")
    return `${token.type.toLowerCase()} ${JSON.stringify(token.value)}`;
  return `${token.type} ${JSON.stringify(token.value)}`;
}
