// Detector registry.
//
// Each detector module exports:
//
//   META — { name, label, description, modes[], defaultMode, fields {} }
//          used by /guardrails/detectors to drive the policy editor UI.
//
//   detect(text, cfg) → Promise<{
//     flagged:  boolean
//     redacted: string | null   // present for detectors that can mask
//     matches?: [...]           // detector-specific evidence
//   }>
//
// Adding a fourth detector = new file + register it below.

import * as pii       from "./pii.js";
import * as toxicity  from "./toxicity.js";
import * as jailbreak from "./jailbreak.js";

export const DETECTORS = {
  pii,
  toxicity,
  jailbreak,
};

/** Look up a detector; throw a clear list if the name is unknown. */
export function getDetector(name) {
  const d = DETECTORS[name];
  if (!d) {
    throw new Error(
      `unknown guardrail detector: "${name}". ` +
      `Available: ${Object.keys(DETECTORS).join(", ")}.`,
    );
  }
  return d;
}

/** Catalog payload for the policy editor. */
export function listDetectors() {
  return Object.values(DETECTORS).map(d => d.META);
}
