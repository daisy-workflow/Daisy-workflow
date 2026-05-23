// Compliance feature tests.
//
// All three sub-tests mutate the workspace's `compliance_mode` column,
// which is workspace-wide state. Earlier we had two separate files:
//   compliance-hipaa.spec.js    (mode=hipaa)
//   compliance-gdpr-erasure.spec.js (mode=gdpr)
// Playwright runs different spec files in parallel workers — so one
// worker's HIPAA mode flipped under the other worker's GDPR test
// mid-flight, with predictable 403s.
//
// Fix: merge into one file + `test.describe.configure({ mode: "serial" })`.
// All three tests now run sequentially in the same worker, sharing
// the cleanup-and-reset rhythm naturally.

import { test, expect } from "@playwright/test";
import {
  login, getMe, exportUserData,
  setComplianceSettings, getComplianceSettings,
  setGuardrailPolicy, getGuardrailPolicy,
  createConfig, deleteConfig, uniq,
} from "../../helpers/api.js";

test.describe.configure({ mode: "serial" });

test.describe("compliance", () => {

  test("HIPAA mode — non-BAA provider config is refused", async () => {
    const { token } = await login();
    const original = await getComplianceSettings({ token }).catch(() => null);

    try {
      await setComplianceSettings({ token, mode: "hipaa", residency: "us" });

      let threw = false;
      let createdId = null;
      try {
        const cfg = await createConfig({
          token, name: uniq("hipaa-bad"), type: "ai.provider",
          data: { provider: "openai", model: "gpt-4o-mini",
                  apiKey: "sk-mock", baseUrl: "https://api.openai.com/v1" },
        });
        createdId = cfg.id;
      } catch (e) {
        threw = true;
        expect(e.message).toMatch(/compliance|hipaa|baa|allowed.*provider/i);
      }
      expect(threw).toBe(true);
      if (createdId) await deleteConfig({ token, id: createdId }).catch(() => {});
    } finally {
      await setComplianceSettings({
        token,
        mode:      original?.mode      || "none",
        residency: original?.residency || "global",
      }).catch(() => {});
    }
  });

  test("HIPAA mode — guardrail floor refuses to drop PII below redact", async () => {
    const { token } = await login();
    const originalCompliance = await getComplianceSettings({ token }).catch(() => null);
    const originalPolicy     = await getGuardrailPolicy({ token }).catch(() => null);

    try {
      await setComplianceSettings({ token, mode: "hipaa", residency: "us" });

      let threw = false;
      try {
        await setGuardrailPolicy({
          token,
          apply_to: "both",
          config: {
            pii:       { enabled: false, mode: "warn",  types: ["email"] },
            toxicity:  { enabled: false, mode: "warn",  threshold: 0.5 },
            jailbreak: { enabled: false, mode: "warn",  threshold: 0.5 },
          },
        });
      } catch (e) {
        threw = true;
        expect(e.message).toMatch(/compliance|hipaa|floor|pii/i);
      }
      expect(threw).toBe(true);
    } finally {
      if (originalPolicy) {
        await setGuardrailPolicy({
          token,
          apply_to: originalPolicy.apply_to,
          config:   originalPolicy.config,
        }).catch(() => {});
      }
      await setComplianceSettings({
        token,
        mode:      originalCompliance?.mode      || "none",
        residency: originalCompliance?.residency || "global",
      }).catch(() => {});
    }
  });

  test("GDPR export — bundles user + audit + executions + memories", async () => {
    const { token } = await login();
    const me = await getMe({ token });

    // Force GDPR mode — export endpoint refuses under any other mode.
    // Since the file is `describe.serial`, the prior HIPAA tests have
    // already restored to `none` by the time this runs, so the PUT
    // here is a clean transition.
    const original = await getComplianceSettings({ token }).catch(() => null);
    await setComplianceSettings({ token, mode: "gdpr", residency: "global" });
    try {
      const bundle = await exportUserData({ token, userId: me.id });

      expect(bundle).toBeTruthy();
      expect(bundle.user).toBeTruthy();
      expect(bundle.user.id).toBe(me.id);
      expect(Array.isArray(bundle.audit)).toBe(true);
      expect(Array.isArray(bundle.executions)).toBe(true);
      expect(Array.isArray(bundle.memories)).toBe(true);
      expect(typeof bundle.user.email).toBe("string");
    } finally {
      await setComplianceSettings({
        token,
        mode:      original?.mode      || "none",
        residency: original?.residency || "global",
      }).catch(() => {});
    }
  });

});
