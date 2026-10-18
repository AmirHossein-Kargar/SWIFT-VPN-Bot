import { applyNowPaymentsUpdate } from "./applyStatus.js";
import { verifyNowPaymentsSignature } from "./signature.js";

function send(res, status, body) {
  if (res.headersSent) return;
  res.status(status).json(body);
}

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "nowpayments-ipn", level, message, ...meta }),
  );
}

async function notifyCredited(result, bot) {
  if (!result?.credited || !bot?.sendMessage) return;
  const amount = Number(result.amountToman).toLocaleString("en-US");
  const balance = result.balance == null ? "" : `\n💳 <b>موجودی جدید:</b> <code>${Number(result.balance).toLocaleString("en-US")}</code> تومان`;
  try {
    await bot.sendMessage(result.userId, `✅ <b>پرداخت ترون تأیید شد.</b>\n\n💰 <b>مبلغ شارژ:</b> <code>${amount}</code> تومان${balance}`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    log("warn", "Telegram credit notification failed", { orderId: result.orderId, errorType: error?.name || "TelegramError" });
  }
}

export async function handleNowPaymentsIpn(req, res, {
  requestId = "nowpayments",
  secret = process.env.NOWPAYMENTS_IPN_SECRET,
  apply = applyNowPaymentsUpdate,
  bot = null,
} = {}) {
  if (!secret) {
    log("error", "IPN secret is not configured", { requestId });
    return send(res, 503, { ok: false, error: "webhook_not_configured", request_id: requestId });
  }
  const raw = req.rawBody;
  if (!raw || !Buffer.isBuffer(raw) && typeof raw !== "string") {
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
    log("error", "IPN processing failed", { requestId, errorType: error?.name || "Error" });
    return send(res, 503, { ok: false, error: "temporarily_unavailable", request_id: requestId });
  }

  if (result.outcome === "unknown_order") {
    log("warn", "Signed IPN did not match an order", { requestId });
    return send(res, 404, { ok: false, error: "invoice_not_found", request_id: requestId });
  }
  if (result.outcome === "invoice_mismatch" || result.outcome === "order_mismatch") {
    return send(res, 409, { ok: false, error: "invoice_reference_mismatch", request_id: requestId });
  }
  if (result.outcome === "invalid_status" || result.outcome === "amount_mismatch") {
    return send(res, 422, { ok: false, error: "payment_details_mismatch", request_id: requestId });
  }
  if (result.outcome === "not_eligible") {
    return send(res, 409, { ok: false, error: "invoice_not_eligible", request_id: requestId });
  }

  send(res, 200, {
    ok: true,
    received: true,
    duplicate: Boolean(result.alreadyCredited),
    request_id: requestId,
  });
  const notifier = bot || await defaultBot();
  await notifyCredited(result, notifier);
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
