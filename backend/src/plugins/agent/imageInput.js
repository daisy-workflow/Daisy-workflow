// Shared image-input normaliser for the vision-capable providers.
//
// Accepts three input forms (the agent plugin's `images` array can
// mix any of them):
//
//   1. https://... or http://...        → kept as URL
//   2. data:image/png;base64,AAAA...    → split into { mimeType, base64 }
//   3. AAAA...                          → assumed base64 body; mimeType
//                                          defaults to image/png (or
//                                          sniffed from the magic bytes
//                                          when we can recognise them)
//
// Output is always:
//
//   { kind: "url",    url:      string }                 // pass-through
//   { kind: "base64", mimeType: string, data: string }   // raw base64 body, no prefix
//
// Each provider then maps that to its native shape:
//   • OpenAI    → { type: "image_url", image_url: { url: "<data URL or http(s) URL>" } }
//   • Anthropic → { type: "image", source: { type: "base64"|"url", media_type, data|url } }
//   • Gemini    → { inlineData: { mimeType, data } }    (base64 only — Gemini doesn't
//                                                        accept arbitrary HTTPS URLs)
//   • Bedrock   → Anthropic's shape via Converse — but Converse's
//                  image content expects { image: { format, source: { bytes } } } —
//                  conversion is provider-local.
//
// Centralising the parse here means a new provider lands as a small
// "what does its native shape look like" function, not yet-another
// data-URL parser.

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/i;
const HTTP_URL_RE = /^https?:\/\//i;

const MAGIC_BYTES = [
  { mime: "image/png",  prefix: "iVBORw0KGgo" },                         // PNG
  { mime: "image/jpeg", prefix: ["/9j/4AAQ", "/9j/2wB", "/9j/4QA"] },    // JPEG
  { mime: "image/gif",  prefix: ["R0lGOD"] },                            // GIF
  { mime: "image/webp", prefix: "UklGR" },                               // WEBP
];

/** Sniff a base64 body for a known image magic header. PNGs always
 *  base64-start with "iVBORw0KGgo", JPEGs with "/9j/", etc. */
function sniffMime(b64) {
  for (const m of MAGIC_BYTES) {
    const prefixes = Array.isArray(m.prefix) ? m.prefix : [m.prefix];
    if (prefixes.some(p => b64.startsWith(p))) return m.mime;
  }
  return "image/png";   // safe default — most provider APIs accept it
}

/**
 * Normalise a single image string into one of the two output shapes.
 */
export function normaliseImage(raw) {
  if (typeof raw !== "string" || !raw) {
    throw new Error("image input must be a non-empty string");
  }
  if (HTTP_URL_RE.test(raw)) {
    return { kind: "url", url: raw };
  }
  const m = raw.match(DATA_URL_RE);
  if (m) {
    return { kind: "base64", mimeType: m[1].toLowerCase(), data: m[2] };
  }
  // Bare base64 body. Tolerate accidental whitespace from
  // multi-line copy-paste.
  const data = raw.replace(/\s+/g, "");
  return { kind: "base64", mimeType: sniffMime(data), data };
}

/** Normalise an entire `images` array. */
export function normaliseImages(images) {
  if (!images) return [];
  if (!Array.isArray(images)) {
    throw new Error("agent input `images` must be an array of strings");
  }
  return images.map(normaliseImage);
}

/**
 * Convenience used by OpenAI: rebuild a data URL string (the OpenAI
 * Chat Completions API accepts either an https URL or a data URL).
 */
export function toDataUrl({ kind, mimeType, data, url }) {
  if (kind === "url") return url;
  return `data:${mimeType};base64,${data}`;
}
