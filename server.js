/**
 * Express HTTP server
 *
 * Endpoints:
 *  POST /api/hooshpay/webhook    — HooshPay payment notifications
 *  POST /api/nowpayments/webhook — legacy stub
 *  GET  /health                  — liveness probe
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
// Accumulates the raw bytes so we can compute HMAC over the exact wire bytes,
// not over a re-serialized JSON object (which may reorder keys).
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

// ── Reversal statuses ─────────────────────────────────────────────────────────
const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback", "cancelled"]);

// ── HooshPay Webhook ──────────────────────────────────────────────────────────
app.post("/api/hooshpay/webhook", async (req, res) => {
  // Respond 200 immediately — HooshPay should not retry while we process
  res.sendStatus(200);

  const reqId = randomUUID();   // per-request correlation ID

  try {
    const payload = req.body;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      log("warn", "Invalid payload type", { reqId });
      return;
    }

    // ── 1. HMAC-SHA256 signature validation ───────────────────────────────
    const receivedSig  = req.headers["x-hooshpay-signature"] || req.headers["x-signature"];
    const webhookSecret = process.env.HOOSHPAY_WEBHOOK_SECRET;

    if (webhookSecret) {
      if (!receivedSig) {
        log("warn", "Missing signature header — rejecting", { reqId });
        return;
      }

      // CRITICAL: sign over req.rawBody (the exact wire bytes), NOT
      // JSON.stringify(payload) which may produce different key ordering.
      const expectedSig = crypto
        .createHmac("sha256", webhookSecret)
        .update(req.rawBody)          // ← raw bytes, not re-serialized
        .digest("hex");

      let valid = false;
      try {
        // timingSafeEqual requires equal-length buffers; catch any mismatch
        valid = crypto.timingSafeEqual(
          Buffer.from(receivedSig, "hex"),
          Buffer.from(expectedSig, "hex")
        );
      } catch {
        valid = false;
      }

      if (!valid) {
        log("warn", "Invalid HMAC signature — rejecting", { reqId });
        return;
      }
    } else {
      log("warn", "HOOSHPAY_WEBHOOK_SECRET not set — skipping validation (unsafe)", { reqId });
    }

    const { uid, order_id, status, paid } = payload;
    log("info", "Webhook received", { reqId, uid, order_id, status, paid });

    // ── 2. Find invoice ───────────────────────────────────────────────────
    const invoiceDoc = await HooshPayInvoice.findOne({
      $or: [
        ...(uid      ? [{ uid }]                : []),
        ...(order_id ? [{ orderId: order_id }]  : []),
      ],
    });

    if (!invoiceDoc) {
      log("warn", "Invoice not found", { reqId, uid, order_id });
      return;
    }

    // ── 3. Append to audit log (always, for every delivery) ───────────────
    await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
      $push: { webhookLog: { receivedAt: new Date(), payload } },
    });

    // ── 4. Reversal / refund ──────────────────────────────────────────────
    if (REVERSAL_STATUSES.has(status)) {
      log("warn", "Reversal received — marking invoice and alerting admin", {
        reqId, uid: invoiceDoc.uid, status,
      });
      await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
        $set: { status: "reversed" },
      });

      // Notify admin group — best-effort
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
              `📌 وضعیت: <code>${status}</code>\n` +
              `🔑 Req-ID: <code>${reqId}</code>\n\n` +
              `لطفاً این پرداخت را دستی بررسی کنید.`,
              { parse_mode: "HTML" }
            );
          }
        } catch (e) {
          log("warn", "Admin reversal alert failed", { reqId, error: e.message });
        }
      }
      return;
    }

    // ── 5. Only proceed on confirmed payment ──────────────────────────────
    if (!paid && status !== "paid") {
      log("info", "Not paid — ignoring", { reqId, uid: invoiceDoc.uid, status });
      return;
    }

    // ── 6. In-flight lock (webhook + manual verify race prevention) ───────
    const lockAcquired = await acquireVerifyLock(invoiceDoc.uid);
    if (!lockAcquired) {
      log("info", "Duplicate webhook — already being processed", { reqId, uid: invoiceDoc.uid });
      return;
    }

    try {
      let bot = null;
      try {
        const m = await import("./config/botInstance.js");
        bot = m.default;
      } catch { /* bot unavailable on cold webhook path */ }

      await fulfillHooshOrder({
        invoice: invoiceDoc,
        bot,
        chatId: invoiceDoc.userId,
        correlationId: reqId,
      });
    } finally {
      await releaseVerifyLock(invoiceDoc.uid);
    }

  } catch (err) {
    log("error", "Unhandled webhook error", { reqId, error: err.message, stack: err.stack });
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
