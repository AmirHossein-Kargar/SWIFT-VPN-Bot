/**
 * Express HTTP server
 *
 * Endpoints:
 *   POST /api/hooshpay/webhook   — HooshPay payment notifications
 *   GET  /health                 — liveness probe (always 200 while the process is up)
 *   GET  /ready                  — readiness probe (503 unless MongoDB is connected)
 *
 * HooshPay webhook spec (per https://hooshpay.xyz/developers):
 *   Headers: X-HooshPay-Signature: <hmac_sha256>
 *   Body: {
 *     event: "payment.success",
 *     invoice: "inv_AbC123xyz",    ← field is "invoice", not "uid"
 *     order_id: "ORDER-1402",
 *     status: "paid",
 *     amount: 250000,
 *     payable_amount: 300017,
 *     merchant_credit: 250000,
 *     fee_amount: 50000,
 *     fee_mode: "buyer",
 *     tracking_code: "556677",
 *     paid_at: "2026-06-16T12:05:00"
 *   }
 *
 * Signature verification lives in services/hooshpay/verifySignature.js so the
 * production implementation can be unit-tested directly.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import HooshPayInvoice from "./models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./services/hooshpay/fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./services/hooshpay/verifyLock.js";
import { verifyHooshPaySignature } from "./services/hooshpay/verifySignature.js";

const app = express();

// Behind Railway's edge proxy: trust exactly one hop so req.ip is the real client.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── Max webhook payload: 64 KB (prevents DoS via oversized body) ─────────────
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// ── Body parsing ─────────────────────────────────────────────────────────────
// NOTE: we deliberately let express.json() own the request stream and capture
// the raw bytes via its `verify` hook. A separate `req.on("data")` middleware
// registered *before* express.json() would consume the stream and leave
// `req.body` undefined, silently dropping every webhook.
app.use(
  express.json({
    limit: "64kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf; // retained for audit / debugging
    },
  })
);

// ── Structured logger ────────────────────────────────────────────────────────
function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "webhook", level, message, ...meta })
  );
}

// ── Admin alert (best-effort Telegram message to GROUP_ID) ───────────────────
async function _alertAdmin(message) {
  const groupId = process.env.GROUP_ID;
  if (!groupId) return;
  try {
    const botModule = await import("./config/botInstance.js");
    const bot = botModule.default;
    if (bot?.sendMessage) {
      await bot.sendMessage(groupId, `🚨 <b>HooshPay Alert</b>\n\n${message}`, {
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    log("warn", "Admin alert failed", { error: e.message });
  }
}

// ── Reversal statuses (internal mapping) ─────────────────────────────────────
// Official statuses: pending, paid, expired, cancelled, failed
// The webhook may also send reversal-type events for refunds/chargebacks.
const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback"]);

// ── Webhook rate limiting (dependency-free, in-memory, per client IP) ────────
// Fixed 60-second window. Default 600 requests/minute — high enough that a
// legitimate HooshPay retry burst is never dropped, low enough to stop a
// trivial flood. Set WEBHOOK_RATE_LIMIT_PER_MIN=0 to disable.
const RATE_LIMIT_PER_MIN = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN ?? 600);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map(); // ip -> { count, resetAt }
let rateSweepTimer = null;

function isRateLimited(ip) {
  if (!Number.isFinite(RATE_LIMIT_PER_MIN) || RATE_LIMIT_PER_MIN <= 0) return false;

  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MIN;
}

// Bound memory: drop expired buckets once a minute.
function startRateLimitSweeper() {
  if (rateSweepTimer) return;
  rateSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
      if (now >= bucket.resetAt) rateBuckets.delete(ip);
    }
  }, RATE_WINDOW_MS);
  if (rateSweepTimer.unref) rateSweepTimer.unref();
}

// ── HooshPay Webhook ──────────────────────────────────────────────────────────
app.post("/api/hooshpay/webhook", async (req, res) => {
  const reqId = randomUUID(); // per-request correlation ID

  if (isRateLimited(req.ip)) {
    log("warn", "PAYMENT_CALLBACK_RATE_LIMITED", { reqId, ip: req.ip });
    return res.sendStatus(429);
  }

  // Respond 200 immediately — HooshPay must not retry while we process.
  // Fulfillment is idempotent and crash-safe, so an early 200 is safe: if we
  // die mid-processing the recovery cron re-runs Phase-2.
  res.sendStatus(200);

  try {
    const payload = req.body;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      log("warn", "PAYMENT_CALLBACK_RECEIVED — invalid payload type", { reqId });
      return;
    }

    log("info", "PAYMENT_CALLBACK_RECEIVED", {
      reqId,
      event: payload.event,
      invoice: payload.invoice,
      order_id: payload.order_id,
      status: payload.status,
    });

    // ── 1. HMAC-SHA256 signature validation (MANDATORY) ───────────────
    // The webhook secret MUST be set. If it is missing we reject ALL webhooks
    // — no bypass is permitted. A missing secret means the application is
    // misconfigured and cannot safely process any payment notification.
    const receivedSig = req.headers["x-hooshpay-signature"];
    const webhookSecret = process.env.HOOSHPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      log("error", "HOOSHPAY_WEBHOOK_SECRET is not set — REJECTING webhook (no bypass)", { reqId });
      await _alertAdmin(
        `🚨 <b>خطای امنیتی بحرانی!</b>\n\n` +
        `متغیر <code>HOOSHPAY_WEBHOOK_SECRET</code> تنظیم نشده است.\n` +
        `تمام وب‌هوک‌ها تا زمان تنظیم این متغیر رد می‌شوند.\n` +
        `🔑 Req-ID: <code>${reqId}</code>`
      );
      return;
    }

    if (!receivedSig) {
      log("warn", "PAYMENT_SIGNATURE_INVALID — missing signature header", { reqId });
      await _alertAdmin(
        `⚠️ <b>امضای وب‌هوک نامعتبر</b>\n` +
        `🔑 Req-ID: <code>${reqId}</code>\n` +
        `دلیل: هدر امضا ارسال نشده است`
      );
      return;
    }

    if (!verifyHooshPaySignature(payload, receivedSig, webhookSecret)) {
      log("warn", "PAYMENT_SIGNATURE_INVALID — HMAC mismatch", {
        reqId,
        invoice: payload.invoice,
        order_id: payload.order_id,
      });
      await _alertAdmin(
        `⚠️ <b>امضای وب‌هوک نامعتبر!</b>\n` +
        `🆔 فاکتور: <code>${payload.invoice || "نامشخص"}</code>\n` +
        `📦 سفارش: <code>${payload.order_id || "نامشخص"}</code>\n` +
        `🔑 Req-ID: <code>${reqId}</code>\n\n` +
        `این درخواست رد شد. لطفاً بررسی کنید.`
      );
      return;
    }

    log("info", "PAYMENT_SIGNATURE_VALID", { reqId, invoice: payload.invoice });

    // ── Extract fields using the official webhook schema ───────────────────
    const hooshUid       = payload.invoice || payload.uid; // fallback for backward compat
    const orderId        = payload.order_id;
    const status         = payload.status;
    const paidAmount     = payload.amount;
    const payableAmount  = payload.payable_amount;
    const merchantCredit = payload.merchant_credit;
    const feeAmount      = payload.fee_amount;
    const trackingCode   = payload.tracking_code;

    // ── 2. Find invoice ───────────────────────────────────────────────────
    const invoiceDoc = await HooshPayInvoice.findOne({
      $or: [
        ...(hooshUid ? [{ uid: hooshUid }] : []),
        ...(orderId ? [{ orderId: orderId }] : []),
      ],
    });

    if (!invoiceDoc) {
      log("warn", "Invoice not found", { reqId, hooshUid, orderId });
      return;
    }

    // ── 3. Append to audit log (always, for every delivery) ───────────────
    await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
      $push: { webhookLog: { receivedAt: new Date(), payload } },
    });

    // ── 4. Amount validation ──────────────────────────────────────────────
    // Only credit when the notified amount matches what we recorded. Accept
    // either the invoice amount or the merchant credit (they differ under
    // seller-paid fee modes).
    if (paidAmount !== undefined) {
      const accepted = new Set([Number(invoiceDoc.amount)]);
      if (invoiceDoc.merchantCredit != null) accepted.add(Number(invoiceDoc.merchantCredit));

      if (!accepted.has(Number(paidAmount))) {
        log("warn", "Amount mismatch — rejecting", {
          reqId,
          uid: invoiceDoc.uid,
          expected: [...accepted],
          received: paidAmount,
        });
        await _alertAdmin(
          `⚠️ <b>عدم تطابق مبلغ!</b>\n` +
          `🆔 UID: <code>${invoiceDoc.uid}</code>\n` +
          `💰 مبلغ ثبت‌شده: <code>${invoiceDoc.amount.toLocaleString()}</code> تومان\n` +
          `💰 مبلغ وب‌هوک: <code>${Number(paidAmount).toLocaleString()}</code> تومان\n` +
          `👤 کاربر: <code>${invoiceDoc.userId}</code>\n` +
          `🔑 Req-ID: <code>${reqId}</code>\n\n` +
          `تراکنش رد شد. لطفاً دستی بررسی کنید.`
        );
        return;
      }
    }

    // ── 5. Reversal / refund ──────────────────────────────────────────────
    if (REVERSAL_STATUSES.has(status)) {
      log("warn", "Reversal received — marking invoice and alerting admin", {
        reqId, uid: invoiceDoc.uid, status,
      });

      // Only a paid invoice can be reversed. `paid` is the only legal source
      // state, so guard the transition explicitly.
      if (invoiceDoc.status === "paid") {
        await HooshPayInvoice.findOneAndUpdate(
          { _id: invoiceDoc._id, status: "paid" },
          { $set: { status: "reversed" } }
        );
      }

      await _alertAdmin(
        `⚠️ <b>پرداخت برگشت خورد!</b>\n\n` +
        `🆔 UID: <code>${invoiceDoc.uid}</code>\n` +
        `💰 مبلغ: <code>${invoiceDoc.amount.toLocaleString()}</code> تومان\n` +
        `👤 کاربر: <code>${invoiceDoc.userId}</code>\n` +
        `📌 وضعیت: <code>${status}</code>\n` +
        `🔑 Req-ID: <code>${reqId}</code>\n\n` +
        `لطفاً این پرداخت را دستی بررسی کنید.`
      );
      return;
    }

    // ── 6. Update tracking code and fee info if provided ──────────────────
    if (trackingCode || feeAmount !== undefined || merchantCredit !== undefined) {
      const updateFields = {};
      if (trackingCode) updateFields.trackingCode = trackingCode;
      if (feeAmount !== undefined) updateFields.feeAmount = feeAmount;
      if (merchantCredit !== undefined) updateFields.merchantCredit = merchantCredit;
      if (payableAmount !== undefined) updateFields.payableAmount = payableAmount;
      if (Object.keys(updateFields).length > 0) {
        await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, { $set: updateFields });
      }
    }

    // ── 7. Only proceed on confirmed payment ──────────────────────────────
    const isPaidEvent = status === "paid" || payload.event === "payment.success";

    if (!isPaidEvent) {
      log("info", "Not a payment success event — ignoring", {
        reqId, uid: invoiceDoc.uid, status, event: payload.event,
      });
      return;
    }

    // A refunded/charged-back invoice must never be credited again.
    if (invoiceDoc.status === "reversed") {
      log("warn", "Paid webhook for REVERSED invoice — ignoring", {
        reqId, uid: invoiceDoc.uid,
      });
      await _alertAdmin(
        `⚠️ <b>وب‌هوک پرداخت برای فاکتور برگشت‌خورده</b>\n` +
        `🆔 UID: <code>${invoiceDoc.uid}</code>\n` +
        `این درخواست نادیده گرفته شد. لطفاً دستی بررسی کنید.\n` +
        `🔑 Req-ID: <code>${reqId}</code>`
      );
      return;
    }

    // `expired` / `cancelled` / `failed` → `paid` is permitted here, and only
    // here, because HooshPay has cryptographically confirmed that the customer's
    // money was actually captured. Refusing to credit would take money without
    // delivering value. The transition is logged loudly for reconciliation.
    if (["expired", "cancelled", "failed"].includes(invoiceDoc.status)) {
      log("warn", "Late payment for terminal invoice — crediting (funds confirmed by gateway)", {
        reqId, uid: invoiceDoc.uid, previousStatus: invoiceDoc.status,
      });
    }

    // ── 8. Already fully credited? (duplicate webhook) ─────────────────────
    if (invoiceDoc.fulfilled && invoiceDoc.balanceCredited) {
      log("info", "PAYMENT_DUPLICATE — already credited", {
        reqId, uid: invoiceDoc.uid,
      });
      return;
    }

    // ── 9. In-flight lock (webhook + manual verify race prevention) ───────
    const lockAcquired = await acquireVerifyLock(invoiceDoc.uid);
    if (!lockAcquired) {
      log("info", "Duplicate webhook — already being processed", {
        reqId, uid: invoiceDoc.uid,
      });
      return;
    }

    try {
      let bot = null;
      try {
        const m = await import("./config/botInstance.js");
        bot = m.default;
      } catch { /* bot unavailable on cold webhook path */ }

      log("info", "PAYMENT_CREDIT_STARTED", {
        reqId, uid: invoiceDoc.uid, userId: invoiceDoc.userId, amount: invoiceDoc.amount,
      });

      await fulfillHooshOrder({
        invoice: invoiceDoc,
        bot,
        chatId: invoiceDoc.userId,
        correlationId: reqId,
      });

      log("info", "PAYMENT_CREDITED", {
        reqId, uid: invoiceDoc.uid, userId: invoiceDoc.userId,
      });
    } finally {
      await releaseVerifyLock(invoiceDoc.uid);
    }

  } catch (err) {
    log("error", "Unhandled webhook error", {
      reqId, error: err.message, stack: err.stack,
    });
    await _alertAdmin(
      `❌ <b>خطای وب‌هوک</b>\n` +
      `🔑 Req-ID: <code>${reqId}</code>\n` +
      `خطا: <code>${err.message}</code>`
    );
  }
});

// ── Health check (liveness) ───────────────────────────────────────────────────
// Always 200 while the Node process is alive. Railway restarts on non-200, and
// a transient MongoDB blip must not cause a restart loop — dependency state is
// reported in the body and enforced by /ready instead.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
  });
});

// ── Readiness check (dependencies) ────────────────────────────────────────────
function dependencyStatus() {
  return {
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  };
}

app.get("/ready", (_req, res) => {
  const deps = dependencyStatus();
  const ready = deps.mongo === "connected";
  res.status(ready ? 200 : 503).json({
    ready,
    ts: new Date().toISOString(),
    ...deps,
  });
});

startRateLimitSweeper();

export const PORT = Number(process.env.PORT) || 3000;
export default app;
