/**
 * Express HTTP server
 * Handles:
 *  - POST /api/hooshpay/webhook  — HooshPay payment notifications (primary)
 *  - POST /api/nowpayments/webhook — legacy NowPayments stub (kept for reference)
 */
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import HooshPayInvoice from "./models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./services/hooshpay/fulfillHooshOrder.js";

const app = express();

// ── Raw body capture for HMAC verification ────────────────────────────────
// We need the raw body bytes to compute the signature, so we store it on req
// before JSON parsing. express.json() will still populate req.body.
app.use((req, res, next) => {
  let rawChunks = [];
  req.on("data", (chunk) => rawChunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(rawChunks);
    next();
  });
});

app.use(express.json());

// ── HooshPay Webhook ──────────────────────────────────────────────────────
app.post("/api/hooshpay/webhook", async (req, res) => {
  // 1. Respond 200 immediately so HooshPay does not retry while we process
  res.sendStatus(200);

  try {
    const payload = req.body;

    if (!payload || typeof payload !== "object") {
      console.warn("[HooshPay Webhook] Empty or non-JSON payload received");
      return;
    }

    // 2. HMAC-SHA256 signature validation
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

      // Constant-time comparison to prevent timing attacks
      const sigMatches = (() => {
        try {
          return crypto.timingSafeEqual(
            Buffer.from(receivedSig, "hex"),
            Buffer.from(expectedSig, "hex")
          );
        } catch {
          return false;
        }
      })();

      if (!sigMatches) {
        console.warn(
          `[HooshPay Webhook] Invalid signature. received=${receivedSig} expected=${expectedSig}`
        );
        return;
      }
    } else {
      console.warn(
        "[HooshPay Webhook] HOOSHPAY_WEBHOOK_SECRET not set — skipping signature validation (NOT safe for production)"
      );
    }

    const { uid, order_id, status, paid } = payload;

    console.log(
      `[HooshPay Webhook] Received: uid=${uid} order_id=${order_id} status=${status} paid=${paid}`
    );

    // 3. Find invoice in DB
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

    // 4. Append raw payload to webhook log (audit trail / replay protection)
    await HooshPayInvoice.findByIdAndUpdate(invoiceDoc._id, {
      $push: {
        webhookLog: {
          receivedAt: new Date(),
          payload,
        },
      },
    });

    // 5. Only proceed if payment is confirmed
    if (!paid && status !== "paid") {
      console.log(
        `[HooshPay Webhook] Invoice ${invoiceDoc.uid} not yet paid (status=${status}) — ignoring`
      );
      return;
    }

    // 6. Fulfill (idempotent — safe to call on duplicate webhooks)
    // bot is not available in this module; fulfillHooshOrder handles null bot gracefully
    // and will attempt to import a shared bot instance if available.
    let bot = null;
    try {
      const botModule = await import("./config/botInstance.js");
      bot = botModule.default;
    } catch {
      // bot instance may not be available on cold paths; user will see balance credited on next login
    }

    await fulfillHooshOrder({ invoice: invoiceDoc, bot, chatId: invoiceDoc.userId });

  } catch (err) {
    console.error("[HooshPay Webhook] Unhandled error:", err.message, err.stack);
  }
});

// ── Legacy NowPayments stub (fixed from broken original) ──────────────────
app.post("/api/nowpayments/webhook", async (req, res) => {
  console.log(`[NowPayments Webhook] Received: ${JSON.stringify(req.body, null, 2)}`);
  res.sendStatus(200);
  // This gateway is no longer in active use. Payload is logged for reference.
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

export const PORT = process.env.PORT || 3000;
export default app;
