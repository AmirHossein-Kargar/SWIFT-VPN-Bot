import { randomUUID } from "node:crypto";
import express from "express";
import { ADMIN_SESSION_COOKIE, issueAdminLoginCode, consumeAdminLoginCode, createAdminSession, deleteAdminSession, getAdminSession } from "../services/admin/auth.js";
import { AdminServiceError } from "../services/admin/authorization.js";
import { runAuditedAction } from "../services/admin/audit.js";
import { getDashboardMetrics } from "../services/admin/dashboard.js";
import { listUsers, getUserDetail, changeUserBalance, setUserBlocked, getReferralOverview } from "../services/admin/users.js";
import { listVpns, getVpnDetail, performVpnAction } from "../services/admin/vpns.js";
import { listProducts, createProduct, updateProduct, duplicateProduct, reorderProducts } from "../services/admin/products.js";
import { listPayments, getPaymentDetail, retryPayment, markPaymentRecoveryRequired, resolvePaymentRecovery, confirmBankInvoice, rejectBankInvoice } from "../services/admin/payments.js";
import { getRecoveryQueue, retrySafeRecoveryItems } from "../services/admin/recovery.js";
import { previewBroadcast, createBroadcast, getBroadcastStatus, requestBroadcastCancel, listBroadcasts } from "../services/admin/broadcast.js";
import { getAnalytics } from "../services/admin/analytics.js";
import { getSystemHealth } from "../services/admin/monitoring.js";
import { listAuditLogs } from "../services/admin/audit.js";
import { default as botInstance } from "../config/botInstance.js";
import { attachAdminSession, requireAdminSession, requireCsrfToken, rateLimitMiddleware, clientIp, sessionCookieOptions, adminApiErrorHandler } from "./adminMiddleware.js";

const router = express.Router();
router.use(attachAdminSession);

function parseOperationId(body = {}) {
  const value = body?.operationId;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(value)) {
    throw new AdminServiceError("A valid operationId (16-80 url-safe characters) is required.", { status: 400, code: "invalid_operation_id" });
  }
  return value;
}

function newOperationId() {
  return randomUUID();
}

/**
 * Login/logout auditing must never block or break authentication itself: the
 * write is awaited with a hard 2s bound and failures only hit the server log.
 */
async function auditAuthEvent(config) {
  await Promise.race([
    runAuditedAction({ ...config, execute: async () => ({ ok: true, auditSummary: { channel: "web" } }) }).catch(() => {}),
    new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); timer.unref?.(); }),
  ]);
}

const requireBody = () => express.json({ limit: "128kb" });

// ── Authentication ───────────────────────────────────────────────────────────
router.post("/auth/request-code", rateLimitMiddleware({ limit: 5 }), requireBody(), async (req, res, next) => {
  try {
    const telegramId = String(req.body?.telegramId ?? "");
    if (!/^[1-9]\d{0,19}$/.test(telegramId)) throw new AdminServiceError("Enter the numeric Telegram ID of an allowlisted admin.", { status: 400, code: "invalid_user_id" });
    const { code, expiresInSeconds } = await issueAdminLoginCode(telegramId);
    const sent = await sendLoginCodeViaBot(telegramId, code, expiresInSeconds);
    res.json({ ok: true, delivered: Boolean(sent), expiresInSeconds });
  } catch (error) { next(error); }
});

async function sendLoginCodeViaBot(telegramId, code, expiresInSeconds) {
  const bot = botInstance.bot;
  if (!bot?.sendMessage) return false;
  try {
    await bot.sendMessage(String(telegramId),
      `🔐 <b>SWIFT Admin sign-in</b>\n\nCode:\n<code>${code}</code>\n\nValid for ${Math.floor(expiresInSeconds / 60)} minutes. If you did not request it, ignore this message.`,
      { parse_mode: "HTML" });
    return true;
  } catch {
    return false;
  }
}

router.post("/auth/verify", rateLimitMiddleware({ limit: 10 }), requireBody(), async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? "");
    const actorTelegramId = await consumeAdminLoginCode(code);
    if (!actorTelegramId) throw new AdminServiceError("The sign-in code is invalid, expired, or already used.", { status: 401, code: "invalid_login_code" });
    const { token, session, ttlSeconds } = await createAdminSession(actorTelegramId);
    await auditAuthEvent({
      actorTelegramId,
      operationId: `LOGIN-${randomUUID()}`,
      action: "ADMIN_LOGIN",
      targetType: "session",
      targetId: "web",
      ipAddress: clientIp(req),
      metadata: { channel: "web" },
    });
    res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(ttlSeconds));
    res.json({ ok: true, actorTelegramId: session.actorTelegramId, csrfToken: session.csrfToken, expiresInSeconds: ttlSeconds });
  } catch (error) { next(error); }
});

router.post("/auth/logout", requireBody(), (req, res, next) => {
  (async () => {
    const token = req.adminSessionToken;
    const actorId = req.adminActorId;
    if (token) await deleteAdminSession(token).catch(() => {});
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
    if (actorId) {
      await auditAuthEvent({
        actorTelegramId: actorId,
        operationId: `LOGOUT-${randomUUID()}`,
        action: "ADMIN_LOGOUT",
        targetType: "session",
        targetId: "web",
        ipAddress: clientIp(req),
        metadata: { channel: "web" },
      });
    }
    res.json({ ok: true });
  })().catch(next);
});

router.get("/auth/session", (req, res) => {
  if (req.adminSessionError) return res.status(503).json({ ok: false, error: "session_store_unavailable" });
  if (!req.adminSession) return res.status(200).json({ ok: true, authenticated: false });
  res.json({
    ok: true,
    authenticated: true,
    actorTelegramId: req.adminSession.actorTelegramId,
    csrfToken: req.adminSession.csrfToken,
    expiresAt: req.adminSession.expiresAt,
  });
});

// ── Everything below requires an admin session + CSRF for mutations ─────────
router.use(requireAdminSession);
router.use(requireCsrfToken);
router.use(rateLimitMiddleware({ limit: 300 }));

// Dashboard
router.get("/dashboard", async (req, res, next) => {
  try { res.json({ ok: true, data: await getDashboardMetrics({ actorId: req.adminActorId }) }); }
  catch (error) { next(error); }
});

// Users
router.get("/users", async (req, res, next) => {
  try {
    const data = await listUsers({
      actorId: req.adminActorId,
      query: {
        search: req.query.search,
        activity: req.query.activity,
        paying: req.query.paying,
        blocked: req.query.blocked,
        sort: req.query.sort,
        page: req.query.page,
        pageSize: req.query.pageSize,
      },
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.get("/users/:telegramId", async (req, res, next) => {
  try { res.json({ ok: true, data: await getUserDetail({ actorId: req.adminActorId, telegramId: req.params.telegramId }) }); }
  catch (error) { next(error); }
});

router.post("/users/:telegramId/balance", requireBody(), async (req, res, next) => {
  try {
    const result = await changeUserBalance({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      telegramId: req.params.telegramId,
      amount: req.body.amount,
      direction: req.body.direction,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/users/:telegramId/block", requireBody(), async (req, res, next) => {
  try {
    const result = await setUserBlocked({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      telegramId: req.params.telegramId,
      blocked: true,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/users/:telegramId/unblock", requireBody(), async (req, res, next) => {
  try {
    const result = await setUserBlocked({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      telegramId: req.params.telegramId,
      blocked: false,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.get("/referrals", async (req, res, next) => {
  try { res.json({ ok: true, data: await getReferralOverview({ actorId: req.adminActorId, page: req.query.page, pageSize: req.query.pageSize }) }); }
  catch (error) { next(error); }
});

// VPNs
router.get("/vpns", async (req, res, next) => {
  try {
    const data = await listVpns({
      actorId: req.adminActorId,
      query: { search: req.query.search, status: req.query.status, sort: req.query.sort, page: req.query.page, pageSize: req.query.pageSize },
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.get("/vpns/:username", async (req, res, next) => {
  try { res.json({ ok: true, data: await getVpnDetail({ actorId: req.adminActorId, username: req.params.username }) }); }
  catch (error) { next(error); }
});

router.post("/vpns/:username/actions", requireBody(), async (req, res, next) => {
  try {
    const result = await performVpnAction({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      username: req.params.username,
      action: req.body.action,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

// Payments
router.get("/payments", async (req, res, next) => {
  try {
    const data = await listPayments({
      actorId: req.adminActorId,
      query: { status: req.query.status, search: req.query.search, provider: req.query.provider, page: req.query.page, pageSize: req.query.pageSize },
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.get("/payments/:key", async (req, res, next) => {
  try { res.json({ ok: true, data: await getPaymentDetail({ actorId: req.adminActorId, key: req.params.key }) }); }
  catch (error) { next(error); }
});

router.post("/payments/:key/retry", requireBody(), async (req, res, next) => {
  try {
    const result = await retryPayment({ actorId: req.adminActorId, operationId: parseOperationId(req.body), key: req.params.key, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/payments/:key/recovery-required", requireBody(), async (req, res, next) => {
  try {
    const result = await markPaymentRecoveryRequired({ actorId: req.adminActorId, operationId: parseOperationId(req.body), key: req.params.key, reason: req.body.reason, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/payments/:key/resolve", requireBody(), async (req, res, next) => {
  try {
    const result = await resolvePaymentRecovery({ actorId: req.adminActorId, operationId: parseOperationId(req.body), key: req.params.key, reason: req.body.reason, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/payments/bank/:paymentId/confirm", requireBody(), async (req, res, next) => {
  try {
    const result = await confirmBankInvoice({ actorId: req.adminActorId, operationId: parseOperationId(req.body), paymentId: req.params.paymentId, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/payments/bank/:paymentId/reject", requireBody(), async (req, res, next) => {
  try {
    const result = await rejectBankInvoice({ actorId: req.adminActorId, operationId: parseOperationId(req.body), paymentId: req.params.paymentId, reason: req.body.reason, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

// Recovery
router.get("/recovery", async (req, res, next) => {
  try { res.json({ ok: true, data: await getRecoveryQueue({ actorId: req.adminActorId, page: req.query.page, pageSize: req.query.pageSize }) }); }
  catch (error) { next(error); }
});

router.post("/recovery/retry-safe", requireBody(), async (req, res, next) => {
  try {
    const result = await retrySafeRecoveryItems({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      keys: Array.isArray(req.body.keys) ? req.body.keys : undefined,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

// Products
router.get("/products", async (req, res, next) => {
  try { res.json({ ok: true, data: await listProducts({ actorId: req.adminActorId }) }); }
  catch (error) { next(error); }
});

router.post("/products", requireBody(), async (req, res, next) => {
  try {
    const result = await createProduct({ actorId: req.adminActorId, operationId: parseOperationId(req.body), input: req.body, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.patch("/products/:productId", requireBody(), async (req, res, next) => {
  try {
    const result = await updateProduct({ actorId: req.adminActorId, operationId: parseOperationId(req.body), productId: req.params.productId, input: req.body, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/products/:productId/duplicate", requireBody(), async (req, res, next) => {
  try {
    const result = await duplicateProduct({ actorId: req.adminActorId, operationId: parseOperationId(req.body), productId: req.params.productId, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/products/reorder", requireBody(), async (req, res, next) => {
  try {
    const result = await reorderProducts({ actorId: req.adminActorId, operationId: parseOperationId(req.body), productIds: req.body.productIds, ipAddress: clientIp(req) });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

// Broadcast
router.post("/broadcast/preview", requireBody(), async (req, res, next) => {
  try { res.json({ ok: true, data: await previewBroadcast({ actorId: req.adminActorId, message: req.body.message, buttons: req.body.buttons }) }); }
  catch (error) { next(error); }
});

router.post("/broadcast", requireBody(), async (req, res, next) => {
  try {
    const result = await createBroadcast({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      message: req.body.message,
      audience: req.body.audience,
      customTelegramIds: req.body.customTelegramIds,
      buttons: req.body.buttons,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.get("/broadcast/status/:operationId", async (req, res, next) => {
  try { res.json({ ok: true, data: await getBroadcastStatus({ actorId: req.adminActorId, operationId: req.params.operationId }) }); }
  catch (error) { next(error); }
});

router.post("/broadcast/cancel/:operationId", requireBody(), async (req, res, next) => {
  try { res.json({ ok: true, data: await requestBroadcastCancel({ actorId: req.adminActorId, operationId: req.params.operationId, ipAddress: clientIp(req) }) }); }
  catch (error) { next(error); }
});

router.get("/broadcasts", async (req, res, next) => {
  try { res.json({ ok: true, data: await listBroadcasts({ actorId: req.adminActorId, page: req.query.page, pageSize: req.query.pageSize }) }); }
  catch (error) { next(error); }
});

// Analytics
router.get("/analytics", async (req, res, next) => {
  try { res.json({ ok: true, data: await getAnalytics({ actorId: req.adminActorId, granularity: req.query.granularity }) }); }
  catch (error) { next(error); }
});

// Audit log
router.get("/audit", async (req, res, next) => {
  try {
    const data = await listAuditLogs({
      page: req.query.page,
      pageSize: req.query.pageSize,
      action: req.query.action,
      actorTelegramId: req.query.actor,
      targetId: req.query.target,
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

// System health
router.get("/system/health", async (req, res, next) => {
  try { res.json({ ok: true, data: await getSystemHealth({ actorId: req.adminActorId, fresh: req.query.fresh === "1" }) }); }
  catch (error) { next(error); }
});

// Convenience endpoint used by the frontend to mint fresh idempotency keys.
router.get("/operations/new-id", (_req, res) => res.json({ ok: true, operationId: newOperationId() }));

router.use(adminApiErrorHandler);

export default router;
