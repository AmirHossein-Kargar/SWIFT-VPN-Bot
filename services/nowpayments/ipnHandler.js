import { applyNowPaymentsUpdate } from "./applyStatus.js";
import { notifyNowPaymentsCredit } from "./notify.js";
import { verifyNowPaymentsSignature } from "./signature.js";
import { findTombstone, recordLateEvent } from "../payments/invoiceCleanup.js";

const LATE_MONEY_STATUSES = new Set(["confirming", "confirmed", "sending", "partially_paid", "finished"]);

/** Best-effort: the response to the provider must never depend on the alert succeeding. */
async function alertLatePayment({ bot, orderId, status }) {
  const groupId = process.env.GROUP_ID;
  if (!groupId) return;
  try {
    const notifier = bot || await defaultBot();
    await notifier?.sendMessage?.(
      groupId,
      `🚨 <b>NOWPayments Alert</b>

⚠️ پرداخت دیرهنگام (${String(status).slice(0, 20)}) برای فاکتور پاک‌شده دریافت شد. Order: <code>${String(orderId).replace(/[^A-Za-z0-9_.-]/g, "")}</code>. اعتبار خودکار ثبت نشد؛ بررسی دستی لازم است.`,
      { parse_mode: "HTML" },
    );
  } catch (error) {
    log("warn", "Late-payment alert failed", { errorType: error?.name || "Error" });
  }
}

function send(res, status, body) {
  if (res.headersSent) return;
  res.status(status).json(body);
}

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "nowpayments-ipn", level, message, ...meta }),
  );
}

export async function handleNowPaymentsIpn(req, res, {
  requestId = "nowpayments",
  secret = process.env.NOWPAYMENTS_IPN_SECRET,
  apply = applyNowPaymentsUpdate,
  bot = null,
  notify = notifyNowPaymentsCredit,
  lookupTombstone = findTombstone,
  recordLate = recordLateEvent,
} = {}) {
  if (!secret) {
    log("error", "IPN secret is not configured", { requestId });
    return send(res, 503, { ok: false, error: "webhook_not_configured", request_id: requestId });
  }
  const raw = req.rawBody;
  if (!raw || (!Buffer.isBuffer(raw) && typeof raw !== "string")) {
    return send(res, 400, { ok: false, error: "invalid_json", request_id: requestId });
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch {
    return send(res, 400, { ok: false, error: "invalid_json", request_id: requestId });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return send(res, 400, { ok: false, error: "invalid_json_object", request_id: requestId });
  }
  const signature = req.get?.("x-nowpayments-sig") || req.headers?.["x-nowpayments-sig"];
  if (!verifyNowPaymentsSignature(payload, signature, secret)) {
    log("warn", "IPN signature rejected", { requestId });
    return send(res, 401, { ok: false, error: "invalid_signature", request_id: requestId });
  }

  let result;
  try {
    result = await apply({ payload });
  } catch (error) {
    log("error", "IPN processing failed", {
      requestId,
      errorType: error?.name || "Error",
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
    });
    return send(res, 503, { ok: false, error: "temporarily_unavailable", request_id: requestId });
  }

  if (result.outcome === "unknown_order") {
    // Signed notification for an invoice removed by the 24h cleanup: acknowledge
    // (so the provider stops retrying), remember it, and never credit.
    try {
      const tombstone = await lookupTombstone({
        provider: "nowpayments",
        orderId: typeof payload.order_id === "string" ? payload.order_id : null,
        paymentId: payload.payment_id != null ? String(payload.payment_id) : null,
        invoiceId: payload.invoice_id != null ? String(payload.invoice_id) : null,
      });
      if (tombstone) {
        await recordLate({ tombstone, status: payload.payment_status });
        log("warn", "Signed IPN for an invoice removed by cleanup; ignored", { requestId });
        // Money may really have arrived for a removed invoice: it is never credited
        // automatically, so a human must be told (same as the HooshPay webhook).
        if (LATE_MONEY_STATUSES.has(String(payload.payment_status || "").toLowerCase())) {
          await alertLatePayment({ bot, orderId: tombstone.orderId, status: payload.payment_status });
        }
        return send(res, 200, { ok: true, received: true, ignored: "invoice_removed", request_id: requestId });
      }
    } catch {
      return send(res, 503, { ok: false, error: "temporarily_unavailable", request_id: requestId });
    }
    log("warn", "Signed IPN did not match an order", { requestId });
    return send(res, 404, { ok: false, error: "invoice_not_found", request_id: requestId });
  }
  if (["invoice_mismatch", "payment_id_mismatch", "order_mismatch", "missing_provider_id", "provider_id_conflict"].includes(result.outcome)) {
    return send(res, 409, { ok: false, error: "invoice_reference_mismatch", request_id: requestId });
  }
  if (["invalid_payload", "invalid_status", "amount_mismatch"].includes(result.outcome)) {
    return send(res, 422, { ok: false, error: "payment_details_mismatch", request_id: requestId });
  }
  if (result.outcome === "not_eligible" || result.outcome === "user_missing") {
    return send(res, result.outcome === "user_missing" ? 503 : 409, {
      ok: false,
      error: result.outcome === "user_missing" ? "temporarily_unavailable" : "invoice_not_eligible",
      request_id: requestId,
    });
  }

  send(res, 200, {
    ok: true,
    received: true,
    duplicate: Boolean(result.alreadyCredited),
    request_id: requestId,
  });

  if (result.orderId && (result.notificationPending || result.credited || result.alreadyCredited)) {
    const notifier = bot || await defaultBot();
    try {
      await notify(result.orderId, notifier);
    } catch (error) {
      log("warn", "Credit notification recovery failed", {
        requestId,
        orderId: result.orderId,
        errorType: error?.name || "Error",
      });
    }
  }
  return undefined;
}

async function defaultBot() {
  try {
    const module = await import("../../config/botInstance.js");
    return module.default?.bot || null;
  } catch {
    return null;
  }
}
