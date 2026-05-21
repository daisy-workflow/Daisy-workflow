// Feature — GDPR data export (Article 20) + erasure (Article 17).
// We export against the admin themselves (always present) — the
// shape is what we lock in. Erasure is more destructive, so this
// spec exports only; an erasure test would require seeding a
// throwaway user, which Wave 4 will add.

import { test, expect } from "@playwright/test";
import { login, getMe, exportUserData } from "../../helpers/api.js";

test("GDPR export — bundles user + audit + executions + memories", async () => {
  const { token } = await login();
  const me = await getMe({ token });

  const bundle = await exportUserData({ token, userId: me.id });

  // The Article-20 bundle is { user, audit, executions, memories }
  // — verify the top-level shape is what the UI's "Download my
  // data" button consumes.
  expect(bundle).toBeTruthy();
  expect(bundle.user).toBeTruthy();
  expect(bundle.user.id).toBe(me.id);
  expect(Array.isArray(bundle.audit)).toBe(true);
  expect(Array.isArray(bundle.executions)).toBe(true);
  expect(Array.isArray(bundle.memories)).toBe(true);

  // The user's email lives in user.email (so the export is genuinely
  // identifying — that's the whole point).
  expect(typeof bundle.user.email).toBe("string");
});
