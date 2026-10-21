/**
 * Customer-facing support API (/api/support). Everything except sign-in needs
 * a customer session, and every ticket lookup is scoped to the session's own
 * Telegram id inside the service layer — a ticket id belonging to someone
 * else is indistinguishable from one that does not exist.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { default as botInstance } from "../config/botInstance.js";
import {
  CUSTOMER_SESSION_COOKIE,
  consumeCustomerLoginCode,
  createCustomerSession,
  getCustomerSession,
  deleteCustomerSession,
} from "../services/support/customerAuth.js";
import {
  SupportError,
  listCustomerTickets,
  getCustomerTicket,
  getTicketUpdates,
  getMessageAttachment,
} from "../services/support/tickets.js";
import { customerOpenTicket, customerReply, customerSetStatus } from "../services/support/workflow.js";
import { streamAttachment } from "../services/support/attachments.js";
import User from "../models/User.js";
import {
  adminApiHeaders,
  requireSameOrigin,
  adminRateLimit,
  clientIp,
  sessionCookieOptions,
  clearSessionCookieOptions,
  parseCookies,
  NEXT_PANEL_SESSION_COOKIE_PATH,
  RETIRED_PANEL_COOKIE_PATH,
} from "./adminMiddleware.js";

export const CUSTOMER_API_COOKIE_PATH = "/api/support";

const router = express.Router();
router.use(adminApiHeaders);
router.use(requireSameOrigin);

const requireBody = () => express.json({ limit: "32kb" });

function limited({ limit, scope }) {
  return (req, res, next) => {
    const subject = req.customerId ? `cust:${req.customerId}` : `ip:${clientIp(req)}`;
    const result = adminRateLimit({ key: `support:${scope}:${req.method === "GET" ? "r" : "w"}:${subject}`, limit });
    if (!result.allowed) {
      res.set("Retry-After", String(result.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: "rate_limited", retry_after_seconds: result.retryAfterSeconds });
    }
    next();
  };
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a ?? ""));
  const second = Buffer.from(String(b ?? ""));
  return first.length === second.length && timingSafeEqual(first, second);
}

function parseOperationId(body) {
  const value = body?.operationId;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(value)) {
    throw new SupportError("شناسه عملیات نامعتبر است.", { status: 400, code: "invalid_operation_id" });
  }
  return value;
}

router.use(async (req, _res, next) => {
  req.customerSession = null;
  req.customerId = null;
  const token = parseCookies(req.get("cookie"))[CUSTOMER_SESSION_COOKIE];
  if (!token) return next();
  try {
    const session = await getCustomerSession(token);
    req.customerSessionToken = token;
    req.customerSession = session;
    req.customerId = session?.userTelegramId ?? null;
  } catch (error) {
    req.customerSessionError = error;
  }
  next();
});

// ── Authentication ───────────────────────────────────────────────────────────
router.post("/auth/verify", limited({ limit: 10, scope: "verify" }), requireBody(), async (req, res, next) => {
  try {
    const telegramId = await consumeCustomerLoginCode(String(req.body?.code ?? ""));
    if (!telegramId) throw new SupportError("لینک ورود نامعتبر است، منقضی شده یا قبلاً استفاده شده است. از ربات یک لینک جدید بگیرید.", { status: 401, code: "invalid_login_code" });
    if (req.customerSessionToken) await deleteCustomerSession(req.customerSessionToken).catch(() => {});
    const { token, session, ttlSeconds } = await createCustomerSession(telegramId);
    res.cookie(CUSTOMER_SESSION_COOKIE, token, sessionCookieOptions(ttlSeconds, CUSTOMER_API_COOKIE_PATH));
    res.cookie(CUSTOMER_SESSION_COOKIE, token, sessionCookieOptions(ttlSeconds, NEXT_PANEL_SESSION_COOKIE_PATH));
    res.clearCookie(CUSTOMER_SESSION_COOKIE, clearSessionCookieOptions(RETIRED_PANEL_COOKIE_PATH));
    res.json({ ok: true, csrfToken: session.csrfToken, expiresInSeconds: ttlSeconds });
  } catch (error) { next(error); }
});

router.get("/auth/session", (req, res) => {
  if (req.customerSessionError) return res.status(503).json({ ok: false, error: "session_store_unavailable" });
  if (!req.customerSession) return res.json({ ok: true, authenticated: false });
  res.json({ ok: true, authenticated: true, csrfToken: req.customerSession.csrfToken, expiresAt: req.customerSession.expiresAt });
});

router.post("/auth/logout", requireBody(), async (req, res, next) => {
  try {
    if (req.customerSessionToken) await deleteCustomerSession(req.customerSessionToken).catch(() => {});
    res.clearCookie(CUSTOMER_SESSION_COOKIE, clearSessionCookieOptions(CUSTOMER_API_COOKIE_PATH));
    res.clearCookie(CUSTOMER_SESSION_COOKIE, clearSessionCookieOptions(NEXT_PANEL_SESSION_COOKIE_PATH));
    res.clearCookie(CUSTOMER_SESSION_COOKIE, clearSessionCookieOptions(RETIRED_PANEL_COOKIE_PATH));
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ── Everything below needs a customer session (+ CSRF for mutations) ─────────
router.use((req, res, next) => {
  if (req.customerSessionError) return res.status(503).json({ ok: false, error: "session_store_unavailable" });
  if (!req.customerSession) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !safeEqual(req.get("x-csrf-token"), req.customerSession.csrfToken)) {
    return res.status(403).json({ ok: false, error: "csrf_token_invalid" });
  }
  next();
});
router.use(limited({ limit: 120, scope: "api" }));

/**
 * Display name for the admin-group header. Purely cosmetic, so it is bounded
 * (a slow or disconnected database must never delay or fail ticket creation).
 */
async function telegramProfile(userId) {
  const profile = { id: Number(userId), first_name: "", username: "" };
  if (mongoose.connection.readyState !== 1) return profile;
  const lookup = User.findOne({ telegramId: String(userId) }).select("firstName username").lean().maxTimeMS(1000).catch(() => null);
  const user = await Promise.race([lookup, new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 1000); timer.unref?.(); })]);
  return { ...profile, first_name: user?.firstName || "", username: user?.username || "" };
}

router.get("/tickets", async (req, res, next) => {
  try { res.json({ ok: true, data: { tickets: await listCustomerTickets({ userId: req.customerId, limit: req.query.limit }) } }); }
  catch (error) { next(error); }
});

router.post("/tickets", limited({ limit: 10, scope: "create" }), requireBody(), async (req, res, next) => {
  try {
    const operationId = parseOperationId(req.body);
    const result = await customerOpenTicket({
      bot: botInstance.bot,
      from: await telegramProfile(req.customerId),
      userId: req.customerId,
      subject: req.body.subject,
      text: req.body.text,
      dedupeKey: `web:${req.customerId}:${operationId}`,
      channel: "web",
    });
    res.status(result.created ? 201 : 200).json({ ok: true, data: { ticket: result.ticket, replayed: result.duplicate, forwarded: result.forwarded } });
  } catch (error) { next(error); }
});

router.get("/tickets/:ticketId/updates", async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getTicketUpdates({ audience: "customer", userId: req.customerId, ticketId: req.params.ticketId, afterId: req.query.after, markRead: req.query.markRead === "1" }) });
  } catch (error) { next(error); }
});

router.get("/tickets/:ticketId", async (req, res, next) => {
  try { res.json({ ok: true, data: await getCustomerTicket({ userId: req.customerId, ticketId: req.params.ticketId }) }); }
  catch (error) { next(error); }
});

router.post("/tickets/:ticketId/messages", limited({ limit: 30, scope: "reply" }), requireBody(), async (req, res, next) => {
  try {
    const operationId = parseOperationId(req.body);
    const result = await customerReply({
      bot: botInstance.bot,
      from: await telegramProfile(req.customerId),
      userId: req.customerId,
      ticketId: req.params.ticketId,
      text: req.body.text,
      dedupeKey: `web:${req.customerId}:${operationId}`,
    });
    res.json({ ok: true, data: { ticket: result.ticket, replayed: result.duplicate, forwarded: result.forwarded } });
  } catch (error) { next(error); }
});

router.post("/tickets/:ticketId/status", limited({ limit: 20, scope: "status" }), requireBody(), async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (status !== "closed" && status !== "open") throw new SupportError("وضعیت معتبر نیست.", { status: 400, code: "invalid_status" });
    const result = await customerSetStatus({ bot: botInstance.bot, userId: req.customerId, ticketId: req.params.ticketId, status });
    res.json({ ok: true, data: { ticket: result.ticket } });
  } catch (error) { next(error); }
});

router.get("/attachments/:messageId", limited({ limit: 60, scope: "attachment" }), async (req, res, next) => {
  try {
    const attachment = await getMessageAttachment({ messageId: req.params.messageId, ownerId: req.customerId });
    await streamAttachment({ bot: botInstance.bot, attachment, res });
  } catch (error) { next(error); }
});

router.use((error, req, res, _next) => {
  if (error instanceof SupportError || (Number.isInteger(error?.status) && typeof error?.code === "string" && typeof error?.safeMessage === "string")) {
    return res.status(error.status).json({ ok: false, error: error.code, message: error.safeMessage });
  }
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) return res.status(400).json({ ok: false, error: "invalid_json" });
  if (error?.type === "entity.too.large") return res.status(413).json({ ok: false, error: "payload_too_large" });
  console.error(JSON.stringify({
    ts: new Date().toISOString(), service: "support-web", level: "error", message: "Support API request failed",
    method: req.method, errorType: error?.name || "Error", ref: randomUUID().slice(0, 8),
  }));
  res.status(500).json({ ok: false, error: "internal_error", message: "درخواست انجام نشد. دوباره تلاش کنید." });
});

export default router;
