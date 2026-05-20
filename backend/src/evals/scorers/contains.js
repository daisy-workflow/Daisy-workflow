// Contains scorer.
//
// Expected is either a single string or an array of strings; pass
// when ALL of them are substrings of the output. Mode `any` flips
// the semantics to "pass if at least one is present" — useful for
// "must mention either Alice or Bob".
//
// Optional `mustNotContain` array — fail if any of these are found.
// Catches "should never apologise" / "shouldn't say sorry" style
// regressions.

export const META = {
  name: "contains",
  label: "Contains",
  description: "Pass when the output contains the required substring(s).",
  fields: {
    expected:        { label: "Required substring(s)", kind: "string-array", required: true },
    mode:            { label: "Match mode", kind: "enum", options: ["all", "any"], default: "all" },
    caseSensitive:   { label: "Case sensitive", kind: "bool", default: false },
    mustNotContain:  { label: "Forbidden substring(s)", kind: "string-array" },
  },
};

export async function score({ output, expected, config = {} }) {
  const wanted = normaliseList(expected ?? config.expected);
  const forbidden = normaliseList(config.mustNotContain);
  const mode = config.mode === "any" ? "any" : "all";
  const cs = config.caseSensitive === true;

  const hay = cs ? String(output ?? "") : String(output ?? "").toLowerCase();
  const norm = (s) => cs ? s : s.toLowerCase();

  const wantedHits = wanted.map(w => ({ phrase: w, present: hay.includes(norm(w)) }));
  const forbiddenHits = forbidden.map(f => ({ phrase: f, present: hay.includes(norm(f)) }));

  const wantedPass = mode === "any"
    ? wantedHits.some(h => h.present)
    : wantedHits.every(h => h.present);
  const forbiddenPass = forbiddenHits.every(h => !h.present);
  const passed = wantedPass && forbiddenPass;

  return {
    passed,
    score: passed ? 1 : 0,
    details: { mode, wanted: wantedHits, forbidden: forbiddenHits },
  };
}

function normaliseList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}
