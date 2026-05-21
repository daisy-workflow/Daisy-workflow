// Feature — custom role CRUD + permission catalog. The catalog
// drives the UI's permission picker; the CRUD path persists the
// chosen permissions blob.

import { test, expect } from "@playwright/test";
import {
  login, listCustomRoleCatalog, createCustomRole,
  listCustomRoles, deleteCustomRole, uniq,
} from "../../helpers/api.js";

test("custom role catalog — has known permission groups", async () => {
  const { token } = await login();
  const catalog = await listCustomRoleCatalog({ token });

  // The catalog is grouped by domain (workflow, config, agent, kb,
  // guardrails, etc). Shape variations: array of groups OR
  // { groups: [...] }; either works for this assertion.
  const groups = Array.isArray(catalog) ? catalog : (catalog.groups || []);
  expect(groups.length).toBeGreaterThan(0);

  // Verify a couple of well-known permission strings exist somewhere
  // in the catalog. These are quoted from the backend permissions
  // table — if any disappears, the UI's picker silently breaks.
  const flat = JSON.stringify(groups);
  for (const perm of ["graph.create", "agent.create", "guardrails.write"]) {
    expect(flat).toContain(perm);
  }
});

test("custom role CRUD — create + list + delete", async () => {
  const { token } = await login();
  const name = uniq("role");

  const created = await createCustomRole({
    token, name, description: "wave3 smoke role",
    permissions: ["graph.read", "agent.read"],
  });
  expect(created.id).toBeTruthy();

  const list = await listCustomRoles({ token });
  expect(list.some(r => r.id === created.id)).toBe(true);

  await deleteCustomRole({ token, id: created.id });
  const after = await listCustomRoles({ token });
  expect(after.some(r => r.id === created.id)).toBe(false);
});
