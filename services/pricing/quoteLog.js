const SECRET = /(?:x-api-key|authorization|ipn[_-]?secret|api[_-]?key)\s*[:=]\s*\S+/gi;
const TOKEN = /\b[A-Za-z0-9_\-]{24,}\b/g;

export function sanitizeDiagnostic(value) {
  if (value == null) return undefined;
  const text = String(value).replace(SECRET, "[redacted]").replace(TOKEN, "[redacted]");
  return text.slice(0, 180);
}

export function logQuoteFailure(stage, error, extra = {}) {
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const entry = {
    ts: new Date().toISOString(),
    service: "tron-quote",
    level: "warn",
    stage,
    code: sanitizeDiagnostic(error?.code || error?.name || "Error"),
    status,
    providerCode: sanitizeDiagnostic(error?.providerCode),
    message: sanitizeDiagnostic(error?.message),
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) entry[key] = sanitizeDiagnostic(value);
  }
  console.warn(JSON.stringify(entry));
}
