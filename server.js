/**
 * Express HTTP server
 *
 * Endpoints:
 *  POST /api/hooshpay/webhook   — HooshPay payment notifications (primary path)
 *  POST /api/nowpayments/webhook — legacy NowPayments stub (logging only)
 *  GET  /health                 — liveness probe
 */
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import HooshPayInvoice from "./models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./services/hooshpay/fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./services/hooshpay/verifyLock.js";

const app = express();

// ── Raw body capture (must come before express.json) ─────────────────────
// We need the raw bytes to compute HMAC. express.json() is applied after.
app.use((req, res, next) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});

app.use(express.json());

// ── Reversal / refund statuses from HooshPay ─────────────────────────────
const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback", "cancelled"]);

// ── HooshPay Webhook ──────────────────────────────────────────────────────
app.post("/api/hooshpay/webhook", async (req, res) => {
  // Respond 200 immediately so HooshPay does not retry during processing
  res.sendStatus(200);

  try {
    const payload = req.body;

    if (!payload || typeof payload !== "object") {
      console.warn("[HooshPay Webhook] Empty or non-object payload");
      return;
    }

    // ── 1. HMAC-SHA256 signature validation ─────────────────────────────
    const receivedSig = req.headers["x-hooshpay-signature"] || req.headers["x-signature"];
    const webhookSecret = process.env.HOOSHPAY_WEBHOOK_SECRET;

    if (webhookSecret) {
      if (!receivedSig) {
        console.warn("[HooshPay Webhook] Missing signature header — rejecting");
        return;
      }
      const expectedSig = crypto
        .createHmac("sha256", webhookSecret)
        .update(req.rawBody)
        .digest("hex");

      let valid = false;
      try {
        valid = crypto.timingSafeEqual(
          Buffer.from(receivedSig, "hex"),
          Buffer.from(expectedSig, "hex")
        );
      } catch { valid = false; }

      if (!valid) {
        console.warn(`[HooshPay Webhook] Invalid signature — rejecting`);
        return;
      }
    } else {
      console.warn("[HooshPay Webhook] HOOSHPAY_WEBHOOK_SECRET not set — skipping validation");
    }

    const { uid, order_id, status, paid } = payload;
    console.log(`[HooshPay Webhook] uid=${uid} order_id=${order_id} status=${status} paid=${paid}`);

    // ── 2. Find invoice ──────────────────────────────────────────────────
    const invoiceDoc = await HooshPayInvoice.findOne({
      $or: [
        ...(uid ? [{ uid }] : []),
        ...(order_id ? [{ orderId: order_id }] : []),
      ],
    });

    if (!invoiceDoc) {
      console.warn(`[HooshPay Webhook] Invoice not found: uid=${uid} order_id=${order_id}`);
      return;
    }

    // ── 3. Append to audit log ───────────────────────────────────────────
    await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
      $push: { webhookLog: { receivedAt: new Date(), payload } },
    });

    // ── 4. Handle reversal / refund ──────────────────────────────────────
    if (REVERSAL_STATUSES.has(status)) {
      console.warn(
        `[HooshPay Webhook] REVERSAL received: uid=${invoiceDoc.uid} status=${status}. ` +
        `Manual admin review required.`
      );
      await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
        $set: { status: "reversed" },
      });
      // Notify admins — best-effort
      const groupId = process.env.GROUP_ID;
      if (groupId) {
        try {
          const botModule = await import("./config/botInstance.js");
          const bot = botModule.default;
          if (bot?.sendMessage) {
            await bot.sendMessage(
              groupId,
              `⚠️ <b>پرداخت برگشت خورد!</b>\n\n` +
              `🆔 UID: <code>${invoiceDoc.uid}</code>\n` +
              `💰 مبلغ: <code>${invoiceDoc.amount.toLocaleString()}</code> تومان\n` +
              `👤 کاربر: <code>${invoiceDoc.userId}</code>\n` +
              `📌 وضعیت: <code>${status}</code>\n\n` +
              `لطفاً این پرداخت را به صورت دستی بررسی کنید.`,
              { parse_mode: "HTML" }
            );
          }
        } catch (e) {
          console.warn("[HooshPay Webhook] Could not notify admin of reversal:", e.message);
        }
      }
      return;
    }

    // ── 5. Only proceed on confirmed payment ────────────────────────────
    if (!paid && status !== "paid") {
      console.log(`[HooshPay Webhook] uid=${invoiceDoc.uid} not paid (status=${status}) — ignoring`);
      return;
    }

    // ── 6. In-flight lock (prevents webhook + verify race) ───────────────
    const lockAcquired = await acquireVerifyLock(invoiceDoc.uid);
    if (!lockAcquired) {
      console.log(`[HooshPay Webhook] uid=${invoiceDoc.uid} already being processed — duplicate skipped`);
      return;
    }

    try {
      let bot = null;
      try {
        const botModule = await import("./config/botInstance.js");
        bot = botModule.default;
      } catch { /* bot unavailable */ }

      await fulfillHooshOrder({ invoice: invoiceDoc, bot, chatId: invoiceDoc.userId });
    } finally {
      await releaseVerifyLock(invoiceDoc.uid);
    }

  } catch (err) {
    console.error("[HooshPay Webhook] Unhandled error:", err.message, err.stack);
  }
});

// ── Legacy NowPayments stub ───────────────────────────────────────────────
app.post("/api/nowpayments/webhook", (req, res) => {
  console.log(`[NowPayments Webhook] ${JSON.stringify(req.body)}`);
  res.sendStatus(200);
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

export const PORT = process.env.PORT || 3000;
export default app;
