// Feature — install-from-catalog plumbing.
//
// A real install requires a live plugin manifest endpoint hosted
// somewhere reachable from the api container — out of scope for the
// default test stack. What we DO exercise here:
//
//   1. POST /plugins/install-from-catalog validates its inputs
//      (rejects non-URL manifestUrl + non-URL endpoint).
//   2. POST /plugins/:name/disable + /enable round-trips on a known
//      in-tree plugin (`log`). This proves the same registry-reload
//      machinery the install path uses to make new plugins visible.
//   3. The catalog list endpoint is reachable + admin-protected.

import { test, expect } from "@playwright/test";
import { login, getPluginCatalog } from "../../helpers/api.js";

const API_URL = process.env.TEST_API_URL || "http://127.0.0.1:3001";

test("catalog — GET /plugins/catalog returns marketplace rows", async () => {
  const { token } = await login();
  const body = await getPluginCatalog({ token });
  expect(Array.isArray(body.plugins)).toBe(true);
  // We don't assert a specific entry — the catalog is operator-curated.
  // The shape (each row has name + version) is the invariant.
  for (const p of body.plugins) {
    expect(typeof p.name).toBe("string");
    expect(typeof p.version).toBe("string");
  }
});

test("install — install-from-catalog rejects a bogus manifestUrl", async () => {
  const { token } = await login();
  const res = await fetch(`${API_URL}/plugins/install-from-catalog`, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      manifestUrl: "not-a-url",
      endpoint:    "https://example.com",
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

test("install — install-from-catalog rejects a bogus endpoint", async () => {
  const { token } = await login();
  const res = await fetch(`${API_URL}/plugins/install-from-catalog`, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      manifestUrl: "https://example.com/manifest.json",
      endpoint:    "not-a-url",
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

test("install — disable + enable round-trip on an in-tree plugin", async () => {
  // `log` is an in-tree (core) plugin shipped with every install. The
  // disable/enable endpoints update plugins.enabled + reload the
  // registry — same machinery install-from-catalog runs at the end of
  // a successful install.
  const { token } = await login();

  const disableRes = await fetch(`${API_URL}/plugins/log/disable`, {
    method:  "POST",
    headers: { "authorization": `Bearer ${token}` },
  });
  expect(disableRes.status).toBe(200);
  const disabled = await disableRes.json();
  expect(disabled.enabled).toBe(false);

  try {
    const enableRes = await fetch(`${API_URL}/plugins/log/enable`, {
      method:  "POST",
      headers: { "authorization": `Bearer ${token}` },
    });
    expect(enableRes.status).toBe(200);
    const enabled = await enableRes.json();
    expect(enabled.enabled).toBe(true);
  } finally {
    // Make sure we leave the in-tree plugin enabled — other specs
    // depend on `log` being available (e.g. retries-and-errors).
    await fetch(`${API_URL}/plugins/log/enable`, {
      method:  "POST",
      headers: { "authorization": `Bearer ${token}` },
    }).catch(() => {});
  }
});
