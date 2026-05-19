// Lexer — turns a DSL source string into a flat token stream.
//
// Tokens fall into five buckets:
//
//   • Keywords      — "step", "iterate", "executeif"
//                     Recognised by exact match against IDENT lookups.
//   • Identifiers   — bare-word names for steps / plugins / arg keys.
//                     Pattern: [A-Za-z_][A-Za-z0-9_.-]*  (dots + hyphens
//                     allowed for plugin names like "file.write" and
//                     "agent-v2").
//   • Strings       — double-quoted, with \\ and \" escapes. Used for
//                     the workflow name and every `expression`. Newlines
//                     inside strings are allowed and preserved verbatim,
//                     so multi-line FEEL expressions / prompts work.
//   • Punctuation   — "=", ":", "(", ")", ",", "-->"
//   • EOF           — sentinel; the parser uses it instead of length-checks
//
// Comments (`# ...`) and whitespace are skipped at the lexer level and
// never reach the parser.
//
// Every token carries a 1-based line + column so error reporting can
// point at the exact glyph that misparsed.

const KEYWORDS = new Set(["step", "iterate", "executeif"]);

export function tokenize(source) {
  if (typeof source !== "string") {
    throw new TypeError("tokenize: expected a string source");
  }

  const tokens = [];
  let i = 0;
  let line = 1;
  let col  = 1;
  const N  = source.length;

  // Track the byte position of the most recent newline so column = i - colAnchor + 1.
  let colAnchor = 0;
  const here = () => ({ line, col: i - colAnchor + 1 });

  while (i < N) {
    const c = source[i];

    // ── whitespace ──────────────────────────────────────────────────
    if (c === "\n") { i++; line++; colAnchor = i; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }

    // ── comments ────────────────────────────────────────────────────
    if (c === "#") {
      while (i < N && source[i] !== "\n") i++;
      continue;
    }

    // ── multi-char punctuation ──────────────────────────────────────
    if (c === "-" && source[i + 1] === "-" && source[i + 2] === ">") {
      tokens.push({ type: "ARROW", value: "-->", ...here() });
      i += 3;
      continue;
    }

    // ── single-char punctuation ─────────────────────────────────────
    if (c === "=" || c === ":" || c === "(" || c === ")" || c === ",") {
      tokens.push({ type: "PUNCT", value: c, ...here() });
      i++;
      continue;
    }

    // ── strings ─────────────────────────────────────────────────────
    //
    // Two delimiter styles, both produce a STRING token with the same
    // decoded `value`:
    //
    //   "..."   — standard, with C-style escapes:
    //               \"   \\   \n   \t   \r
    //             Unknown sequences are kept verbatim (including the
    //             leading backslash) so `\$` inside FEEL survives.
    //
    //   `...`   — raw-ish: nothing inside is escaped EXCEPT a literal
    //             backtick, written `\``. A backslash followed by
    //             anything else is two literal characters. Lets users
    //             paste FEEL expressions / paths / quotes without a
    //             pile of `\"` to escape inner double quotes.
    //
    // Both styles allow embedded newlines, which are preserved
    // verbatim in the resulting value.
    if (c === '"' || c === "`") {
      const open       = c;
      const startLine  = line;
      const startCol   = i - colAnchor + 1;
      let value = "";
      i++; // consume opening delimiter

      while (i < N && source[i] !== open) {
        const ch = source[i];

        if (open === '"' && ch === "\\") {
          // Double-quoted: full escape handling
          const next = source[i + 1];
          if (next === '"')  { value += '"';  i += 2; continue; }
          if (next === "\\") { value += "\\"; i += 2; continue; }
          if (next === "n")  { value += "\n"; i += 2; continue; }
          if (next === "t")  { value += "\t"; i += 2; continue; }
          if (next === "r")  { value += "\r"; i += 2; continue; }
          // Unknown escape — keep both chars (rounds back through the
          // serializer unchanged for FEEL's `\$` and similar).
          value += ch + (next ?? "");
          i += next == null ? 1 : 2;
          continue;
        }

        if (open === "`" && ch === "\\") {
          // Backtick: only `\`` is special. Everything else (including
          // `\\`) is literal. This intentionally diverges from double-
          // quoted strings to keep the backtick form's promise of
          // "no escaping needed".
          const next = source[i + 1];
          if (next === "`") { value += "`"; i += 2; continue; }
          value += ch;
          i++;
          continue;
        }

        if (ch === "\n") { line++; colAnchor = i + 1; }
        value += ch;
        i++;
      }
      if (i >= N) {
        throw lexError(
          `unterminated string starting at line ${startLine}, col ${startCol}`,
          startLine, startCol,
        );
      }
      i++; // consume closing delimiter
      tokens.push({ type: "STRING", value, line: startLine, col: startCol });
      continue;
    }

    // ── identifiers + keywords ──────────────────────────────────────
    if (isIdentStart(c)) {
      const startLine = line;
      const startCol  = i - colAnchor + 1;
      let j = i + 1;
      while (j < N && isIdentCont(source[j])) j++;
      const word = source.slice(i, j);
      const type = KEYWORDS.has(word) ? "KEYWORD" : "IDENT";
      tokens.push({ type, value: word, line: startLine, col: startCol });
      i = j;
      continue;
    }

    // ── unknown character ───────────────────────────────────────────
    throw lexError(`unexpected character ${JSON.stringify(c)}`, line, i - colAnchor + 1);
  }

  tokens.push({ type: "EOF", value: null, line, col: i - colAnchor + 1 });
  return tokens;
}

function isIdentStart(c) {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}
function isIdentCont(c) {
  return isIdentStart(c) || (c >= "0" && c <= "9") || c === "." || c === "-";
}

function lexError(message, line, col) {
  const err = new Error(`Lex error: ${message} (line ${line}, col ${col})`);
  err.name = "DslLexError";
  err.line = line;
  err.col  = col;
  return err;
}
