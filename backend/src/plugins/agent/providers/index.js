// Provider registry — picks the right handler for an ai.provider config.
//
// Each provider module exports two functions with the same shape:
//
//   call({ cfg, system, messages, maxTokens })
//       → { text, usage: { inputTokens, outputTokens } }
//
//   callStreaming({ cfg, system, messages, maxTokens, onText })
//       → same return shape; onText fires for each delta
//
// Adding a new provider = drop a file in this directory, export
// those two functions, register it below. Six providers ship today:
// openai, anthropic, azure-openai, gemini, bedrock, ollama.

import * as openai      from "./openai.js";
import * as anthropic   from "./anthropic.js";
import * as azureOpenai from "./azure-openai.js";
import * as gemini      from "./gemini.js";
import * as bedrock     from "./bedrock.js";
import * as ollama      from "./ollama.js";
import * as mock        from "./mock.js";

const PROVIDERS = {
  "openai":       openai,
  "anthropic":    anthropic,
  "azure-openai": azureOpenai,
  "gemini":       gemini,
  "bedrock":      bedrock,
  "ollama":       ollama,
  // In-tree mock for offline development + tests. Returns deterministic
  // responses based on the `mockRules` field on the ai.provider config.
  "mock":         mock,
};

/** Look up the provider module; throw with a friendly list if unknown. */
export function getProvider(name) {
  const mod = PROVIDERS[name];
  if (!mod) {
    throw new Error(
      `unknown ai provider: "${name}". ` +
      `Supported: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }
  return mod;
}

export function listProviders() {
  return Object.keys(PROVIDERS);
}
