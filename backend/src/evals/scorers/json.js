// JSON shape / JSONPath assertion scorer.
//
// Three layered checks (run in order, all must pass):
//
//   1. parseable        — the output must be valid JSON (or already
//                          a JS object if the agent's `result` field
//                          is forwarded directly).
//
//   2. requiredKeys     — every dotted path in this list must resolve
//                          to a defined value. Paths support nested
//                          objects + array indices: "items.0.id".
//
//   3. assertions       — list of { path, op, value } checks:
//                          op ∈ "eq" | "neq" | "in" | "regex" | "exists" | "type"
//                          For "type": value is the typeof name
//                          ("string", "number", "boolean", "object", "array").
//
// Designed to catch the common "agent must emit { intent, confidence,
// entities }" regression without requiring users to write a full
// JSON Schema for every case.

export const META = {
  name: "json",
  label: "JSON shape",
  description:
    "Assert the output parses as JSON and has the required keys / values. " +
    "Best for agents that emit structured JSON.",
  fields: {
    requiredKeys: { label: "Required dotted paths", kind: "string-array" },
    assertions:   { label: "Per-path assertions", kind: "object-array",
                    fields: { path: "string", op: "enum", value: "any" } },
  },
};

export async function score({ output, expected, config = {} }) {
  let parsed;
  if (typeof output === "string") {
    try { parsed = JSON.parse(output); }
    catch (e) {
      return { passed: false, score: 0, details: { error: `not valid JSON: ${e.message}` } };
    }
  } else {
    parsed = output;   // pre-parsed (agent's `result` field is JSON-typed)
  }

  const failures = [];

  const required = config.requiredKeys || expected?.requiredKeys || [];
  for (const path of required) {
    if (resolvePath(parsed, path) === undefined) {
      failures.push({ path, reason: "missing" });
    }
  }

  const assertions = config.assertions || expected?.assertions || [];
  for (const a of assertions) {
    const actual = resolvePath(parsed, a.path);
    const f = checkAssertion(a, actual);
    if (f) failures.push({ path: a.path, op: a.op, actual, ...f });
  }

  const passed = failures.length === 0;
  return {
    passed,
    score: passed ? 1 : 0,
    details: { failures, parsed: truncate(parsed) },
  };
}

// ─── helpers ────────────────────────────────────────────────────

function resolvePath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    // Array index support: numeric segment → indexed access.
    if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
    else cur = cur[p];
  }
  return cur;
}

function checkAssertion(a, actual) {
  switch (a.op) {
    case "exists": return actual === undefined ? { reason: "missing" } : null;
    case "eq":     return deepEq(actual, a.value) ? null : { reason: "mismatch", expected: a.value };
    case "neq":    return !deepEq(actual, a.value) ? null : { reason: "should differ" };
    case "in":
      if (!Array.isArray(a.value)) return { reason: "assertion.value must be an array for op=in" };
      return a.value.includes(actual) ? null : { reason: "not in list", expected: a.value };
    case "regex":
      if (typeof actual !== "string") return { reason: "value not a string" };
      try {
        return new RegExp(a.value).test(actual) ? null : { reason: "no match", pattern: a.value };
      } catch (e) {
        return { reason: `bad regex: ${e.message}` };
      }
    case "type": {
      const t = Array.isArray(actual) ? "array" : (actual === null ? "null" : typeof actual);
      return t === a.value ? null : { reason: "type mismatch", expected: a.value, got: t };
    }
    default:
      return { reason: `unknown op: ${a.op}` };
  }
}

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function truncate(obj) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= 2000) return obj;
    return JSON.parse(s.slice(0, 2000) + "...truncated");
  } catch { return null; }
}
