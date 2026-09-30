/**
 * Express HTTP server
 *
 * Endpoints:
 *  POST /api/hooshpay/webhook    — HooshPay payment notifications
 *  POST /api/nowpayments/webhook — legacy stub
 *  GET  /health                  — liveness probe
 *
 * HooshPay webhook spec (per https://hooshpay.xyz/developers):
 *   Headers: X-HooshPay-Signature: <hmac_sha256>
 *   Body: {
 *     event: "payment.success",
 *     invoice: "inv_AbC123xyz",    ← note: field is "invoice", not "uid"
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
 * Signature verification (per official docs):
 *   1. Parse the JSON payload
 *   2. Sort keys alphabetically (ksort)
 *   3. Re-serialize with compact separators: json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
 *      In Node: JSON.stringify(sortedObj) — but separators must be (",", ":") which is the default
 *   4. HMAC-SHA256 over the re-serialized string
 *   5. timingSafeEqual against received signature
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import crypto from "crypto";
import HooshPayInvoice from "./models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./services/hooshpay/fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./services/hooshpay/verifyLock.js";

const app = express();

// ── Max webhook payload: 64 KB (prevents DoS via oversized body) ─────────────
const MAX_PAYLOAD_BYTES = 64 * 1024;

// ── Raw body capture — must precede express.json() ───────────────────────────
// We still capture rawBody for logging/audit purposes, but signature verification
// uses the ksort'd re-serialized JSON per the official HooshPay documentation.
app.use((req, res, next) => {
  const chunks = [];
  let totalBytes = 0;

  req.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      res.status(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});

app.use(express.json({ limit: "64kb" }));

// ── Structured logger ─────────────────────────────────────────────────────────
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

/**
 * HooshPay signature verification per official documentation.
 *
 * The signature is computed over the JSON payload with keys sorted
 * alphabetically (ksort) and re-serialized with compact separators.
 *
 * @param {object} payload  - parsed JSON body
 * @param {string} signature - hex HMAC-SHA256 from X-HooshPay-Signature header
 * @param {string} secret   - webhook secret
 * @returns {boolean}
 */
function verifyHooshPaySignature(payload, signature, secret) {
  // Sort keys alphabetically (mirrors PHP ksort + Python sort_keys=True)
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj = {};
  for (const k of sortedKeys) {
    sortedObj[k] = payload[k];
  }

  // Re-serialize with compact separators (no spaces), no ASCII escaping
  // This matches: json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
  const body = JSON.stringify(sortedObj);

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  let valid = false;
  try {
    // timingSafeEqual requires equal-length buffers
    valid = crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch {
    valid = false;
  }
  return valid;
}

// ── Reversal statuses (internal mapping) ─────────────────────────────────────
// Official statuses: pending, paid, expired, cancelled, failed
// Webhook may also send reversal-type events for refunds
const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback"]);

// ── HooshPay Webhook ──────────────────────────────────────────────────────────
app.post("/api/hooshpay/webhook", async (req, res) => {
  // Respond 200 immediately — HooshPay should not retry while we process
  res.sendStatus(200);

  const reqId = randomUUID();   // per-request correlation ID

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

    // ── 1. HMAC-SHA256 signature validation ───────────────────────────────
    const receivedSig = req.headers["x-hooshpay-signature"];
    const webhookSecret = process.env.HOOSHPAY_WEBHOOK_SECRET;

    if (webhookSecret) {
      if (!receivedSig) {
        log("warn", "PAYMENT_SIGNATURE_INVALID — missing signature header", { reqId });
        await _alertAdmin(
          `⚠️ <b>امضای وب‌هوک نامعتبر</b>\n` +
          `🔑 Req-ID: <code>${reqId}</code>\n` +
          `دلیل: هدر امضا ارسال نشده است`
        );
        return;
      }

      const valid = verifyHooshPaySignature(payload, receivedSig, webhookSecret);

      if (!valid) {
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
    } else {
      log("warn", "HOOSHPAY_WEBHOOK_SECRET not set — skipping validation (unsafe)", { reqId });
    }

    // ── Extract fields using official webhook schema ───────────────────────
    // The field is "invoice" (not "uid") per the official docs
    const hooshUid    = payload.invoice || payload.uid;  // fallback to uid for backward compat
    const orderId     = payload.order_id;
    const status      = payload.status;
    const paidAmount  = payload.amount;
    const payableAmount = payload.payable_amount;
    const merchantCredit = payload.merchant_credit;
    const feeAmount   = payload.fee_amount;
    const trackingCode = payload.tracking_code;
    const paidAtStr   = payload.paid_at;

    // ── 2. Find invoice ───────────────────────────────────────────────────
    const invoiceDoc = await HooshPayInvoice.findOne({
      $or: [
        ...(hooshUid ? [{ uid: hooshUid }] : []),
        ...(orderId  ? [{ orderId: orderId }] : []),
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
    // Verify the webhook amount matches our stored invoice amount
    if (paidAmount !== undefined && Number(paidAmount) !== invoiceDoc.amount) {
      log("warn", "Amount mismatch — rejecting", {
        reqId,
        uid: invoiceDoc.uid,
        expected: invoiceDoc.amount,
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

    // ── 5. Reversal / refund ──────────────────────────────────────────────
    if (REVERSAL_STATUSES.has(status)) {
      log("warn", "Reversal received — marking invoice and alerting admin", {
        reqId, uid: invoiceDoc.uid, status,
      });

      // Only reverse if currently paid (prevent illegal transitions)
      if (invoiceDoc.status === "paid") {
        await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
          $set: { status: "reversed" },
        });
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
    // Official webhook event: "payment.success" with status: "paid"
    const isPaidEvent = status === "paid" || payload.event === "payment.success";

    if (!isPaidEvent) {
      log("info", "Not a payment success event — ignoring", {
        reqId, uid: invoiceDoc.uid, status, event: payload.event,
      });
      return;
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

// ── Legacy NowPayments stub ───────────────────────────────────────────────────
app.post("/api/nowpayments/webhook", (req, res) => {
  log("info", "NowPayments webhook received (legacy — no action)", { body: req.body });
  res.sendStatus(200);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), pid: process.pid });
});

export const PORT = process.env.PORT || 3000;
export default app;