// Recursive character text splitter — same approach as LangChain's
// RecursiveCharacterTextSplitter but lean (no external deps).
//
// The algorithm tries to keep semantically related content together by
// preferring strong separators first:
//
//   1. paragraph break  ("\n\n")
//   2. line break       ("\n")
//   3. sentence boundary  (". ")
//   4. word boundary    (" ")
//   5. character split  ("")  — last resort
//
// At each level we split, greedily pack pieces until adding one more
// would exceed chunkSize, emit the packed group as a chunk, then move
// on. If a single piece is itself too large, we recurse with the next
// separator.
//
// `overlap` is then applied as a tail-prefix transfer between
// consecutive chunks so a sentence straddling a chunk boundary still
// has context on both sides.

const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/**
 * Split text into chunks no larger than `chunkSize` characters.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.chunkSize=800]
 * @param {number} [opts.overlap=100]
 * @returns {string[]}
 */
export function chunkText(text, { chunkSize = 800, overlap = 100 } = {}) {
  if (!text) return [];
  const clean = String(text).replace(/\r\n/g, "\n");
  if (clean.length <= chunkSize) return [clean.trim()].filter(Boolean);

  const parts = splitRecursive(clean, Math.max(50, chunkSize), 0);
  return applyOverlap(parts, Math.max(0, Math.min(overlap, chunkSize - 1)));
}

function splitRecursive(text, size, sepIdx) {
  if (text.length <= size) return [text];
  const sep = SEPARATORS[sepIdx];

  // Bottom of the ladder: hard char split with no overlap. The
  // public chunkText() applies overlap once on the way out.
  if (sep === "") {
    const out = [];
    for (let i = 0; i < text.length; i += size) {
      out.push(text.slice(i, i + size));
    }
    return out;
  }

  const pieces = text.split(sep);
  const out = [];
  let cur = "";

  for (const piece of pieces) {
    const candidate = cur ? cur + sep + piece : piece;
    if (candidate.length > size) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      if (piece.length > size) {
        // Piece itself overflows — recurse with the next separator.
        for (const sub of splitRecursive(piece, size, sepIdx + 1)) {
          if (cur && (cur + sep + sub).length <= size) {
            cur = cur + sep + sub;
          } else {
            if (cur) out.push(cur);
            cur = sub;
          }
        }
      } else {
        cur = piece;
      }
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function applyOverlap(parts, overlap) {
  if (overlap <= 0 || parts.length < 2) return parts;
  const out = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - overlap));
    out.push(tail + (tail.endsWith("\n") || tail.endsWith(" ") ? "" : " ") + parts[i]);
  }
  return out;
}

/** Rough char→token estimate. Adequate for budget accounting; the
 *  embedding provider's response carries the authoritative count. */
export function estimateTokens(s) {
  return Math.ceil((s || "").length / 4);
}
