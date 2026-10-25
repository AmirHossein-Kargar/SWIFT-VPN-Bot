import { randomUUID } from "node:crypto";
import express from "express";
import { ADMIN_SESSION_COOKIE, issueAdminLoginCode, consumeAdminLoginCode, createAdminSession, deleteAdminSession } from "../services/admin/auth.js";
import { AdminServiceError, assertAdminUser } from "../services/admin/authorization.js";
import { runAuditedAction } from "../services/admin/audit.js";
import { getDashboardMetrics } from "../services/admin/dashboard.js";
import { listUsers, getUserDetail, changeUserBalance, setUserBlocked, getReferralOverview, resetTestServiceEligibility } from "../services/admin/users.js";
import { listVpns, getVpnDetail, performVpnAction, listRemoteClients } from "../services/admin/vpns.js";
import { listProducts, createProduct, updateProduct, duplicateProduct, reorderProducts } from "../services/admin/products.js";
import { releaseCreationUnknownLock } from "../services/admin/creationUnknown.js";
import { listPayments, getPaymentDetail, retryPayment, markPaymentRecoveryRequired, resolvePaymentRecovery, confirmBankInvoice, rejectBankInvoice } from "../services/admin/payments.js";
import { previewPaymentDeletion, deletePayments } from "../services/admin/paymentDeletion.js";
import { getRecoveryQueue, retrySafeRecoveryItems } from "../services/admin/recovery.js";
import {
  getCustodyOverview,
  getCustodyAssets,
  getCustodyConversions,
  previewCustodyConversion,
  executeCustodyConversion,
  getCustodyPayouts,
  validateCustodyPayoutAddress,
  estimateCustodyPayoutFee,
  createCustodyPayout,
  verifyCustodyPayout,
  getCustodyTransactions,
  reconcileNowPaymentsRecords,
} from "../services/admin/custody.js";
import { previewBroadcast, createBroadcast, getBroadcastStatus, requestBroadcastCancel, listBroadcasts } from "../services/admin/broadcast.js";
import { getAnalytics } from "../services/admin/analytics.js";
import { getAnalyticsReport, reportToCsv } from "../services/admin/analyticsReport.js";
import { getSystemHealth } from "../services/admin/monitoring.js";
import { listAuditLogs } from "../services/admin/audit.js";
import { listAdmins, addAdmin, removeAdmin } from "../services/admin/adminRegistry.js";
import { getUserProfilePhoto } from "../services/admin/userPhoto.js";
import { sendUserMessage } from "../services/admin/userMessaging.js";
import { getSettingsOverview } from "../services/admin/settings.js";
import { listSupportTickets, getSupportTicket, getSupportTicketUpdates, getSupportTicketHistory, replyToSupportTicket, setSupportTicketStatus } from "../services/admin/tickets.js";
import { getMessageAttachment, toAdminError } from "../services/support/tickets.js";
import { streamAttachment } from "../services/support/attachments.js";
import { default as botInstance } from "../config/botInstance.js";
import { attachAdminSession, requireAdminSession, requireCsrfToken, requireSameOrigin, adminApiHeaders, rateLimitMiddleware, clientIp, sessionCookieOptions, clearSessionCookieOptions, LEGACY_SESSION_COOKIE_PATH, NEXT_PANEL_SESSION_COOKIE_PATH, RETIRED_PANEL_COOKIE_PATH, adminApiErrorHandler } from "./adminMiddleware.js";
import { runMockTests, listMockRuns, getMockRun } from "../services/mockTests/runner.js";

const router = express.Router();
router.use(adminApiHeaders);
router.use(requireSameOrigin);
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
    const rawId = req.body?.telegramId;
    // Only a string or number: arrays/objects must not be coerced into an ID.
    const telegramId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    if (!/^[1-9]\d{0,19}$/.test(telegramId)) throw new AdminServiceError("Enter the numeric Telegram ID of an allowlisted admin.", { status: 400, code: "invalid_user_id" });
    // Same response whether or not the ID is an admin (or is rate limited), so
    // this endpoint cannot be used to discover which Telegram IDs are admins.
    // Delivery is not awaited so response time does not reveal it either.
    let expiresInSeconds = 300;
    try {
      const issued = await issueAdminLoginCode(telegramId);
      expiresInSeconds = issued.expiresInSeconds;
      sendLoginCodeViaBot(telegramId, issued.code, issued.expiresInSeconds).catch(() => {});
    } catch (error) {
      if (!["FORBIDDEN", "LOGIN_CODE_RATE_LIMITED"].includes(error?.code)) throw error;
    }
    res.json({ ok: true, expiresInSeconds });
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
    // Session rotation: a session the browser already carried (possibly
    // planted or stale) is invalidated server-side before a new one is issued.
    if (req.adminSessionToken) await deleteAdminSession(req.adminSessionToken).catch(() => {});
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
    // Issued twice, at two disjoint, narrow paths: /api/admin (both panels'
    // own fetches) and /panel (so the Next.js admin panel can verify
    // the session server-side on its own page requests — see
    // NEXT_PANEL_SESSION_COOKIE_PATH for why one cookie cannot cover both).
    res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(ttlSeconds));
    res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(ttlSeconds, NEXT_PANEL_SESSION_COOKIE_PATH));
    res.clearCookie(ADMIN_SESSION_COOKIE, clearSessionCookieOptions(LEGACY_SESSION_COOKIE_PATH));
    res.clearCookie(ADMIN_SESSION_COOKIE, clearSessionCookieOptions(RETIRED_PANEL_COOKIE_PATH));
    res.json({ ok: true, actorTelegramId: session.actorTelegramId, csrfToken: session.csrfToken, expiresInSeconds: ttlSeconds });
  } catch (error) { next(error); }
});

router.post("/auth/logout", requireBody(), (req, res, next) => {
  (async () => {
    const token = req.adminSessionToken;
    const actorId = req.adminActorId;
    if (token) await deleteAdminSession(token).catch(() => {});
    res.clearCookie(ADMIN_SESSION_COOKIE, clearSessionCookieOptions());
    res.clearCookie(ADMIN_SESSION_COOKIE, clearSessionCookieOptions(NEXT_PANEL_SESSION_COOKIE_PATH));
    res.clearCookie(ADMIN_SESSION_COOKIE, clearSessionCookieOptions(LEGACY_SESSION_COOKIE_PATH));
    res.clearCookie(ADMIN_SESSION_COOKIE, clearSessionCookieOptions(RETIRED_PANEL_COOKIE_PATH));
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
router.use(rateLimitMiddleware({ limit: 300, scope: "admin-api" }));
// Mutations are rarer and riskier than reads: a much lower per-admin ceiling.
router.use(rateLimitMiddleware({ limit: 60, scope: "admin-mutations", methods: ["POST", "PUT", "PATCH", "DELETE"] }));

// Admin management (owner-only mutations, audited; owner is resolved from env)
router.get("/admins", async (req, res, next) => {
  try { res.json({ ok: true, data: await listAdmins({ actorId: req.adminActorId }) }); }
  catch (error) { next(error); }
});

router.post("/admins", requireBody(), async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await addAdmin({
        actorId: req.adminActorId,
        operationId: parseOperationId(req.body),
        telegramId: req.body?.telegramId,
        displayName: req.body?.displayName,
        ipAddress: clientIp(req),
      }),
    });
  } catch (error) { next(error); }
});

router.delete("/admins/:telegramId", requireBody(), async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await removeAdmin({
        actorId: req.adminActorId,
        operationId: parseOperationId(req.body),
        telegramId: req.params.telegramId,
        ipAddress: clientIp(req),
      }),
    });
  } catch (error) { next(error); }
});

// Mock tests (isolated harness; gated server-side by MOCK_TESTS_ENABLED)
router.get("/mock-tests", async (req, res, next) => {
  try { res.json({ ok: true, data: await listMockRuns({ actorId: req.adminActorId, limit: req.query.limit }) }); }
  catch (error) { next(error); }
});

router.get("/mock-tests/:runId", async (req, res, next) => {
  try { res.json({ ok: true, data: await getMockRun({ actorId: req.adminActorId, runId: req.params.runId }) }); }
  catch (error) { next(error); }
});

router.post("/mock-tests/run", rateLimitMiddleware({ limit: 6 }), requireBody(), async (req, res, next) => {
  try {
    const requested = req.body?.scenarios;
    const scenarios = requested === undefined || requested === "all" ? "all" : requested;
    res.json({ ok: true, data: await runMockTests({ actorId: req.adminActorId, trigger: "web", scenarios }) });
  } catch (error) { next(error); }
});

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

router.get("/users/:telegramId/photo", async (req, res, next) => {
  try {
    const photo = await getUserProfilePhoto({ actorId: req.adminActorId, telegramId: req.params.telegramId, ifNoneMatch: req.get("if-none-match") });
    if (photo.status === "ok" || photo.status === "not_modified") {
      // private: this is a user's personal image behind admin auth, never for shared caches.
      res.set({ "Cache-Control": "private, max-age=3600", ETag: photo.etag, "X-Content-Type-Options": "nosniff" });
      if (photo.status === "not_modified") return res.status(304).end();
      res.set("Content-Type", photo.contentType);
      return res.status(200).send(photo.body);
    }
    res.set("Cache-Control", "private, max-age=300");
    return res.status(photo.status === "none" ? 404 : 502).json({ ok: false, error: photo.status === "none" ? "no_photo" : "photo_unavailable" });
  } catch (error) { next(error); }
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

router.post("/users/:telegramId/test-eligibility", requireBody(), async (req, res, next) => {
  try {
    const result = await resetTestServiceEligibility({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      telegramId: req.params.telegramId,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/users/:telegramId/message", rateLimitMiddleware({ limit: 20 }), requireBody(), async (req, res, next) => {
  try {
    const result = await sendUserMessage({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      telegramId: req.params.telegramId,
      message: req.body.message,
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

router.get("/vpns-remote/clients", async (req, res, next) => {
  try { res.json({ ok: true, data: await listRemoteClients({ actorId: req.adminActorId, limit: req.query.limit }) }); }
  catch (error) { next(error); }
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
      days: req.body.days,
      gig: req.body.gig,
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

router.post("/payments/delete-preview", requireBody(), async (req, res, next) => {
  try { res.json({ ok: true, data: await previewPaymentDeletion({ actorId: req.adminActorId, keys: req.body?.keys }) }); }
  catch (error) { next(error); }
});

router.post("/payments/delete", requireBody(), async (req, res, next) => {
  try {
    const result = await deletePayments({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      keys: req.body?.keys,
      confirmCount: req.body?.confirmCount,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
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

router.post("/payments/:key/release-creation-lock", requireBody(), async (req, res, next) => {
  try {
    const result = await releaseCreationUnknownLock({ actorId: req.adminActorId, operationId: parseOperationId(req.body), key: req.params.key, reason: req.body.reason, acceptUnverified: req.body.acceptUnverified === true, ipAddress: clientIp(req) });
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

// NOWPayments & Custody
router.get("/custody/overview", async (req, res, next) => {
  try { res.json({ ok: true, data: await getCustodyOverview({ actorId: req.adminActorId }) }); }
  catch (error) { next(error); }
});

router.get("/custody/assets", async (req, res, next) => {
  try { res.json({ ok: true, data: await getCustodyAssets({ actorId: req.adminActorId, query: req.query }) }); }
  catch (error) { next(error); }
});

router.get("/custody/conversions", async (req, res, next) => {
  try { res.json({ ok: true, data: await getCustodyConversions({ actorId: req.adminActorId, query: req.query }) }); }
  catch (error) { next(error); }
});

router.post("/custody/conversions/preview", requireBody(), async (req, res, next) => {
  try {
    const data = await previewCustodyConversion({
      actorId: req.adminActorId,
      fromCurrency: req.body.fromCurrency,
      toCurrency: req.body.toCurrency,
      amount: req.body.amount,
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.post("/custody/conversions", requireBody(), async (req, res, next) => {
  try {
    const data = await executeCustodyConversion({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      fromCurrency: req.body.fromCurrency,
      toCurrency: req.body.toCurrency,
      amount: req.body.amount,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.get("/custody/payouts", async (req, res, next) => {
  try { res.json({ ok: true, data: await getCustodyPayouts({ actorId: req.adminActorId, query: req.query }) }); }
  catch (error) { next(error); }
});

router.post("/custody/payouts/validate-address", requireBody(), async (req, res, next) => {
  try {
    const data = await validateCustodyPayoutAddress({
      actorId: req.adminActorId,
      currency: req.body.currency,
      address: req.body.address,
      extraId: req.body.extraId,
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.get("/custody/payouts/fee", async (req, res, next) => {
  try {
    const data = await estimateCustodyPayoutFee({
      actorId: req.adminActorId,
      currency: req.query.currency,
      amount: req.query.amount,
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.post("/custody/payouts", requireBody(), async (req, res, next) => {
  try {
    const data = await createCustodyPayout({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      currency: req.body.currency,
      address: req.body.address,
      amount: req.body.amount,
      extraId: req.body.extraId,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.post("/custody/payouts/:batchId/verify", requireBody(), async (req, res, next) => {
  try {
    const data = await verifyCustodyPayout({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      batchWithdrawalId: req.params.batchId,
      verificationCode: req.body.verificationCode,
      reason: req.body.reason,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

router.get("/custody/transactions", async (req, res, next) => {
  try { res.json({ ok: true, data: await getCustodyTransactions({ actorId: req.adminActorId, query: req.query }) }); }
  catch (error) { next(error); }
});

router.post("/custody/reconcile", requireBody(), async (req, res, next) => {
  try {
    const data = await reconcileNowPaymentsRecords({
      actorId: req.adminActorId,
      orderId: req.body?.orderId || null,
      limit: req.body?.limit || 20,
    });
    res.json({ ok: true, data });
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
router.get("/analytics/report", async (req, res, next) => {
  try {
    const data = await getAnalyticsReport({ actorId: req.adminActorId, query: req.query, refresh: req.query.refresh === "1" });
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

// CSV export: admin session + CSRF-free GET, but strictly rate limited and audited.
router.get("/analytics/export.csv", rateLimitMiddleware({ limit: 10 }), async (req, res, next) => {
  try {
    // A cross-site page must not be able to trigger an export (and its audit record).
    if (req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ ok: false, error: "origin_not_allowed" });
    const data = await getAnalyticsReport({ actorId: req.adminActorId, query: req.query });
    await runAuditedAction({
      actorTelegramId: req.adminActorId,
      operationId: newOperationId().replace(/-/g, ""),
      action: "ANALYTICS_EXPORTED",
      targetType: "analytics",
      targetId: String(req.query.range || "30d").slice(0, 20),
      ipAddress: clientIp(req),
      metadata: { range: data.range.key, from: data.range.from, to: data.range.to },
      execute: async () => ({ ok: true, auditSummary: { rows: data.kpis.length } }),
    });
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="swift-analytics-${data.range.key}.csv"`);
    res.send(reportToCsv(data));
  } catch (error) { next(error); }
});

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

// Support tickets (shared model with the Telegram bot; see services/support)
router.get("/tickets", async (req, res, next) => {
  try {
    res.json({ ok: true, data: await listSupportTickets({
      actorId: req.adminActorId,
      status: req.query.status,
      query: req.query.q,
      unreadOnly: req.query.unread,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }) });
  } catch (error) { next(error); }
});

router.get("/tickets/attachments/:messageId", async (req, res, next) => {
  try {
    assertAdminUser(req.adminActorId);
    const attachment = await getMessageAttachment({ messageId: req.params.messageId }).catch((error) => { throw toAdminError(error); });
    await streamAttachment({ bot: botInstance.bot, attachment, res }).catch((error) => { throw toAdminError(error); });
  } catch (error) { next(error); }
});

router.get("/tickets/:ticketId/updates", async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getSupportTicketUpdates({ actorId: req.adminActorId, ticketId: req.params.ticketId, afterId: req.query.after, markRead: req.query.markRead }) });
  } catch (error) { next(error); }
});

router.get("/tickets/:ticketId/messages", async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getSupportTicketHistory({ actorId: req.adminActorId, ticketId: req.params.ticketId, beforeId: req.query.before, limit: req.query.limit }) });
  } catch (error) { next(error); }
});

router.get("/tickets/:ticketId", async (req, res, next) => {
  try { res.json({ ok: true, data: await getSupportTicket({ actorId: req.adminActorId, ticketId: req.params.ticketId, limit: req.query.limit }) }); }
  catch (error) { next(error); }
});

router.post("/tickets/:ticketId/reply", rateLimitMiddleware({ limit: 30 }), requireBody(), async (req, res, next) => {
  try {
    const result = await replyToSupportTicket({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      ticketId: req.params.ticketId,
      text: req.body.text,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

router.post("/tickets/:ticketId/status", rateLimitMiddleware({ limit: 30 }), requireBody(), async (req, res, next) => {
  try {
    const result = await setSupportTicketStatus({
      actorId: req.adminActorId,
      operationId: parseOperationId(req.body),
      ticketId: req.params.ticketId,
      status: req.body.status,
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
});

// System health
router.get("/system/health", async (req, res, next) => {
  try { res.json({ ok: true, data: await getSystemHealth({ actorId: req.adminActorId, fresh: req.query.fresh === "1" }) }); }
  catch (error) { next(error); }
});

// Settings (read-only diagnostics; no secret or raw environment value leaves the server)
router.get("/settings/overview", (req, res, next) => {
  try { res.json({ ok: true, data: getSettingsOverview({ actorId: req.adminActorId }) }); }
  catch (error) { next(error); }
});

// Convenience endpoint used by the frontend to mint fresh idempotency keys.
router.get("/operations/new-id", (_req, res) => res.json({ ok: true, operationId: newOperationId() }));

router.use(adminApiErrorHandler);

export default router;
