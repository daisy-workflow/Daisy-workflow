// Feature — workspace admin grants temporary elevation to a user,
// then revokes it. We grant the admin themselves (self-grant) so the
// spec doesn't need a second user fixture; the contract is identical.

import { test, expect } from "@playwright/test";
import {
  login, getMe,
  createJitGrant, listJitGrants, listMyJitGrants, revokeJitGrant,
} from "../../helpers/api.js";

test("JIT grant — create + visible on /jit-grants and /jit-grants/mine", async () => {
  const { token } = await login();
  const me = await getMe({ token });

  const grant = await createJitGrant({
    token,
    userId: me.id,
    scopeType: "workspace",
    scopeId:   me.workspaceId,
    role:      "admin",
    reason:    "wave3 smoke — self-grant for testing",
    durationMinutes: 15,
  });
  expect(grant.id).toBeTruthy();

  try {
    const all = await listJitGrants({ token });
    expect(all.some(g => g.id === grant.id)).toBe(true);

    const mine = await listMyJitGrants({ token });
    expect(mine.some(g => g.id === grant.id)).toBe(true);
  } finally {
    await revokeJitGrant({ token, id: grant.id }).catch(() => {});
  }
});

test("JIT grant — revoke marks it inactive", async () => {
  const { token } = await login();
  const me = await getMe({ token });

  const grant = await createJitGrant({
    token,
    userId: me.id,
    scopeType: "workspace",
    scopeId:   me.workspaceId,
    role:      "editor",
    reason:    "wave3 revoke test",
    durationMinutes: 10,
  });

  await revokeJitGrant({ token, id: grant.id });

  // The grant row stays for audit purposes but is no longer
  // counted in "active" listings; shape varies (`active: false`
  // or `revoked_at: <iso>`).
  const all = await listJitGrants({ token });
  const row = all.find(g => g.id === grant.id);
  if (row) {
    expect(row.active === false || !!row.revoked_at).toBe(true);
  }
});
