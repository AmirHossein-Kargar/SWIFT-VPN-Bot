import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import HooshPayInvoice from "./models/HooshPayInvoice.js";
import { isRedisReady } from "./config/redisClient.js";
import { fulfillHooshOrder } from "./services/hooshpay/fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./services/hooshpay/verifyLock.js";
import { verifyHooshPaySignature } from "./services/hooshpay/verifySignature.js";

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

function isRateLimited(ip) {
  if (RATE_LIMIT_PER_MIN === 0) return false;
  const now = Date.now();
  const key = typeof ip === "string" && ip ? ip : "unknown";
  const existing = rateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      for (const [bucketIp, bucket] of rateBuckets) {
        if (now >= bucket.resetAt) rateBuckets.delete(bucketIp);
      }
      if (rateBuckets.size >= MAX_RATE_BUCKETS) return true;
    }
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT_PER_MIN;
}

const VALID_STATUSES = new Set(["pending", "paid", "expired", "cancelled", "failed", "reversed", "refunded", "chargedback"]);
const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback"]);
const ALLOWED_CURRENCIES = new Set(["TOMAN", "TOMANS", "IRT"]);

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

function validatePaidPayload(invoice, payload) {
  const integerFields = ["amount", "payable_amount", "merchant_credit", "fee_amount"];
  for (const field of integerFields) {
    if (payload[field] != null && (!Number.isSafeInteger(Number(payload[field])) || Number(payload[field]) < 0)) {
      return `${field} must be a non-negative integer`;
    }
  }
  if (payload.amount == null || Number(payload.amount) !== Number(invoice.amount)) {
    return "amount does not match the locally created invoice";
  }
  if (payload.payable_amount != null && invoice.payableAmount != null && Number(payload.payable_amount) !== Number(invoice.payableAmount)) {
    return "payable_amount does not match the locally created invoice";
  }
  const expectedMerchantCredit = invoice.merchantCredit == null ? Number(invoice.amount) : Number(invoice.merchantCredit);
  if (payload.merchant_credit != null && Number(payload.merchant_credit) !== expectedMerchantCredit) {
    return "merchant_credit does not match the locally created invoice";
  }
  if (payload.fee_amount != null && invoice.feeAmount != null && Number(payload.fee_amount) !== Number(invoice.feeAmount)) {
    return "fee_amount does not match the locally created invoice";
  }
  if (payload.fee_mode != null && String(payload.fee_mode) !== String(invoice.feeMode)) {
    return "fee_mode does not match the locally created invoice";
  }
  if (payload.currency != null && !ALLOWED_CURRENCIES.has(String(payload.currency).trim().toUpperCase())) {
    return "currency is not Toman";
  }
  if (payload.tracking_code != null && (typeof payload.tracking_code !== "string" || payload.tracking_code.length > 128)) {
    return "tracking_code is invalid";
  }
  if (payload.paid_at != null && (typeof payload.paid_at !== "string" || Number.isNaN(new Date(payload.paid_at).getTime()))) {
    return "paid_at is invalid";
  }
  return null;
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

  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
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
    log("warn", "Signed webhook references an unknown invoice", { reqId, uid, orderId });
    return res.status(404).json({ ok: false, error: "invoice_not_found", request_id: reqId });
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
    const amountError = validatePaidPayload(invoice, payload);
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
      await HooshPayInvoice.findOneAndUpdate(
        { _id: invoice._id, status: { $in: ["pending", "paid"] } },
        { $set: { status: "reversed", reversedAt: new Date() } },
        { new: true }
      );
      log("warn", "Payment reversal recorded; wallet debit is a manual reconciliation", {
        reqId, uid: invoice.uid, status,
      });
      await alertAdmin(`⚠️ برگشت پرداخت HooshPay ثبت شد. UID: <code>${invoice.uid}</code>، کاربر: <code>${invoice.userId}</code>. موجودی به‌صورت خودکار کسر نمی‌شود؛ بررسی دستی لازم است.`);
      return res.status(200).json({ ok: true, received: true, request_id: reqId });
    }

    if (status !== "paid") {
      if (["expired", "cancelled", "failed"].includes(status)) {
        await HooshPayInvoice.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false },
          { $set: { status } }
        );
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
      return res.status(200).json({ ok: true, received: true, request_id: reqId });
    } finally {
      await releaseVerifyLock(lock);
    }
  } catch (error) {
    log("error", "Webhook processing failed; gateway retry requested", {
      reqId, uid: invoice.uid, ...safeErrorFields(error),
    });
    return res.status(503).json({ ok: false, error: "temporarily_unavailable", request_id: reqId });
  }
}

app.post("/api/hooshpay/webhook", handleHooshWebhook);

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

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

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
