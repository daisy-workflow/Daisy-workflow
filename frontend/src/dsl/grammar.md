# Daisy DSL — Grammar

The DSL is a thin surface syntax over the Daisy JSON workflow model. Parsing
produces an AST that maps 1:1 onto the JSON fields the engine already
understands; serialising the JSON model back to text is the inverse.

## EBNF

```
program     ::= name step* edge*

step        ::= "step" step_name ( "(" additions? ")" )? "=" plugin_name inputs ( ":" outputs )?
additions   ::= addition ( "," addition )*
addition    ::= "iterate"   expression
              | "executeif" expression

inputs      ::= "(" ( arg ( "," arg )* )? ")"
outputs     ::= "(" ( arg ( "," arg )* )? ")"
arg         ::= identifier ":" expression

edge        ::= step_name "-->" step_name

name        ::= STRING                  # the workflow's display name
step_name   ::= IDENT                   # the DAG-level node name
plugin_name ::= IDENT                   # action / plugin name (e.g. agent, file.write)
identifier  ::= IDENT                   # input / output key

expression  ::= STRING                  # quoted value; may contain `${FEEL}` placeholders
```

Tokens:

| Token     | Pattern |
|-----------|---------|
| `STRING`  | `"..."` *(with `\"`, `\\`, `\n`, `\t`, `\r` escapes)* &nbsp; **or** &nbsp; `` `...` `` *(only `` \` `` is special — everything else is literal)* |
| `IDENT`   | `[A-Za-z_][A-Za-z0-9_.\-]*` |
| Keywords  | `step`, `iterate`, `executeif` (reserved — can't be used as IDENT) |
| Punct     | `=`, `:`, `(`, `)`, `,`, `-->` |
| Comments  | `#` to end of line — stripped during lexing |

Whitespace and comments are insignificant. Newlines are not statement
terminators — the parser uses keywords + punctuation to delimit constructs.

### Why two string styles

The double-quoted form is the standard escape-everything style. Use it
when you want clear visual quoting of short values:

```
input: "hello"
```

The backtick form is for values that themselves contain `"` or `'`,
which is common with FEEL expressions and raw text. Nothing inside
backticks is escaped except `` \` `` for a literal backtick:

```
expression: `${verdict.urgency = "high"}`     # no \" needed
prompt:     `Hey "world", how's it going?`
```

The serializer picks whichever style produces less escape noise when
emitting — backticks win when the value contains `"` and no `` ` ``,
double-quotes win otherwise.

## Example

```
"Auto-archive payment invoices"

step classify = agent(
  agent: "EmailTriage",
  input: "${input.subject}\n\n${input.body}"
) : (verdict: "result")

step guard (executeif "${verdict.urgency = \"high\"}") = transform(
  expression: "{}"
)

step save = file.write(
  path:    "/archive/${verdict.vendor}.json",
  content: "${toJson(verdict)}"
)

classify --> guard
guard    --> save
```

Maps to the JSON shape the Daisy engine consumes:

```json
{
  "name": "Auto-archive payment invoices",
  "nodes": [
    {
      "name":    "classify",
      "action":  "agent",
      "inputs":  { "agent": "EmailTriage", "input": "${input.subject}\n\n${input.body}" },
      "outputs": { "verdict": "result" }
    },
    {
      "name":      "guard",
      "action":    "transform",
      "executeIf": "${verdict.urgency = \"high\"}",
      "inputs":    { "expression": "{}" }
    },
    {
      "name":   "save",
      "action": "file.write",
      "inputs": {
        "path":    "/archive/${verdict.vendor}.json",
        "content": "${toJson(verdict)}"
      }
    }
  ],
  "edges": [
    { "from": "classify", "to": "guard" },
    { "from": "guard",    "to": "save" }
  ]
}
```

## Notes on round-tripping

- **Comments are not preserved.** Serialising a parsed model emits no `#`
  lines. If users want comments to survive a canvas edit + re-serialise,
  we'd need to attach them to AST nodes and re-emit on the way out.
- **Position metadata (canvas x/y) lives in `meta.positions`**, not the DSL.
  Same goes for `meta.notes`. The DSL is for engine semantics; visual
  layout stays in the JSON's `meta` block.
- **Field ordering** is normalised by the serializer (name → action →
  additions → inputs → outputs) so two equivalent workflows always
  serialise to the same text, regardless of how the JSON was authored.
