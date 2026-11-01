import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyAdminPageHeaders, buildPanelCsp } from "./webSecurity.js";

/** Canonical public path of the admin panel (and of the customer support area under it). */
export const ADMIN_PANEL_NEXT_BASE_PATH = "/panel";
/**
 * Earlier names of this same panel. Both are permanent (308) redirects so
 * bookmarks, deep links and one-time login links already sent by the bot keep
 * working; the URL fragment (#code=...) survives a redirect in the browser.
 */
export const PREVIOUS_PANEL_PATHS = Object.freeze(["/next-panel", "/panel-next"]);
/** The original vanilla-JS panel's URL. Temporary (307) redirect: the legacy files stay on disk and the move is reversible. */
export const LEGACY_ADMIN_PATH = "/admin";

const adminPanelDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "admin-panel");

let handlerPromise = null;

/**
 * The redesigned admin panel runs as a Next.js app embedded in this same
 * Express process (same Railway service, same single instance the Telegram
 * poller requires). It never imports the bot's service modules directly —
 * Next would bundle its own copy of them, splitting the Mongo/Redis/bot
 * singletons — so it only ever talks to the existing /api/admin REST surface,
 * same as a browser would. Preparing Next is deferred to the first request so
 * importing this module has no cost for requests that never touch /panel.
 */
function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const { default: next } = await import("next");
      const dev = process.env.NODE_ENV !== "production";
      const nextApp = next({ dev, dir: adminPanelDir });
      await nextApp.prepare();
      return nextApp.getRequestHandler();
    })();
  }
  return handlerPromise;
}

/**
 * Next.js and next-themes need inline bootstrap scripts, so each response gets its own script nonce. Next reads it from the
 * CSP on the REQUEST (app-render), and the root layout from x-nonce; both are overwritten here, so a client cannot choose
 * them. Every page must render per request for this to hold, which reading x-nonce in the root layout forces: a prerendered
 * page has no nonce and its scripts would be blocked.
 */
export function applyNextPanelHeaders(req, res) {
  const nonce = randomBytes(16).toString("base64");
  const csp = buildPanelCsp(nonce, { dev: process.env.NODE_ENV !== "production" });
  applyAdminPageHeaders(req, res);
  res.setHeader("Content-Security-Policy", csp);
  req.headers["content-security-policy"] = csp;
  req.headers["x-nonce"] = nonce;
}

/** `/next-panel/<rest>` or `/panel-next/<rest>` -> `/panel/<rest>`; null when the path is neither. */
export function previousPanelRedirectTarget(path) {
  for (const previous of PREVIOUS_PANEL_PATHS) {
    if (path !== previous && !path.startsWith(`${previous}/`)) continue;
    const rest = path.slice(previous.length);
    // Only the fixed prefix is rewritten; a protocol-relative "//host" tail can never become the target.
    return `${ADMIN_PANEL_NEXT_BASE_PATH}${rest.replace(/^\/{2,}/, "/")}`;
  }
  return null;
}

/** `/admin` and `/admin/<anything>` (page URLs only; the API lives under /api/admin) -> the panel root. */
export function legacyAdminRedirectTarget(path) {
  return path === LEGACY_ADMIN_PATH || path.startsWith(`${LEGACY_ADMIN_PATH}/`) ? ADMIN_PANEL_NEXT_BASE_PATH : null;
}

export function nextAdminMiddleware(req, res, next) {
  const redirectTo = previousPanelRedirectTarget(req.path);
  if (redirectTo) {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(308, `${redirectTo}${query}`);
  }
  if (legacyAdminRedirectTarget(req.path)) return res.redirect(307, ADMIN_PANEL_NEXT_BASE_PATH);
  if (req.path !== ADMIN_PANEL_NEXT_BASE_PATH && !req.path.startsWith(`${ADMIN_PANEL_NEXT_BASE_PATH}/`)) {
    return next();
  }
  applyNextPanelHeaders(req, res);
  getHandler().then((handle) => handle(req, res)).catch((error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      service: "admin-panel-next",
      level: "error",
      message: "Next.js admin panel failed to handle a request",
      errorType: error?.name || "Error",
    }));
    if (!res.headersSent) res.status(503).json({ ok: false, error: "admin_panel_unavailable" });
  });
}
