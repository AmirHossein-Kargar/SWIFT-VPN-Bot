import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import HooshPayInvoice from "./models/HooshPayInvoice.js";
import { isRedisReady } from "./config/redisClient.js";
import { fulfillHooshOrder } from "./services/hooshpay/fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./services/hooshpay/verifyLock.js";
import { verifyHooshPaySignature } from "./services/hooshpay/verifySignature.js";
import {
  HOOSH_REVERSAL_STATUSES,
  HOOSH_TERMINAL_NONPAYABLE,
  normalizeHooshStatus,
  validateHooshPaidDetails,
} from "./services/hooshpay/paymentValidation.js";
import { recordWebhookOutcome } from "./services/admin/monitoring.js";
import adminRouter from "./web/adminRouter.js";
import storeRouter from "./web/storeRouter.js";
import { serveAdminSpa, notFoundHandler } from "./web/spa.js";
import { nextAdminMiddleware } from "./web/nextAdminMiddleware.js";
import { handleNowPaymentsIpn } from "./services/nowpayments/ipnHandler.js";
import { findTombstone, recordLateEvent } from "./services/payments/invoiceCleanup.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

export const MAX_PAYLOAD_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 10_000;
const rateLimitRaw = process.env.WEBHOOK_RATE_LIMIT_PER_MIN ?? "600";
const RATE_LIMIT_PER_MIN = /^\d+$/.test(rateLimitRaw) ? Number(rateLimitRaw) : 600;
const rateBuckets = new Map();
let httpReady = false;
let telegramReady = false;

app.use(express.json({
  limit: MAX_PAYLOAD_BYTES,
  type: "application/json",
  verify: (req, _res, buffer) => { req.rawBody = buffer; },
}));

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "webhook", level, message, ...meta })
  );
}

function safeErrorFields(error) {
  return {
    errorType: error?.name || "Error",
    code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
  };
}

function sweepExpiredBuckets(now) {
  for (const [bucketIp, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(bucketIp);
  }
}

function isRateLimited(ip) {
  if (RATE_LIMIT_PER_MIN === 0) return false;
  const now = Date.now();
  if (rateBuckets.size > 1024) sweepExpiredBuckets(now);
  const key = typeof ip === "string" && ip ? ip : "unknown";
  const existing = rateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      sweepExpiredBuckets(now);
      if (rateBuckets.size >= MAX_RATE_BUCKETS) return true;
    }
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT_PER_MIN;
}

const VALID_STATUSES = new Set(["pending", "paid", "expired", "cancelled", "failed", "reversed"]);
const REVERSAL_STATUSES = new Set(HOOSH_REVERSAL_STATUSES.map(normalizeHooshStatus));

function webhookAuditPayload(payload) {
  const allowed = [
    "event", "invoice", "uid", "order_id", "status", "amount", "currency",
    "payable_amount", "merchant_credit", "fee_amount", "fee_mode", "fee_percent",
    "tracking_code", "paid_at",
  ];
  const audit = {};
  for (const field of allowed) {
    if (Object.hasOwn(payload, field)) audit[field] = payload[field];
  }
  return audit;
}

async function alertAdmin(message) {
  const groupId = process.env.GROUP_ID;
  if (!groupId) return;
  try {
    const module = await import("./config/botInstance.js");
    await module.default?.sendMessage?.(groupId, `🚨 <b>HooshPay Alert</b>\n\n${message}`, { parse_mode: "HTML" });
  } catch (error) {
    log("warn", "Admin alert failed", safeErrorFields(error));
  }
}

export async function handleHooshWebhook(req, res) {
  const reqId = randomUUID();
  if (!req.is("application/json")) {
    return res.status(415).json({ ok: false, error: "unsupported_media_type", request_id: reqId });
  }
  if (isRateLimited(req.ip)) return res.status(429).json({ ok: false, error: "rate_limited", request_id: reqId });

  const payload = req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ ok: false, error: "invalid_json_object", request_id: reqId });
  }

  const secret = process.env.HOOSHPAY_WEBHOOK_SECRET;
  if (!secret) {
    log("error", "Webhook secret is not configured", { reqId });
    return res.status(503).json({ ok: false, error: "webhook_not_configured", request_id: reqId });
  }
  const signature = req.get("X-HooshPay-Signature");
  if (!verifyHooshPaySignature(payload, signature, secret)) {
    log("warn", "Webhook signature rejected", { reqId });
    return res.status(401).json({ ok: false, error: "invalid_signature", request_id: reqId });
  }

  const uid = payload.invoice ?? payload.uid;
  const orderId = payload.order_id;
  if ((uid != null && (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid))) ||
      (orderId != null && (typeof orderId !== "string" || orderId.length > 128))) {
    return res.status(400).json({ ok: false, error: "invalid_invoice_reference", request_id: reqId });
  }
  if (!uid && !orderId) return res.status(400).json({ ok: false, error: "missing_invoice_reference", request_id: reqId });

  const status = normalizeHooshStatus(payload.status);
  const event = typeof payload.event === "string" ? payload.event.trim().toLowerCase() : "";
  if (!VALID_STATUSES.has(status)) return res.status(422).json({ ok: false, error: "invalid_payment_status", request_id: reqId });
  if (status === "paid" && event !== "payment.success") {
    return res.status(422).json({ ok: false, error: "inconsistent_payment_event", request_id: reqId });
  }
  if (event === "payment.success" && status !== "paid") {
    return res.status(422).json({ ok: false, error: "inconsistent_payment_event", request_id: reqId });
  }

  let invoice;
  try {
    invoice = await HooshPayInvoice.findOne({
      $or: [
        ...(uid ? [{ uid }] : []),
        ...(orderId ? [{ orderId }] : []),
      ],
    });
  } catch (error) {
    log("error", "Invoice lookup failed", { reqId, ...safeErrorFields(error) });
    return res.status(503).json({ ok: false, error: "temporarily_unavailable", request_id: reqId });
  }
  if (!invoice) {
    // A cancelled/failed invoice removed by the 24h cleanup: acknowledge so the
    // provider stops retrying, record the late event, and never credit.
    try {
      const tombstone = await findTombstone({ provider: "hooshpay", orderId, uid });
      if (tombstone) {
        await recordLateEvent({ tombstone, status });
        log("warn", "Webhook for an invoice removed by cleanup; ignored", { reqId, orderId: tombstone.orderId, status });
        if (status === "paid") {
          await alertAdmin(`⚠️ پرداخت دیرهنگام برای فاکتور پاک‌شده دریافت شد. Order: <code>${tombstone.orderId}</code>. بررسی دستی لازم است.`);
        }
        return res.status(200).json({ ok: true, received: true, ignored: "invoice_removed", request_id: reqId });
      }
    } catch (error) {
      log("error", "Tombstone lookup failed", { reqId, ...safeErrorFields(error) });
      return res.status(503).json({ ok: false, error: "temporarily_unavailable", request_id: reqId });
    }
    log("warn", "Signed webhook references an unknown invoice", { reqId, uid, orderId });
    return res.status(404).json({ ok: false, error: "invoice_not_found", request_id: reqId });
  }

  // A provider timeout can leave a durable local order without the returned
  // UID. A correctly signed callback carrying the exact order_id safely binds
  // that remote invoice instead of losing a legitimate payment.
  if (!invoice.uid && uid && orderId === invoice.orderId && ["creating", "creation_unknown"].includes(invoice.creationStatus)) {
    try {
      const bound = await HooshPayInvoice.findOneAndUpdate(
        { _id: invoice._id, uid: null, orderId, creationStatus: { $in: ["creating", "creation_unknown"] } },
        {
          $set: { uid, creationStatus: "created", recoveryStatus: "none", recoveryReason: null },
          $unset: { openCreateKey: 1, creationUnknownAt: 1 },
        },
        { new: true },
      );
      if (bound) invoice = bound;
    } catch (error) {
      log("error", "Timed-out invoice could not be bound to signed callback", { reqId, orderId, ...safeErrorFields(error) });
      return res.status(503).json({ ok: false, error: "temporarily_unavailable", request_id: reqId });
    }
  }

  if ((uid && invoice.uid !== uid) || (orderId && invoice.orderId !== orderId)) {
    return res.status(409).json({ ok: false, error: "invoice_reference_mismatch", request_id: reqId });
  }

  if (status === "paid") {
    if (invoice.status === "reversed") {
      log("error", "Paid webhook received for a reversed invoice", { reqId, uid: invoice.uid });
      await alertAdmin(`⚠️ پرداخت برای فاکتور برگشت‌خورده دریافت شد. UID: <code>${invoice.uid}</code>. بررسی دستی لازم است.`);
      return res.status(409).json({ ok: false, error: "invoice_reversed", request_id: reqId });
    }
    if (HOOSH_TERMINAL_NONPAYABLE.includes(normalizeHooshStatus(invoice.status))) {
      log("warn", "Out-of-order paid webhook rejected for terminal invoice", {
        reqId, uid: invoice.uid, invoiceStatus: invoice.status,
      });
      return res.status(409).json({ ok: false, error: "invoice_not_eligible", request_id: reqId });
    }
    const amountError = validateHooshPaidDetails(invoice, payload, {
      requireUid: true,
      requireOrderId: true,
      requireCurrency: true,
    });
    if (amountError) {
      log("warn", "Signed payment fields failed local invoice validation", { reqId, uid: invoice.uid, reason: amountError });
      return res.status(422).json({ ok: false, error: "payment_details_mismatch", request_id: reqId });
    }
  }

  try {
    const update = { $push: { webhookLog: { $each: [{ receivedAt: new Date(), payload: webhookAuditPayload(payload) }], $slice: -50 } } };
    if (status === "paid" && typeof payload.tracking_code === "string") {
      update.$set = { trackingCode: payload.tracking_code };
    }
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, update);

    if (REVERSAL_STATUSES.has(status)) {
      // A pending reversal can close without reconciliation. If fulfillment has
      // already claimed `paid`, however, wallet credit may be in flight; record
      // a durable manual-reconciliation flag and never race an automatic debit.
      let reversed = await HooshPayInvoice.findOneAndUpdate(
        { _id: invoice._id, status: "pending", fulfilled: false, balanceCredited: false },
        { $set: { status: "reversed", reversedAt: new Date(), recoveryStatus: "none", recoveryReason: null } },
        { new: true }
      );
      if (!reversed) {
        reversed = await HooshPayInvoice.findOneAndUpdate(
          { _id: invoice._id, status: "paid" },
          {
            $set: {
              status: "reversed",
              reversedAt: new Date(),
              recoveryStatus: "required",
              recoveryReason: "provider_reversal_after_payment_claim",
            },
          },
          { new: true }
        );
      }
      log("warn", "Payment reversal recorded; wallet debit is a manual reconciliation", {
        reqId, uid: invoice.uid, status, manualReview: reversed?.recoveryStatus === "required",
      });
      if (reversed?.recoveryStatus === "required") {
        await alertAdmin(`⚠️ برگشت پرداخت HooshPay ثبت شد. UID: <code>${invoice.uid}</code>، کاربر: <code>${invoice.userId}</code>. موجودی به‌صورت خودکار کسر نمی‌شود؛ بررسی دستی لازم است.`);
      }
      return res.status(200).json({ ok: true, received: true, request_id: reqId });
    }

    if (status !== "paid") {
      if (["expired", "cancelled", "failed"].includes(status)) {
        const closed = await HooshPayInvoice.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false, balanceCredited: false },
          { $set: { status } },
          { new: true },
        );
        if (!closed) {
          await HooshPayInvoice.findOneAndUpdate(
            { _id: invoice._id, status: "paid" },
            { $set: { recoveryStatus: "required", recoveryReason: `provider_${status}_after_payment_claim` } },
          );
        }
      }
      return res.status(200).json({ ok: true, received: true, request_id: reqId });
    }

    if (invoice.fulfilled && invoice.balanceCredited) {
      return res.status(200).json({ ok: true, received: true, duplicate: true, request_id: reqId });
    }

    const lock = await acquireVerifyLock(invoice.uid);
    if (!lock.acquired) {
      res.set("Retry-After", "5");
      return res.status(503).json({ ok: false, error: "payment_processing", request_id: reqId });
    }
    try {
      const botModule = await import("./config/botInstance.js");
      const result = await fulfillHooshOrder({
        invoice,
        bot: botModule.default.bot,
        chatId: invoice.userId,
        correlationId: reqId,
        paidAt: payload.paid_at,
      });
      if (result.manualReviewRequired) {
        res.set("Retry-After", "300");
        return res.status(503).json({ ok: false, error: "manual_reconciliation_required", request_id: reqId });
      }
      if (result.reversed || result.notPaid) {
        return res.status(409).json({ ok: false, error: "invoice_not_eligible", request_id: reqId });
      }
      log("info", "Payment fulfillment completed", {
        reqId, uid: invoice.uid, userId: invoice.userId,
        newlyCredited: result.credited, alreadyCredited: result.alreadyCredited,
      });
      recordWebhookOutcome({ ok: true });
      return res.status(200).json({ ok: true, received: true, request_id: reqId });
    } finally {
      await releaseVerifyLock(lock);
    }
  } catch (error) {
    log("error", "Webhook processing failed; gateway retry requested", {
      reqId, uid: invoice.uid, ...safeErrorFields(error),
    });
    recordWebhookOutcome({ ok: false, error: error?.code || error?.name });
    return res.status(503).json({ ok: false, error: "temporarily_unavailable", request_id: reqId });
  }
}

app.post("/api/hooshpay/webhook", handleHooshWebhook);

export async function handleNowPaymentsWebhook(req, res) {
  const reqId = randomUUID();
  if (!req.is("application/json")) {
    return res.status(415).json({ ok: false, error: "unsupported_media_type", request_id: reqId });
  }
  if (isRateLimited(req.ip)) return res.status(429).json({ ok: false, error: "rate_limited", request_id: reqId });
  return handleNowPaymentsIpn(req, res, { requestId: reqId });
}

app.post("/api/nowpayments/ipn", handleNowPaymentsWebhook);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), uptime: Math.floor(process.uptime()) });
});
app.get("/livez", (_req, res) => res.status(200).json({ ok: true }));

function dependencyStatus() {
  return {
    http: httpReady,
    mongo: mongoose.connection.readyState === 1,
    redis: isRedisReady(),
    telegram: telegramReady,
  };
}

app.get("/ready", (_req, res) => {
  const dependencies = dependencyStatus();
  const ready = Object.values(dependencies).every(Boolean);
  res.status(ready ? 200 : 503).json({ ready, dependencies, ts: new Date().toISOString() });
});

// Admin Panel API + web dashboard (mounted after the webhook route so the
// payment webhook path is untouched).
app.use("/api/admin", adminRouter);
app.use("/api/store", storeRouter);
// The in-progress Next.js admin panel (see README for scope); the legacy
// vanilla-JS panel below still serves everything else at /panel.
app.use(nextAdminMiddleware);
app.use(serveAdminSpa);
app.use(notFoundHandler);

app.use((error, _req, res, _next) => {
  const status = error?.type === "entity.too.large" ? 413
    : error?.type === "entity.parse.failed" ? 400
    : error?.status === 415 ? 415
    : 400;
  const errorCode = status === 413 ? "payload_too_large"
    : status === 415 ? "unsupported_media_type"
    : status === 400 && error?.type === "entity.parse.failed" ? "invalid_json"
    : "bad_request";
  res.status(status).json({ ok: false, error: errorCode });
});

export function setRuntimeReadiness({ http, telegram } = {}) {
  if (typeof http === "boolean") httpReady = http;
  if (typeof telegram === "boolean") telegramReady = telegram;
}

export function resetRateLimitsForTests() {
  rateBuckets.clear();
}

function resolvePort(value) {
  if (value == null || String(value).trim() === "") return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  return port;
}

export const PORT = resolvePort(process.env.PORT);
export default app;
