// Feature — per-project plugin enablement.
//
// /project-plugins lists the workspace's installed plugins with a
// per-project enabled flag. Core plugins (source='core', e.g. log /
// transform / agent) are always-on; PUT against them is rejected.
// Non-core plugins (installed via install-from-catalog) can be
// toggled per-project via PUT { enabled }.
//
// The default test stack has only core plugins installed. We
// therefore exercise:
//   1. List comes back with rows + core plugins are flagged enabled.
//   2. Toggle against a core plugin is refused (400 + message).
//   3. Toggle against an unknown plugin is refused (404).
//
// If a non-core plugin is present (e.g. an in-tree connector with
// source != 'core'), we also exercise the enable + disable round-trip
// on it. Otherwise that assertion is skipped via `test.skip` so this
// file passes on the stock stack.

import { test, expect } from "@playwright/test";
import { login } from "../../helpers/api.js";

const API_URL = process.env.TEST_API_URL || "http://127.0.0.1:3001";

async function listProjectPlugins({ token, projectId }) {
  const res = await fetch(`${API_URL}/project-plugins`, {
    headers: {
      "authorization": `Bearer ${token}`,
      "x-project-id":  projectId,
    },
  });
  if (!res.ok) throw new Error(`/project-plugins → ${res.status}`);
  return res.json();
}

test("project-plugins — list returns rows + core plugins are always-enabled", async () => {
  const { token, projectId } = await login();
  const rows = await listProjectPlugins({ token, projectId });
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);

  // Every core plugin should be flagged enabled_in_project.
  const cores = rows.filter(r => r.core === true);
  expect(cores.length).toBeGreaterThan(0);
  for (const c of cores) {
    expect(c.enabled_in_project).toBe(true);
  }
});

test("project-plugins — PUT against a core plugin is refused", async () => {
  const { token, projectId } = await login();
  // `log` is shipped as core in every install.
  const res = await fetch(`${API_URL}/project-plugins/log`, {
    method:  "PUT",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
      "x-project-id":  projectId,
    },
    body: JSON.stringify({ enabled: false }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  const txt = await res.text();
  expect(txt.toLowerCase()).toContain("core");
});

test("project-plugins — PUT against an unknown plugin is 404", async () => {
  const { token, projectId } = await login();
  const res = await fetch(`${API_URL}/project-plugins/this-plugin-does-not-exist`, {
    method:  "PUT",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
      "x-project-id":  projectId,
    },
    body: JSON.stringify({ enabled: false }),
  });
  expect(res.status).toBe(404);
});

test("project-plugins — non-core toggle round-trip (when one is installed)", async () => {
  const { token, projectId } = await login();
  const rows = await listProjectPlugins({ token, projectId });
  const nonCore = rows.find(r => r.core === false);
  test.skip(!nonCore, "no non-core plugin installed; install-from-catalog covers the install path");

  // Disable, confirm, re-enable, confirm. Wrap in try/finally so a
  // partial run leaves the project state untouched.
  const name = nonCore.name;
  const disableRes = await fetch(`${API_URL}/project-plugins/${name}`, {
    method:  "PUT",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
      "x-project-id":  projectId,
    },
    body: JSON.stringify({ enabled: false }),
  });
  expect(disableRes.status).toBe(200);

  try {
    const afterDisable = await listProjectPlugins({ token, projectId });
    const row1 = afterDisable.find(r => r.name === name);
    expect(row1.enabled_in_project).toBe(false);
  } finally {
    await fetch(`${API_URL}/project-plugins/${name}`, {
      method:  "PUT",
      headers: {
        "content-type":  "application/json",
        "authorization": `Bearer ${token}`,
        "x-project-id":  projectId,
      },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
  }
});
