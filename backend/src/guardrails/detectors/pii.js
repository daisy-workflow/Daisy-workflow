// PII detector — pattern-based.
//
// Fast, deterministic, zero-dependency. Catches the common entity
// types (emails, phones, SSNs, credit cards, IPs, IBANs, URLs)
// without an LLM round-trip. False positives are inevitable with
// pure regex — the credit-card pattern adds a Luhn check to filter
// most of them; the rest fall on the user to tune via the `types`
// allow-list.
//
// Modes (set on the policy):
//   • redact — replace each match with its placeholder ([EMAIL], …)
//   • block  — throw GuardrailBlockedError (handled upstream)
//   • warn   — log only; text passes through unchanged
//
// The redaction never persists the matched value to the violations
// table — `valuePreview` is masked to "ab****@example.com" style.

const PATTERNS = {
  email: {
    label: "Email address",
    placeholder: "[EMAIL]",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  phone: {
    label: "Phone number",
    placeholder: "[PHONE]",
    // Liberal phone matcher — international + US formats. Restricts
    // the minimum to 10 digits total to filter accidental "1 2 3 4 5"
    // matches.
    re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
    minDigits: 10,
  },
  ssn: {
    label: "US SSN",
    placeholder: "[SSN]",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  credit_card: {
    label: "Credit card",
    placeholder: "[CREDIT_CARD]",
    // 13-19 contiguous digits allowing spaces / hyphens as separators.
    // Validated with Luhn below to drop obvious false positives like
    // long invoice numbers.
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (s) => luhn(s),
  },
  ipv4: {
    label: "IPv4 address",
    placeholder: "[IP]",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  iban: {
    label: "IBAN",
    placeholder: "[IBAN]",
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
  },
  url: {
    label: "URL",
    placeholder: "[URL]",
    re: /https?:\/\/[^\s<>"']+/gi,
  },
};

export const TYPES = Object.keys(PATTERNS);

export const META = {
  name: "pii",
  label: "PII patterns",
  description:
    "Regex-based detection of common PII (email, phone, SSN, credit card, IPv4, IBAN, URL). " +
    "Fast and deterministic. Use redact for first-line defence; block when you need a hard stop.",
  modes: ["redact", "block", "warn"],
  defaultMode: "redact",
  fields: {
    types: {
      label: "Entity types",
      kind:  "multi-select",
      options: TYPES.map(t => ({ value: t, label: PATTERNS[t].label })),
      default: ["email", "phone", "ssn", "credit_card", "ipv4", "iban"],
    },
  },
};

/**
 * Scan `text` and (when in redact mode) replace matches with the
 * detector's placeholder. The redacted string is returned even when
 * the consumer is using warn/block mode — they're free to ignore it.
 */
export async function detect(text, cfg = {}) {
  if (!text || typeof text !== "string") return { flagged: false, matches: [] };
  const allowed = cfg.types?.length ? cfg.types : Object.keys(PATTERNS);

  const matches = [];
  for (const type of allowed) {
    const p = PATTERNS[type];
    if (!p) continue;
    // matchAll() returns a clean iterator that doesn't share lastIndex
    // state across calls — safe to use across concurrent invocations.
    for (const m of text.matchAll(p.re)) {
      const value = m[0];
      if (p.validate && !p.validate(value)) continue;
      if (p.minDigits) {
        const digits = value.replace(/\D/g, "");
        if (digits.length < p.minDigits) continue;
      }
      matches.push({
        type,
        label: p.label,
        index: m.index,
        length: value.length,
        valuePreview: maskValue(value),
      });
    }
  }
  if (!matches.length) return { flagged: false, matches: [] };

  // Build the redacted string by walking the matches right-to-left so
  // each replacement doesn't shift the indices of the matches we
  // haven't processed yet.
  const sorted = [...matches].sort((a, b) => b.index - a.index);
  let redacted = text;
  for (const m of sorted) {
    redacted =
      redacted.slice(0, m.index) +
      PATTERNS[m.type].placeholder +
      redacted.slice(m.index + m.length);
  }

  return {
    flagged: true,
    matches: matches.map(m => ({
      type: m.type, label: m.label, valuePreview: m.valuePreview,
    })),
    redacted,
  };
}

// ─── helpers ────────────────────────────────────────────────────

/** Luhn checksum — credit cards. */
function luhn(s) {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * "alice@example.com" → "al***@example.com"
 * "1234567890123456"  → "1234********3456"
 * Anything else       → keep first 2 + last 2, mask the middle.
 */
function maskValue(v) {
  if (v.includes("@")) {
    const [local, domain] = v.split("@");
    if (!local) return v;
    const visible = Math.max(1, Math.min(2, local.length - 1));
    return local.slice(0, visible) + "*".repeat(Math.max(1, local.length - visible)) + "@" + domain;
  }
  const digitsOnly = v.replace(/\D/g, "");
  if (digitsOnly.length >= 10) {
    return v.slice(0, 4) + "*".repeat(Math.max(4, v.length - 8)) + v.slice(-4);
  }
  if (v.length <= 4) return "***";
  return v.slice(0, 2) + "*".repeat(v.length - 4) + v.slice(-2);
}
