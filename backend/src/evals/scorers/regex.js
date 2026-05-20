// Regex scorer.
//
// `pattern` is compiled with the supplied flags (default `i`).
// `mode = "match"` (default) passes when the output matches; `"nomatch"`
// inverts so you can assert "must NOT match".
//
// Failures during compilation surface as a non-pass result with the
// error in details — better than throwing out of the runner.

export const META = {
  name: "regex",
  label: "Regex",
  description: "Pass when the output matches (or doesn't match) a regular expression.",
  fields: {
    pattern: { label: "Pattern (JS regex source)", kind: "string", required: true },
    flags:   { label: "Flags", kind: "string", default: "i" },
    mode:    { label: "Mode", kind: "enum", options: ["match", "nomatch"], default: "match" },
  },
};

export async function score({ output, expected, config = {} }) {
  const pattern = config.pattern ?? expected;
  if (typeof pattern !== "string" || !pattern) {
    return { passed: false, score: 0, details: { error: "pattern is required" } };
  }
  let re;
  try {
    re = new RegExp(pattern, config.flags || "i");
  } catch (e) {
    return { passed: false, score: 0, details: { error: `invalid regex: ${e.message}` } };
  }
  const matched = re.test(String(output ?? ""));
  const mode = config.mode === "nomatch" ? "nomatch" : "match";
  const passed = mode === "nomatch" ? !matched : matched;
  return {
    passed,
    score: passed ? 1 : 0,
    details: { pattern, flags: config.flags || "i", mode, matched },
  };
}
