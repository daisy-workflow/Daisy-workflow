// @daisy-workflow/dsl — public entry point.
//
// Two functions for everyday use:
//
//   parse(text)       → Daisy JSON model     (throws on syntax error)
//   serialize(model)  → DSL text             (throws on bad input)
//
// Plus the lower-level pieces if a host application needs them:
//
//   tokenize(text)    → token stream (lexer)
//   Parser            → recursive-descent parser class
//
// Round-trip contract (idempotent up to formatting normalisation):
//
//   parse(serialize(model))           === structurally equivalent model
//   serialize(parse(serialize(m)))    === serialize(m)   (byte-equal)
//
// The first round-trip will normalise field ordering inside steps and
// collapse one-line inputs/outputs where they fit — see serializer.js
// for the exact formatting rules. The second is byte-stable.

export { parse }     from "./parser.js";
export { serialize, quote } from "./serializer.js";
export { tokenize }  from "./lexer.js";
