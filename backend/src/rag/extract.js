// Text extraction from common document formats.
//
// Plain formats (txt, md, csv, json) are read straight as UTF-8.
// HTML is parsed with jsdom and reduced to body.textContent. PDFs
// and DOCX files require additional packages (pdf-parse and mammoth)
// which are loaded dynamically — they're only pulled in if/when the
// user actually uploads one of those formats, keeping cold-start
// fast for installs that don't need them.
//
// All extractors return:
//   { text: string, contentType: string, meta?: object }
//
// `meta` is reserved for per-document hints (page count, author, …)
// that future versions can surface in retrieval results. Today no
// extractor populates it.

import { JSDOM } from "jsdom";

const MAX_FETCH_BYTES = Number(process.env.KB_MAX_FETCH_BYTES) || 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Extract plain text from a Buffer of bytes.
 *
 * @param {Buffer} buffer
 * @param {string} [filename]   used as a fallback for mime detection
 * @param {string} [mimeType]   preferred when available
 */
export async function extractFromBuffer(buffer, filename = "", mimeType = "") {
  const ct  = (mimeType || "").toLowerCase().split(";")[0].trim();
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (ct === "application/pdf" || ext === "pdf") {
    return { text: await pdfToText(buffer), contentType: "application/pdf" };
  }
  if (ct.includes("officedocument.wordprocessingml") || ext === "docx") {
    return {
      text: await docxToText(buffer),
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  if (ct.startsWith("text/html") || ext === "html" || ext === "htm") {
    return { text: htmlToText(buffer.toString("utf8")), contentType: "text/html" };
  }
  if (ct === "text/markdown" || ext === "md" || ext === "markdown") {
    return { text: buffer.toString("utf8"), contentType: "text/markdown" };
  }
  if (ct === "text/csv" || ext === "csv") {
    return { text: buffer.toString("utf8"), contentType: "text/csv" };
  }
  if (ct === "application/json" || ext === "json") {
    return { text: buffer.toString("utf8"), contentType: "application/json" };
  }
  if (ct.startsWith("text/") || ext === "txt" || !ct) {
    // Default: assume utf8 plaintext. Better to over-include than to
    // refuse upload of a perfectly readable file we couldn't sniff.
    return { text: buffer.toString("utf8"), contentType: ct || "text/plain" };
  }
  // Catch-all — best-effort utf8.
  return { text: buffer.toString("utf8"), contentType: ct };
}

function htmlToText(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  // Drop noise. nav/aside aren't dropped — some sites put primary
  // content there. Conservative subset only.
  doc.querySelectorAll("script, style, noscript, template").forEach(n => n.remove());
  const text = (doc.body?.textContent || doc.documentElement.textContent || "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

async function pdfToText(buffer) {
  // Dynamic import — pdf-parse pulls in a chunky pdf.js core. Only
  // worth the boot cost when a PDF actually shows up.
  let pdf;
  try {
    ({ default: pdf } = await import("pdf-parse"));
  } catch (e) {
    throw new Error(
      "pdf-parse is not installed. Run `npm i pdf-parse` in the backend " +
      "to enable PDF ingestion.",
    );
  }
  const data = await pdf(buffer);
  return (data.text || "").replace(/\n{3,}/g, "\n\n").trim();
}

async function docxToText(buffer) {
  let mammoth;
  try {
    mammoth = await import("mammoth");
  } catch (e) {
    throw new Error(
      "mammoth is not installed. Run `npm i mammoth` in the backend " +
      "to enable DOCX ingestion.",
    );
  }
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || "").trim();
}

/**
 * Fetch a URL and extract its text. Respects KB_MAX_FETCH_BYTES.
 *
 * URLs are not sandboxed beyond protocol checks — the caller must
 * already have authenticated the user. SSRF mitigation (private IP
 * ranges) is a Phase B.1 follow-up; for now operators control which
 * users can write to a KB via RBAC and accept that those users can
 * make outbound HTTP fetches.
 */
export async function extractFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("only http/https URLs are supported");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, { redirect: "follow", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);

  const ct = r.headers.get("content-type") || "";
  // Stream-read with a hard cap so a multi-GB response doesn't OOM
  // the API process.
  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_FETCH_BYTES) {
      throw new Error(`fetch ${url} exceeded ${MAX_FETCH_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));

  // Use the URL path's final segment as the filename hint for mime
  // detection when the server didn't send a content-type header.
  let filename = "";
  try {
    filename = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
  } catch { /* malformed URL — ignore */ }

  return extractFromBuffer(buf, filename, ct);
}
