// Feature — switching to HIPAA mode enforces:
//   1. providers must be BAA-covered (anthropic / azure-openai /
//      bedrock); a plain openai config save is rejected.
//   2. the guardrail PII-redact floor — saving a policy that
//      drops PII below redact is rejected.
//
// This is a real side-effect on the workspace, so we restore the
// `none` mode in finally.

import { test, expect } from "@playwright/test";
import {
  login, setComplianceSettings, getComplianceSettings,
  createConfig, deleteConfig, setGuardrailPolicy, getGuardrailPolicy,
  uniq,
} from "../../helpers/api.js";

test("HIPAA mode — non-BAA provider config is refused", async () => {
  const { token } = await login();
  const original = await getComplianceSettings({ token }).catch(() => null);

  try {
    await setComplianceSettings({ token, mode: "hipaa", residency: "us" });

    // openai (not BAA-covered in the engine's allow-list) should
    // get rejected by the compliance enforcement hook in
    // /configs.
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
      // Error message references compliance / HIPAA / BAA.
      expect(e.message).toMatch(/compliance|hipaa|baa|allowed.*provider/i);
    }
    expect(threw).toBe(true);
    if (createdId) {
      // Belt-and-braces cleanup if the test mode somehow let it
      // through.
      await deleteConfig({ token, id: createdId }).catch(() => {});
    }
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
          // Deliberately weaker than the HIPAA floor.
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
