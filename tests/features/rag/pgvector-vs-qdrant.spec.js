// Feature — KB rows carry their vector backend (pgvector | qdrant)
// and the API validates the backend selector at create time.
//
// We don't run a real Qdrant container in the test stack, so the
// qdrant paths are exercised only as validation contracts:
//   • unknown backend → 4xx
//   • qdrant backend without kbBackendConfigId → 4xx
// The pgvector path is exercised end-to-end (create → read → delete).
//
// If you set QDRANT_URL + provision a config row pointing at it, this
// spec could be extended to round-trip a qdrant-backed KB. Not in
// scope for the default CI stack.

import { test, expect } from "@playwright/test";
import {
  login, uniq,
  createKb, getKb, deleteKb,
} from "../../helpers/api.js";

const API_URL = process.env.TEST_API_URL || "http://127.0.0.1:3001";

test("KB backends — pgvector round-trips on create + read", async ({}, testInfo) => {
  testInfo.setTimeout(20_000);
  const { token } = await login();

  const kb = await createKb({
    token,
    title:     uniq("pgvec-kb"),
    kbBackend: "pgvector",
  });

  try {
    expect(kb.kb_backend).toBe("pgvector");
    // Backend persists on the row — confirm via a read.
    const got = await getKb({ token, id: kb.id });
    expect(got.kb_backend).toBe("pgvector");
  } finally {
    await deleteKb({ token, id: kb.id }).catch(() => {});
  }
});

test("KB backends — unknown backend is rejected", async ({}, testInfo) => {
  testInfo.setTimeout(10_000);
  const { token, projectId } = await login();

  // Direct fetch so we can read the error status. The call() helper
  // throws on non-2xx, which would mask the status code we want to
  // assert on.
  const res = await fetch(`${API_URL}/kbs`, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
      "x-project-id":  projectId,
    },
    body: JSON.stringify({
      title:             uniq("bogus-kb"),
      // Supply embedding fields so the earlier "required" check
      // passes and we actually hit the kbBackend allow-list check.
      embeddingProvider: "openai",
      embeddingModel:    "text-embedding-3-small",
      kbBackend:         "not-a-real-backend",
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  const txt = await res.text();
  expect(txt.toLowerCase()).toContain("not-a-real-backend");
});

test("KB backends — qdrant requires kbBackendConfigId", async ({}, testInfo) => {
  testInfo.setTimeout(10_000);
  const { token, projectId } = await login();

  const res = await fetch(`${API_URL}/kbs`, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
      "x-project-id":  projectId,
    },
    body: JSON.stringify({
      title:             uniq("qdrant-kb-missing-cfg"),
      // embeddingProvider + embeddingModel are required by an earlier
      // validator; supply valid values so we reach the qdrant-specific
      // `kbBackendConfigId required` check we're actually testing.
      embeddingProvider: "openai",
      embeddingModel:    "text-embedding-3-small",
      kbBackend:         "qdrant",
      // intentionally omit kbBackendConfigId
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  const txt = await res.text();
  // Error mentions either "kb_backend_config_id" (snake_case in the
  // server's ValidationError) or "qdrant". Match either to stay
  // resilient to wording tweaks.
  expect(txt.toLowerCase()).toMatch(/kb_backend_config_id|backend_config|qdrant/);
});
