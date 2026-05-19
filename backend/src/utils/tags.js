// Tag helpers — keep the wire format generous (string / comma-string /
// array) so workflow JSON, REST bodies, and query strings all work, but
// normalise everything to the same trimmed-deduped-lowercased string[]
// before it touches the DB.
//
// One source-of-truth normaliser keeps the executions table's tags
// shape boring: no nulls, no whitespace-only entries, no duplicates,
// case-insensitive (storing lowercase so the GIN index matches without
// a citext column).

const MAX_TAG_LEN   = 64;
const MAX_TAG_COUNT = 32;

/**
 * Normalise any tag-shaped input into a clean string[].
 *
 *   normalizeTags("a,b,c")           → ["a", "b", "c"]
 *   normalizeTags(["A", " a ", ""])  → ["a"]
 *   normalizeTags(null)              → []
 *   normalizeTags({foo: 1})          → []
 *
 * Caps: each tag ≤ 64 chars, ≤ 32 tags per execution. Excess is dropped
 * silently — the API treats over-cap inputs as soft errors rather than
 * failing the whole call.
 */
export function normalizeTags(value) {
  if (value == null) return [];

  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") list = value.split(",");
  else return [];

  const seen = new Set();
  const out  = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (!t || t.length > MAX_TAG_LEN) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAG_COUNT) break;
  }
  return out;
}
