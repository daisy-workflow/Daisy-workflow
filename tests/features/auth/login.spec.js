// Feature — POST /auth/login returns an access token + sets a
// refresh cookie. A follow-up GET /auth/me with the bearer succeeds
// and reflects the user we logged in as.
//
// Most other specs login via helpers/api.js's login() helper, which
// already covers this path implicitly — this file makes the contract
// an explicit, isolated assertion so a regression in the login wire
// fails ONE small spec instead of every spec at once.

import { test, expect } from "@playwright/test";
import { TEST_ADMIN } from "../../helpers/api.js";

const API_URL = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const REFRESH_COOKIE = "daisy_rt"; // see backend/src/auth/tokens.js

test("login — POST /auth/login returns access token + refresh cookie", async () => {
  const res = await fetch(`${API_URL}/auth/login`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
  });
  expect(res.status).toBe(200);

  const body = await res.json();
  const token = body.accessToken || body.token;
  expect(token, "response missing accessToken").toBeTruthy();
  expect(typeof token).toBe("string");
  // Sanity: JWTs are three dot-separated base64 segments. Loose check —
  // we don't want to couple the spec to header.alg or claim shape.
  expect(token.split(".").length).toBe(3);

  // Refresh cookie is HttpOnly so it lands in Set-Cookie. Confirm by
  // name; flags vary by env (Secure off in test, on in prod).
  const setCookie = res.headers.get("set-cookie") || "";
  expect(setCookie).toContain(`${REFRESH_COOKIE}=`);

  // Token works against a protected endpoint.
  const meRes = await fetch(`${API_URL}/auth/me`, {
    headers: { "authorization": `Bearer ${token}` },
  });
  expect(meRes.status).toBe(200);
  const me = await meRes.json();
  expect(me.email?.toLowerCase()).toBe(TEST_ADMIN.email.toLowerCase());
  expect(["admin", "editor", "viewer"]).toContain(me.role);
});

test("login — bad password is rejected with 401", async () => {
  const res = await fetch(`${API_URL}/auth/login`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ email: TEST_ADMIN.email, password: "definitely-wrong-password" }),
  });
  expect(res.status).toBe(401);
});
