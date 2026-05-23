// Feature — logout via the UI clears the session and bounces the
// user back to /login. Also confirms the refresh cookie is gone so
// a tab refresh can't reanimate the session.

import { test, expect } from "@playwright/test";
import { LoginPage } from "../../pages/LoginPage.js";
import { TEST_ADMIN } from "../../helpers/api.js";

test("logout drops the session and lands on /login", async ({ page, context }) => {
  // Sign in first.
  await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);

  // UserMenu.vue: avatar `<q-btn class="user-btn">` opens a
  // `<q-menu>` containing `<q-item clickable @click="onLogout">
  // <q-item-section>Sign out</q-item-section></q-item>`. So we
  // click the avatar to reveal the popover, then click the
  // "Sign out" item. Using class+text selectors because Quasar's
  // q-item doesn't auto-set a "menuitem" ARIA role.
  await page.locator(".user-btn").first().click();
  await page.getByText("Sign out", { exact: true }).click();

  // After logout, the SPA pushes the user to /login.
  await expect(page).toHaveURL(/\/login(\?.*)?$/);
  await expect(page.getByLabel("Email")).toBeVisible();

  // Refresh cookie should be cleared. Refresh the page and confirm
  // we don't auto-redirect to /home.
  await page.reload();
  await expect(page).toHaveURL(/\/login(\?.*)?$/);

  // Sanity: cookie jar no longer has the refresh cookie.
  const cookies = await context.cookies();
  const refreshCookie = cookies.find(c => /refresh/i.test(c.name));
  expect(refreshCookie?.value || "").toBe("");
});
