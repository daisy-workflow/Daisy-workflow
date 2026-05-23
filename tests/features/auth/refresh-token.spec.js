// Feature — POST /auth/refresh uses the refresh cookie to mint a
// new access JWT (and rotate the cookie). Smoke-level assertion that
// the refresh cycle works end-to-end:
//
//   1. /auth/login           → access1 + refresh cookie #1
//   2. /auth/refresh (cookie) → access2 + refresh cookie #2 (rotated)
//   3. access2 works on /auth/me
//   4. Reusing cookie #1 fails (rotation invalidates the old one)
//
// We talk to the bare /auth endpoints with manual cookie handling
// because the helpers/api.js helpers don't surface Set-Cookie.

import { test, expect } from "@playwright/test";
import { TEST_ADMIN } from "../../helpers/api.js";

const API_URL = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const REFRESH_COOKIE = "daisy_rt";

/** Pull the `daisy_rt=<value>` pair out of a Set-Cookie header so we
 *  can echo it back as a Cookie on the next request. Returns the
 *  cookie value, not the full header. */
function pickRefreshCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // Node's fetch returns a single comma-joined string for set-cookie;
  // be defensive about both joined + array forms.
  const lines = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const line of lines) {
    const parts = line.split(/,(?=[^;]+=)/); // split on , that precedes another name=value
    for (const p of parts) {
      const m = p.match(new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE}=([^;]+)`));
      if (m) return m[1];
    }
  }
  return null;
}

test("refresh — POST /auth/refresh issues a fresh access token", async () => {
  // ── 1. Login ────────────────────────────────────────────────────
  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
  });
  expect(loginRes.status).toBe(200);
  const access1 = (await loginRes.json()).accessToken;
  expect(access1).toBeTruthy();
  const cookie1 = pickRefreshCookie(loginRes.headers.get("set-cookie"));
  expect(cookie1, "login should set a refresh cookie").toBeTruthy();

  // ── 2. Refresh ──────────────────────────────────────────────────
  const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
    method:  "POST",
    headers: {
      "content-type": "application/json",
      // Echo back the refresh cookie; the server reads it via req.cookies.
      "cookie":       `${REFRESH_COOKIE}=${cookie1}`,
    },
  });
  expect(refreshRes.status).toBe(200);
  const access2 = (await refreshRes.json()).accessToken;
  expect(access2).toBeTruthy();
  const cookie2 = pickRefreshCookie(refreshRes.headers.get("set-cookie"));
  expect(cookie2, "refresh should rotate to a new refresh cookie").toBeTruthy();
  expect(cookie2).not.toBe(cookie1);

  // ── 3. New token works ──────────────────────────────────────────
  const meRes = await fetch(`${API_URL}/auth/me`, {
    headers: { "authorization": `Bearer ${access2}` },
  });
  expect(meRes.status).toBe(200);
  expect((await meRes.json()).email?.toLowerCase()).toBe(TEST_ADMIN.email.toLowerCase());

  // ── 4. Old cookie is invalid (rotation + theft-replay defence) ──
  const replayRes = await fetch(`${API_URL}/auth/refresh`, {
    method:  "POST",
    headers: {
      "content-type": "application/json",
      "cookie":       `${REFRESH_COOKIE}=${cookie1}`,
    },
  });
  expect(replayRes.status).toBe(401);
});

test("refresh — missing cookie returns 401", async () => {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(401);
});
