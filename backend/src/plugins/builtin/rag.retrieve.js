// rag.retrieve — fetch top-K matching chunks from a Knowledge Base.
//
// Typical wiring in a workflow:
//
//   - name: retrieve_context
//     action: rag.retrieve
//     inputs:
//       kbId:  "${vars.kbId}"      # or hard-coded UUID
//       query: "${vars.question}"
//       topK: 5
//     outputs:
//       context: context
//       matches: matches
//
//   - name: answer
//     action: agent
//     inputs:
//       agent: "Support QA"
//       input: |
//         Context:
//         ${retrieve_context.context}
//
//         Question:
//         ${vars.question}
//
// `context` is the concatenated chunk text — meant for pasting straight
// into an agent prompt. `matches` carries the per-chunk hits (with
// score + metadata + document_id) for when the workflow wants to do
// per-source attribution or filtering.

import { retrieve } from "../../rag/ingest.js";

export default {
  name: "rag.retrieve",
  description:
    "Search a Knowledge Base by semantic similarity. Returns the top-K " +
    "matching chunks plus a concatenated `context` string ready to drop " +
    "into an agent prompt.",
  inputSchema: {
    type: "object",
    required: ["kbId", "query"],
    properties: {
      kbId: {
        type: "string",
        title: "Knowledge Base ID",
        description:
          "UUID of the KB to query. Manage KBs from the Admin page → " +
          "Knowledge Bases.",
      },
      query: {
        type: "string",
        title: "Query",
        format: "textarea",
        description:
          "Text the KB will be searched against. Usually a `${var}` " +
          "reference to user input or an upstream node's output.",
      },
      topK: {
        type: "integer",
        title: "Top K",
        minimum: 1,
        maximum: 50,
        default: 5,
        description: "Number of chunks to return. Higher = more context, more tokens.",
      },
      minScore: {
        type: "number",
        title: "Minimum cosine score",
        minimum: 0,
        maximum: 1,
        default: 0,
        description:
          "Drop chunks below this similarity score (0–1). Useful for " +
          "avoiding hallucinated context when no good match exists.",
      },
      separator: {
        type: "string",
        title: "Context separator",
        default: "\n\n---\n\n",
        description:
          "String joined between chunks when building the `context` " +
          "output. Default is a markdown horizontal rule with blank " +
          "lines on either side.",
      },
    },
  },

  // Default ctx[outputVar] = concatenated text — that's the field
  // most workflows want to splice straight into an agent input.
  primaryOutput: "context",

  outputSchema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description:
          "All retrieved chunks joined by `separator`. Empty string when " +
          "no chunks meet `minScore`.",
      },
      matches: {
        type: "array",
        description: "Per-chunk hits: { id, document_id, ordinal, content, metadata, score }.",
      },
      count: {
        type: "integer",
        description: "Length of `matches`.",
      },
    },
  },

  async execute(input, ctx, hooks) {
    const r = await retrieve({
      kbId:     String(input.kbId || ""),
      query:    String(input.query || ""),
      topK:     input.topK || 5,
      minScore: input.minScore || 0,
      ctx:      { executionId: ctx?.execution?.id || null },
    });

    if (hooks?.stream?.log) {
      hooks.stream.log(
        "info",
        `rag.retrieve "${r.kb.title}" → ${r.matches.length} chunk${r.matches.length === 1 ? "" : "s"}` +
        (r.usage?.tokens ? ` (query tokens: ${r.usage.tokens})` : ""),
      );
    }

    const separator = input.separator ?? "\n\n---\n\n";
    const context = r.matches.map(m => m.content).join(separator);
    return { context, matches: r.matches, count: r.matches.length };
  },
};
