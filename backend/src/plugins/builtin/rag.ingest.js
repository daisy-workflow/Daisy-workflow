// rag.ingest — add a text document to a Knowledge Base from inside
// a workflow.
//
// Use cases:
//   • A scheduled workflow polls an RSS feed, extracts each item's
//     summary, and ingests it into a KB so the support agent stays
//     up to date.
//   • A `http.request` node fetches a wiki page; downstream
//     rag.ingest stores it.
//   • A user-uploaded form's free-text answers get ingested for
//     future-search.
//
// The plugin only handles already-extracted text — for binary docs
// use the REST upload endpoint, or extract upstream with an
// appropriate plugin and pipe the text in.
//
// Output is the kb_documents row's id + chunk count so the workflow
// can echo a confirmation or chain further actions.

import { loadKb, createAndIngestDocument } from "../../rag/ingest.js";

export default {
  name: "rag.ingest",
  description:
    "Add a text document to a Knowledge Base. Use the REST upload " +
    "endpoint or extract upstream for non-text formats.",
  inputSchema: {
    type: "object",
    required: ["kbId", "text"],
    properties: {
      kbId: {
        type: "string",
        title: "Knowledge Base ID",
        description: "UUID of the KB to ingest into.",
      },
      text: {
        type: "string",
        title: "Document text",
        format: "textarea",
        description: "UTF-8 text to chunk + embed. Usually a `${var}` reference.",
      },
      title: {
        type: "string",
        title: "Document title",
        description:
          "Optional. Defaults to `workflow <execId>` so the document " +
          "is attributable to the run that created it.",
      },
      sourceUri: {
        type: "string",
        title: "Source URI",
        description:
          "Optional. Stored on the document row as the canonical " +
          "source location (e.g. the URL the text was scraped from).",
      },
    },
  },

  primaryOutput: "documentId",

  outputSchema: {
    type: "object",
    required: ["documentId", "chunkCount"],
    properties: {
      documentId: { type: "string" },
      chunkCount: { type: "integer" },
      tokens:     { type: "integer", description: "Embedding tokens consumed by this ingest." },
    },
  },

  async execute(input, ctx, hooks) {
    const kbId = String(input.kbId || "");
    if (!kbId) throw new Error("rag.ingest: kbId is required");

    const kb = await loadKb(kbId);
    if (!kb) throw new Error(`rag.ingest: unknown KB ${kbId}`);

    const text  = String(input.text || "");
    const title = input.title
      || `workflow ${ctx?.execution?.id?.slice(0, 8) || "run"} @ ${new Date().toISOString()}`;

    const result = await createAndIngestDocument({
      kb,
      title,
      sourceType:  input.sourceUri ? "url" : "plugin",
      sourceUri:   input.sourceUri || null,
      contentType: "text/plain",
      byteSize:    Buffer.byteLength(text, "utf8"),
      text,
      createdBy:   null,    // workflow runs don't carry a user
    });

    if (hooks?.stream?.log) {
      hooks.stream.log(
        "info",
        `rag.ingest "${kb.title}" → doc ${result.id.slice(0, 8)}, ` +
        `${result.chunkCount} chunk${result.chunkCount === 1 ? "" : "s"}, ` +
        `${result.tokens} embedding token${result.tokens === 1 ? "" : "s"}`,
      );
    }

    return {
      documentId: result.id,
      chunkCount: result.chunkCount,
      tokens:     result.tokens,
    };
  },
};
