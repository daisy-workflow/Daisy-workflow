// Embedding provider registry — picks the right handler for a KB's
// embedding_provider field.
//
// Each provider module exports:
//
//   MODELS          — Array<{ id, nativeDim, contextWindow? }>
//                     used by the Create-KB dialog to populate the
//                     model dropdown.
//
//   embed({ cfg, texts, inputType? })
//                   → { vectors: number[][], usage: { tokens } }
//
//     cfg          — { provider, model, apiKey, baseUrl? }
//     texts        — Array<string>; provider handles batching internally
//                    if its API allows it (both shipped providers do).
//     inputType    — "document" | "query" (Voyage uses it; OpenAI
//                    ignores it). The ingest path passes "document",
//                    the retrieve path passes "query".
//
// Adding a new provider = drop a file in this directory, export MODELS
// and embed(), register it below.

import * as openai from "./openai.js";
import * as voyage from "./voyage.js";

const EMBEDDERS = {
  openai,
  voyage,
};

/** Look up a provider; throw a clear list if the name is unknown. */
export function getEmbedder(name) {
  const mod = EMBEDDERS[name];
  if (!mod) {
    throw new Error(
      `unknown embedding provider: "${name}". ` +
      `Supported: ${Object.keys(EMBEDDERS).join(", ")}.`,
    );
  }
  return mod;
}

/** Catalog for the frontend Create-KB dropdown. */
export function listEmbedders() {
  return Object.keys(EMBEDDERS).map(name => ({
    name,
    models: EMBEDDERS[name].MODELS || [],
  }));
}
