// Exact-match scorer.
//
// Pass when the agent's output equals the expected string. By default
// trims whitespace + does a case-insensitive compare; the per-case
// config can override with { caseSensitive: true, trim: false }.

export const META = {
  name: "exact",
  label: "Exact match",
  description: "Pass when the agent's output equals the expected string.",
  fields: {
    expected:      { label: "Expected output", kind: "string", required: true },
    caseSensitive: { label: "Case sensitive",  kind: "bool",   default: false },
    trim:          { label: "Trim whitespace", kind: "bool",   default: true  },
  },
};

export async function score({ output, expected, config = {} }) {
  // Expected can live either in the case's `expected` blob or on the
  // scorer config itself — accept both for back-compat with future
  // bulk-import formats.
  const want = expected ?? config.expected;
  if (typeof want !== "string") {
    return { passed: false, score: 0, details: { error: "expected must be a string" } };
  }
  let a = String(output ?? "");
  let b = String(want);
  if (config.trim !== false) { a = a.trim(); b = b.trim(); }
  if (config.caseSensitive !== true) { a = a.toLowerCase(); b = b.toLowerCase(); }
  const passed = a === b;
  return { passed, score: passed ? 1 : 0, details: { actual: output, expected: want } };
}
