// Mock the upstream LLM endpoints at the network layer.
//
// Important: this intercepts requests made by the BACKEND, not the
// browser. Playwright's `page.route()` only catches browser-side
// fetches, so it wouldn't see calls coming from the API/worker.
//
// Two ways to mock the backend's LLM calls:
//
//   A. Point ai.provider configs at a fake base URL that we serve
//      from inside the test compose stack. The fake URL returns the
//      canned response for every call. (Simple, no Playwright tricks
//      needed.) ← what this module supports.
//
//   B. A real mock server we boot via Playwright's webServer. More
//      flexible (per-test canned responses) but heavier. Move to (B)
//      in Layer 2 when feature tests need request-specific replies.
//
// For Layer 1 we go with (A): each smoke test that needs an agent
// call creates an ai.provider config whose baseUrl is the mock URL
// below. The /chat/completions and /messages endpoints are served
// by a tiny embedded responder we boot from the test process.

// (No longer imports node:http — the mock is a sidecar container now.)

// Internal hostname + port the worker container reaches the mock
// LLM on. The mock-llm sidecar in docker-compose.test.yml listens on
// 0.0.0.0:9123 inside its container; the compose network resolves
// `mock-llm` to that container's IP. No host.docker.internal voodoo.
//
// MOCK_LLM_URL is what gets stored in the ai.provider config's
// `baseUrl` — the worker (also in the docker network) reads it from
// the config and uses it as-is. The test runner (on the host) doesn't
// fetch this URL directly; it talks to the API on 127.0.0.1:3001.
const MOCK_PORT = parseInt(process.env.MOCK_LLM_PORT || "9123", 10);
export const MOCK_LLM_URL = `http://mock-llm:${MOCK_PORT}/v1`;

// The mock LLM is now a sidecar Docker container managed by
// docker-compose.test.yml — there's nothing to start in-process.
// These functions stay for back-compat with spec files that already
// call `await startMockLlm()` in their beforeAll; they're no-ops.

/** No-op (the mock is a long-lived sidecar container, not in-process). */
export async function startMockLlm() { return MOCK_LLM_URL; }

/** No-op (the sidecar is torn down by `docker compose down`). */
export async function stopMockLlm() { /* nothing */ }

/**
 * Report how many requests the mock container has served. Hits the
 * published port (9124 on the host → 9123 in the container) via a
 * /diagnostic endpoint... but we don't expose one. Instead this
 * returns null and the spec assertion falls back to its
 * "check worker logs" message. If you find you need a hit-count
 * for assertions, add a counter + GET /count to mock-llm/server.js.
 */
export function mockRequestCount() { return null; }
