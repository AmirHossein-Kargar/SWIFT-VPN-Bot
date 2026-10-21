import path from "node:path";
import { fileURLToPath } from "node:url";

export const ADMIN_PANEL_NEXT_BASE_PATH = "/panel-next";

const adminPanelDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "admin-panel");

let handlerPromise = null;

/**
 * The redesigned admin panel runs as a Next.js app embedded in this same
 * Express process (same Railway service, same single instance the Telegram
 * poller requires). It never imports the bot's service modules directly —
 * Next would bundle its own copy of them, splitting the Mongo/Redis/bot
 * singletons — so it only ever talks to the existing /api/admin REST surface,
 * same as a browser would. Preparing Next is deferred to the first request so
 * importing this module has no cost for requests that never touch /panel-next.
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
 * Anti-framing and sniffing protection for the admin UI, matching what the
 * legacy /panel shell already sends. Deliberately NOT a script-src policy:
 * Next.js and next-themes emit inline bootstrap scripts, so restricting
 * scripts would need per-request nonces. frame-ancestors alone closes
 * clickjacking, which is the relevant risk for a CSRF-protected admin UI.
 */
export function applyNextPanelHeaders(res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export function nextAdminMiddleware(req, res, next) {
  if (req.path !== ADMIN_PANEL_NEXT_BASE_PATH && !req.path.startsWith(`${ADMIN_PANEL_NEXT_BASE_PATH}/`)) {
    return next();
  }
  applyNextPanelHeaders(res);
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
