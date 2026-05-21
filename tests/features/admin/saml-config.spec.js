// Feature — SAML config CRUD. Requires SAML SP keypair envs on the
// test stack; when those aren't set, the endpoint 403s with the
// known "SAML SP keypair is not configured" message, which is itself
// a useful smoke check that the validation gate is wired.

import { test, expect } from "@playwright/test";
import { login, getSamlConfig, setSamlConfig, deleteSamlConfig } from "../../helpers/api.js";

const HAS_SAML_SP_KEYS = !!process.env.TEST_SAML_SP_CONFIGURED;

test.describe("SAML config (requires SP keypair envs)", () => {
  test("GET /saml-configs — returns whatever the workspace has (or null)", async () => {
    const { token } = await login();
    // The endpoint is always present; it returns null when no row
    // exists or no SP key is configured. We just check the call
    // succeeds.
    const cfg = await getSamlConfig({ token });
    expect(cfg === null || typeof cfg === "object").toBe(true);
  });

  test.skip(!HAS_SAML_SP_KEYS, "set TEST_SAML_SP_CONFIGURED=1 + the SP envs to enable PUT");
  test("PUT /saml-configs — persists an IdP config", async () => {
    const { token } = await login();
    const fakeCert = "-----BEGIN CERTIFICATE-----\nMIIB...fake...==\n-----END CERTIFICATE-----";
    try {
      await setSamlConfig({
        token,
        enabled: true,
        idp_entity_id: "https://idp.test/entity",
        idp_sso_url:   "https://idp.test/sso",
        idp_cert:      fakeCert,
        attribute_email: "email",
        default_role:    "editor",
      });
      const row = await getSamlConfig({ token });
      expect(row?.idp_entity_id).toBe("https://idp.test/entity");
    } finally {
      await deleteSamlConfig({ token }).catch(() => {});
    }
  });
});
