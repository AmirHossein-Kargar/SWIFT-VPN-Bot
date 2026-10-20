import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const OPTIONS = {
  dotfiles: "ignore",
  extensions: [],
  fallthrough: true,
  index: false,
  maxAge: "1h",
  redirect: false,
};

// Scripts only from this origin (no inline handlers). Inline styles are allowed
// because the SPA sets style attributes on generated markup; Google Fonts are
// the only third-party origin.
export const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Public storefront: same strict script policy; it also only talks to its own
// origin (/api/store) and links out to Telegram.
export const STORE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Admin application entry points. Everything else is the storefront or 404. */
const ADMIN_PAGE = /^\/(?:panel|admin)(?:\/.*)?$/;

let staticMiddleware = null;

function ensureStatic() {
  if (staticMiddleware) return staticMiddleware;
  staticMiddleware = express.static(webRoot, OPTIONS);
  return staticMiddleware;
}

function safeRelative(urlPath) {
  // Express req.path is absolute ("/admin/users"); strip it before normalizing
  // so traversal attempts and absolute paths are both rejected.
  const stripped = String(urlPath).replace(/^\/+/, "");
  const resolved = path.normalize(stripped).replace(/^([.][.][/\\])+/, "");
  if (!resolved || resolved === "." || resolved.startsWith("..") || path.isAbsolute(resolved)) return null;
  return resolved;
}

export function serveAdminSpa(req, res, next) {
  // API and health endpoints are never handled by the SPA.
  if (req.path.startsWith("/api/") || ["/health", "/ready", "/livez"].includes(req.path)) return next();
  if (req.path === "/") return serveStorefront(req, res, next);

  const relative = safeRelative(req.path);
  if (!relative) return next();

  const candidate = path.join(webRoot, relative);
  if (!candidate.startsWith(webRoot)) return next();

  fs.stat(candidate, (statError, stats) => {
    if (!statError && stats.isFile()) {
      return ensureStatic()(req, res, next);
    }
    // The admin app lives at /panel (and the legacy /admin); it routes by hash.
    if (!ADMIN_PAGE.test(req.path)) return next();
    sendAdminShell(res, next);
  });
}

function securityHeaders(res, csp) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendAdminShell(res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  securityHeaders(res, ADMIN_CSP);
  res.sendFile(path.join(webRoot, "index.html"), (sendError) => {
    if (sendError) next();
  });
}

/** Canonical origin for SEO, taken only from a valid public HTTPS WEBHOOK_BASE_URL. */
export function storefrontCanonical(env = process.env) {
  try {
    const parsed = new URL(String(env.WEBHOOK_BASE_URL || "").trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

let storeTemplate = null;
function storeHtml() {
  storeTemplate ??= fs.readFileSync(path.join(webRoot, "store.html"), "utf8");
  const canonical = storefrontCanonical();
  const escaped = canonical ? canonical.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) : null;
  return storeTemplate.replace("<!--canonical-->", escaped
    ? `<link rel="canonical" href="${escaped}" />
  <meta property="og:url" content="${escaped}" />`
    : "");
}

/** GET / — the public VPN storefront. */
export function serveStorefront(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let html;
  try { html = storeHtml(); } catch { return next(); }
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  securityHeaders(res, STORE_CSP);
  res.type("html").send(html);
}

export function notFoundHandler(req, res) {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "not_found" });
  securityHeaders(res, STORE_CSP);
  res.setHeader("Cache-Control", "no-store");
  res.status(404).sendFile(path.join(webRoot, "404.html"), (sendError) => {
    if (sendError && !res.headersSent) res.type("text/plain").send("Not found");
  });
}
