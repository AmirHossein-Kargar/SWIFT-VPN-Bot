import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";
import { brotliCompressSync, gzipSync } from "node:zlib";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// Matches .html/.htm, tolerating trailing dots/spaces that Windows file
// systems ignore when resolving a path.
const HTML_FILE = /\.html?[.\s]*$/i;

/** Next.js static build output (web/public/_next/static/**), written by scripts/build-storefront.mjs. */
const HASHED_ASSET = /[\\/]_next[\\/]static[\\/]/;
const PRECOMPRESSED_ASSET = /^\/_next\/static\/.+\.(?:js|css)$/;

export const STATIC_OPTIONS = {
  dotfiles: "ignore",
  extensions: [],
  fallthrough: true,
  index: false,
  maxAge: "1h",
  redirect: false,
  // Safety net: the HTML shells are routed to their own handlers below, but
  // any HTML that still reaches the static middleware must never be framable
  // or publicly cached. Scripts, styles and images keep the 1h public cache.
  setHeaders(res, filePath) {
    // Content-hashed storefront build assets never change under the same URL.
    if (HASHED_ASSET.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return;
    }
    if (!HTML_FILE.test(filePath)) return;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    securityHeaders(res, ADMIN_CSP);
  },
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
  "manifest-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Extra hardening for public storefront responses. HSTS is sent only when the
 * request really arrived over HTTPS (Railway terminates TLS and sets
 * X-Forwarded-Proto; `trust proxy` makes req.secure honour it), so plain-HTTP
 * local development is never pinned to HTTPS. No includeSubDomains/preload:
 * this host is the only thing the header should commit to.
 */
export function storefrontHardening(req, res) {
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

/** Admin application entry points. Everything else is the storefront or 404. */
const ADMIN_PAGE = /^\/(?:panel|admin)(?:\/.*)?$/;

/** HTML files in web/public and the route whose headers they must carry. */
// storefront.html is the Next.js build of the storefront; store.html is the static fallback.
const HTML_SHELLS = Object.freeze({ "index.html": "admin", "store.html": "store", "storefront.html": "store", "404.html": "notFound" });

let staticMiddleware = null;

function ensureStatic() {
  if (staticMiddleware) return staticMiddleware;
  staticMiddleware = express.static(webRoot, STATIC_OPTIONS);
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
  if (req.path === "/robots.txt") return serveRobots(req, res, next);
  if (req.path === "/sitemap.xml") return serveSitemap(req, res, next);
  if (PRECOMPRESSED_ASSET.test(req.path)) return servePrecompressed(req, res, () => servePublicFile(req, res, next));
  return servePublicFile(req, res, next);
}

function servePublicFile(req, res, next) {
  const relative = safeRelative(req.path);
  if (!relative) return next();

  const candidate = path.join(webRoot, relative);
  if (!candidate.startsWith(webRoot)) return next();

  fs.stat(candidate, (statError, stats) => {
    if (!statError && stats.isFile()) {
      // HTML shells requested by file name get exactly the headers of their
      // canonical route (/index.html is the admin sign-in page).
      const shell = HTML_SHELLS[relative.replace(/\\/g, "/").replace(/[.\s]+$/, "").toLowerCase()];
      if (shell === "admin") return sendAdminShell(res, next);
      if (shell === "store") return serveStorefront(req, res, next);
      if (shell === "notFound") return notFoundHandler(req, res);
      return ensureStatic()(req, res, next);
    }
    // Legacy-shell fallback for /panel and /admin; in practice nextAdminMiddleware answers those first (Next.js panel / 307), so only /index.html reaches the legacy dashboard.
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

/** Whether an Accept-Encoding header allows `name` (an explicit q=0 refuses it). */
export function acceptsEncoding(header, name) {
  for (const part of String(header || "").split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    if (token !== name) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

/**
 * Serves the .br/.gz copy that scripts/build-storefront.mjs wrote next to a
 * build asset. The Express app has no compression middleware, so without this
 * the storefront's JavaScript would be sent uncompressed. Falls through to the
 * normal static handler when the client or the build has no compressed variant.
 */
export function servePrecompressed(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const relative = safeRelative(req.path);
  if (!relative) return next();
  const file = path.join(webRoot, relative);
  if (!file.startsWith(webRoot + path.sep)) return next();
  const candidates = [["br", ".br"], ["gzip", ".gz"]].filter(([name]) => acceptsEncoding(req.headers["accept-encoding"], name));
  const pick = (index) => {
    const entry = candidates[index];
    if (!entry) return next();
    const [encoding, extension] = entry;
    fs.stat(file + extension, (error, stats) => {
      if (error || !stats.isFile()) return pick(index + 1);
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Content-Type", path.extname(file) === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000");
      res.sendFile(file + extension, { cacheControl: false, dotfiles: "allow" }, (sendError) => {
        if (sendError && !res.headersSent) {
          res.removeHeader("Content-Encoding");
          next();
        }
      });
    });
  };
  pick(0);
}

/** Inserts the canonical link + og:url. Works with or without the <!--canonical--> marker. */
export function injectCanonical(html, canonical) {
  const escaped = canonical ? canonical.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) : null;
  const tags = escaped ? `<link rel="canonical" href="${escaped}" />
  <meta property="og:url" content="${escaped}" />` : "";
  // Social crawlers (Telegram, X, ...) need absolute image URLs; the page ships site-relative ones.
  const origin = escaped ? escaped.replace(/\/$/, "") : null;
  const absolute = origin
    ? html.replace(/(<meta[^>]*?(?:property="og:image"|name="twitter:image")[^>]*?content=")(\/[^"]*)(")/g, (_match, before, imagePath, after) => `${before}${origin}${imagePath}${after}`)
    : html;
  if (absolute.includes("<!--canonical-->")) return absolute.replace("<!--canonical-->", () => tags);
  // The Next.js build has no HTML comments to anchor on: insert before </head>.
  return tags ? absolute.replace("</head>", () => `${tags}</head>`) : absolute;
}

let storeTemplate = null;
/** The Next.js build when present (scripts/build-storefront.mjs), otherwise the static page. */
function storeTemplateHtml() {
  if (storeTemplate) return storeTemplate;
  for (const name of ["storefront.html", "store.html"]) {
    try {
      storeTemplate = fs.readFileSync(path.join(webRoot, name), "utf8");
      return storeTemplate;
    } catch { /* try the next candidate */ }
  }
  throw new Error("storefront HTML missing");
}

const compressedHtml = new Map();
function encodedStorefront(html, acceptEncoding) {
  const encoding = acceptsEncoding(acceptEncoding, "br") ? "br" : acceptsEncoding(acceptEncoding, "gzip") ? "gzip" : null;
  if (!encoding) return null;
  const key = `${encoding}:${html}`;
  if (!compressedHtml.has(key)) {
    if (compressedHtml.size >= 4) compressedHtml.clear(); // canonical only varies with the env: keep this tiny
    const body = Buffer.from(html, "utf8");
    compressedHtml.set(key, encoding === "br" ? brotliCompressSync(body) : gzipSync(body, { level: 9 }));
  }
  return { encoding, body: compressedHtml.get(key) };
}

/** GET / — the public VPN storefront. */
export function serveStorefront(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let html;
  try { html = injectCanonical(storeTemplateHtml(), storefrontCanonical()); } catch { return next(); }
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Vary", "Accept-Encoding");
  securityHeaders(res, STORE_CSP);
  storefrontHardening(req, res);
  const encoded = encodedStorefront(html, req.headers["accept-encoding"]);
  if (encoded) {
    res.setHeader("Content-Encoding", encoded.encoding);
    return res.type("html").send(encoded.body);
  }
  res.type("html").send(html);
}

/** robots.txt: the storefront is indexable; the admin panels and JSON APIs are not. */
export function robotsTxt(canonical) {
  const lines = ["User-agent: *", "Disallow: /panel", "Disallow: /admin", "Disallow: /api/"];
  if (canonical) lines.push("", `Sitemap: ${canonical}sitemap.xml`);
  return `${lines.join("\n")}\n`;
}

/** sitemap.xml: only the storefront URL. Null without a valid public HTTPS WEBHOOK_BASE_URL (sitemaps need absolute URLs). */
export function sitemapXml(canonical) {
  if (!canonical) return null;
  const loc = canonical.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${loc}</loc></url>\n</urlset>\n`;
}

function serveRobots(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("text/plain").send(robotsTxt(storefrontCanonical()));
}

function serveSitemap(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const xml = sitemapXml(storefrontCanonical());
  if (!xml) return notFoundHandler(req, res);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("application/xml").send(xml);
}

export function notFoundHandler(req, res) {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "not_found" });
  securityHeaders(res, STORE_CSP);
  storefrontHardening(req, res);
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  res.status(404).sendFile(path.join(webRoot, "404.html"), (sendError) => {
    if (sendError && !res.headersSent) res.type("text/plain").send("Not found");
  });
}
