/**
 * What may leave the process as operational text. The repository is public and this data reaches a browser, so the rule is
 * strict: tokens, URLs, connection strings, addresses, card numbers and Telegram ids are removed whatever the caller
 * thought it was passing. Code paths pass fixed text and coarse codes; this is the second line, not the first.
 */
const REPLACEMENTS = [
  [/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[token]"], // a Telegram bot token
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"], // includes mongodb:// and redis:// connection strings
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[token]"], // a JWT
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[credential]"],
  [/\b(?:api[_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, "[credential]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g, "[address]"], // a TRON address
  [/\b\d(?:[ -]?\d){7,}\b/g, "[number]"], // card numbers, Telegram ids, phone numbers
  [/\b[a-f0-9]{32,}\b/gi, "[hex]"],
];

export function sanitizeText(value, max = 200) {
  let text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A code or an id: only characters that cannot carry a sentence, a URL or markup. */
export function sanitizeCode(value, max = 48) {
  return String(value ?? "").replace(/[^A-Za-z0-9_.:#-]/g, "_").slice(0, max);
}
