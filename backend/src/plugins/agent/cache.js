// Agent prompt cache — in-process LRU.
//
// Identical prompts (same model, system, messages, maxTokens) get
// served from memory without hitting the provider. The cache key is
// a SHA-256 hash of the canonicalised JSON payload so two structurally
// identical requests collide even when their object key order differs.
//
// In-process scope keeps this a one-file change. A Redis-backed
// shared cache (so two API processes split the savings) is a Phase B
// follow-up — the interface stays the same.
//
// Disabled by default for now (AGENT_PROMPT_CACHE=true to turn on).
// We gate behind an env flag because cached LLM responses are great
// for tests + reproducible workflows but can be confusing in
// interactive use ("why did it say the same thing twice?"). When the
// product matures the default flips on.

import crypto from "node:crypto";

const ENABLED         = String(process.env.AGENT_PROMPT_CACHE || "").toLowerCase() === "true";
const MAX_ENTRIES     = Number(process.env.AGENT_PROMPT_CACHE_MAX || 500);
const TTL_MS          = Number(process.env.AGENT_PROMPT_CACHE_TTL_MS || 10 * 60_000); // 10 min

// JS Map preserves insertion order, which makes it a perfectly good
// LRU when paired with delete+set on access. No external dep needed.
const _cache = new Map();   // key → { value, expiresAt }

export function isEnabled() { return ENABLED; }

export function get(key) {
  if (!ENABLED) return null;
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    _cache.delete(key);
    return null;
  }
  // Refresh insertion order — re-add at the tail.
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.value;
}

export function set(key, value) {
  if (!ENABLED) return;
  _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  while (_cache.size > MAX_ENTRIES) {
    // Evict the oldest entry — the Map iterator returns oldest first.
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
}

/**
 * Hash everything that influences the model's response. We don't
 * include the apiKey, baseUrl, or transient fields so two configs
 * pointing at the same OpenAI deployment + same model share cache
 * hits.
 */
export function keyFor({ provider, model, system, messages, maxTokens, images }) {
  const canonical = JSON.stringify({
    provider, model,
    system:   String(system   ?? ""),
    messages: (messages || []).map(m => ({
      role:    m.role,
      content: String(m.content ?? ""),
    })),
    maxTokens: Number(maxTokens || 0),
    // Vision inputs (Phase E) — hash by content so a vision call
    // doesn't collide with the same prompt text without images.
    // We hash a digest of each image string rather than the raw bytes
    // to keep the key compact; same image → same digest → same hit.
    images: Array.isArray(images) && images.length
      ? images.map(i => crypto.createHash("sha256").update(String(i)).digest("hex").slice(0, 16))
      : undefined,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// Test / admin hook.
export function stats() {
  return { enabled: ENABLED, entries: _cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
