/**
 * Browser-facing policy for the admin and support surfaces: which origins are trusted, what CORS may answer, and the
 * response headers these pages and APIs carry. None of this authenticates anyone. CORS and the Origin check only decide
 * what a browser may do on a page's behalf; the session and the CSRF token are still required on every request they let
 * through (web/adminMiddleware.js). See docs/admin.md#browser-protections.
 */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Same value as the storefront. No includeSubDomains or preload: this host is all the header should commit to. */
export const HSTS_HEADER = "max-age=15552000";

/** The panel uses none of these; clipboard is left at its default because findings can be copied. */
export const ADMIN_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "bluetooth=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/** JSON and file responses never need to load or frame anything. */
export const API_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const CORS_ALLOWED_METHODS = Object.freeze(["GET", "HEAD", "POST", "PATCH", "DELETE"]);
export const CORS_ALLOWED_HEADERS = Object.freeze(["content-type", "x-csrf-token"]);
const CORS_MAX_AGE_SECONDS = 600;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The exact origin of a configured value, or null. Wildcards, credentials, paths, queries and fragments are refused
 * rather than repaired: a list entry that cannot be read as written must not silently widen what is trusted.
 */
export function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.includes("*")) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  return url.origin;
}

/** WEBHOOK_BASE_URL is validated at startup and only its origin matters here. */
function baseUrlOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return normalizeOrigin(new URL(value.trim()).origin); } catch { return null; }
}

function usableInProduction(origin) {
  const url = new URL(origin);
  return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Trusted browser origins, read from configuration only: the public origin, the domain the platform assigned (so the
 * panel keeps working on it behind a custom WEBHOOK_BASE_URL) and the explicit ADMIN_ALLOWED_ORIGINS list. In production
 * plain HTTP is accepted for loopback addresses only.
 */
export function readTrustedOrigins(env = process.env) {
  const production = env.NODE_ENV === "production";
  const origins = new Set();
  let ignored = 0;
  const add = (origin) => {
    if (!origin || (production && !usableInProduction(origin))) { ignored += 1; return; }
    origins.add(origin);
  };
  if (String(env.WEBHOOK_BASE_URL ?? "").trim()) add(baseUrlOrigin(env.WEBHOOK_BASE_URL));
  const platformDomain = String(env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (platformDomain) add(normalizeOrigin(`https://${platformDomain}`));
  for (const entry of String(env.ADMIN_ALLOWED_ORIGINS ?? "").split(",")) {
    if (entry.trim()) add(normalizeOrigin(entry));
  }
  return { origins, ignored, production };
}

/**
 * Exact string match against the browser's Origin header, so `null`, another scheme or a look-alike suffix never match.
 * Outside production nothing may be configured for the address in use, so the request's own origin also counts; the Host
 * header is client-supplied and is never consulted in production.
 */
export function isTrustedOrigin(req, origin, env = process.env) {
  const { origins, production } = readTrustedOrigins(env);
  if (origins.has(origin)) return true;
  return !production && origin === `${req.protocol}://${req.get("host")}`;
}

/** Fetch Metadata says the request came from another site, even where no Origin header is sent (a top-level GET). */
export function isCrossSiteFetch(req) {
  const site = req.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

/**
 * Answers preflights and labels responses for trusted origins, always with the exact origin and never `*`. An untrusted
 * origin gets no CORS header at all. Headers on a response are not permission to act: the routes behind this still
 * require a session and a CSRF token.
 */
export function apiCors(req, res, next) {
  res.vary("Origin");
  const origin = req.get("origin");
  if (!origin) return next();
  const requestedMethod = req.get("access-control-request-method");
  const preflight = req.method === "OPTIONS" && Boolean(requestedMethod);
  if (preflight) res.vary(["Access-Control-Request-Method", "Access-Control-Request-Headers"]);
  if (!isTrustedOrigin(req, origin)) {
    if (preflight) return res.status(403).json({ ok: false, error: "origin_not_allowed" });
    return next();
  }
  if (preflight) {
    const requestedHeaders = String(req.get("access-control-request-headers") ?? "")
      .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
    const allowed = CORS_ALLOWED_METHODS.includes(requestedMethod.toUpperCase())
      && requestedHeaders.every((name) => CORS_ALLOWED_HEADERS.includes(name));
    if (!allowed) return res.status(403).json({ ok: false, error: "preflight_not_allowed" });
  }
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Credentials", "true");
  if (!preflight) return next();
  res.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS.join(", "));
  res.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
  res.set("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
  return res.status(204).end();
}

let hstsLastSentAt = null;

/** Evidence for the settings page: HSTS depends on real HTTPS traffic, which only the running server can have seen. */
export function lastHstsSentAt() {
  return hstsLastSentAt;
}

export function resetHstsEvidenceForTests() {
  hstsLastSentAt = null;
}

/**
 * Sent only when the request really arrived over HTTPS (`trust proxy` makes req.secure honour the platform's
 * X-Forwarded-Proto), so plain-HTTP local development is never pinned to HTTPS.
 */
export function applyHsts(req, res) {
  if (!req?.secure) return;
  res.setHeader("Strict-Transport-Security", HSTS_HEADER);
  hstsLastSentAt = Date.now();
}

/** Everything an admin HTML page carries except its CSP. */
export function applyAdminPageHeaders(req, res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", ADMIN_PERMISSIONS_POLICY);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  applyHsts(req, res);
}

/**
 * The Next.js panel's policy. Scripts need this response's nonce or this origin, so an injected inline script does not
 * run. `style-src` keeps 'unsafe-inline' because React server-renders style attributes, which a nonce cannot cover (and a
 * nonce there would switch 'unsafe-inline' off). The dev server additionally needs eval and its HMR websocket.
 */
export function buildPanelCsp(nonce, { dev = false } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
