// Feature — service account CRUD + key issuance + revoke. The key
// itself is shown ONCE on creation; the revoke flow marks it
// inactive but leaves the audit trail.

import { test, expect } from "@playwright/test";
import {
  login, createServiceAccount, listServiceAccounts, deleteServiceAccount,
  mintServiceAccountKey, revokeServiceAccountKey, uniq,
} from "../../helpers/api.js";

test("service account CRUD — create + list + delete", async () => {
  const { token } = await login();
  const name = uniq("sa");

  const sa = await createServiceAccount({
    token, name, description: "wave3 smoke", role: "editor",
  });
  expect(sa.id).toBeTruthy();
  expect(sa.role).toBe("editor");

  const before = await listServiceAccounts({ token });
  expect(before.some(s => s.id === sa.id)).toBe(true);

  await deleteServiceAccount({ token, id: sa.id });
  const after = await listServiceAccounts({ token });
  expect(after.some(s => s.id === sa.id)).toBe(false);
});

test("service account keys — mint then revoke", async () => {
  const { token } = await login();
  const sa = await createServiceAccount({
    token, name: uniq("sa-keys"), role: "viewer",
  });

  try {
    const key = await mintServiceAccountKey({ token, id: sa.id, label: "wave3-key" });
    // Mint endpoint returns { id, token, ... } — the raw token is
    // visible exactly once. We don't use it (no live SA-token
    // request flow in this spec), just verify the shape.
    expect(key.id).toBeTruthy();
    expect(typeof key.token).toBe("string");
    expect(key.token.length).toBeGreaterThan(20);

    await revokeServiceAccountKey({ token, id: sa.id, keyId: key.id });
    // Revoke is idempotent — the row is still returned by list but
    // marked revoked.
  } finally {
    await deleteServiceAccount({ token, id: sa.id }).catch(() => {});
  }
});
