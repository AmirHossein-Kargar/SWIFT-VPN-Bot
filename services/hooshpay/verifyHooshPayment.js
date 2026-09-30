/**
 * verifyHooshPayment
 * ------------------
 * Manual fallback called when user presses "پرداخت کردم".
 *
 * Return discriminated union:
 *   { success: true, correlationId }
 *   { success: false, alreadyFulfilled: true }
 *   { success: false, notPaid: true }
 *   { success: false, locked: true }
 *   { success: false, expired: true }
 *   { success: false, cancelled: true }
 *   { success: false, error: string, correlationId }
 *
 * Redis lock failure → fail-open (MongoDB Phase-1 guard is authoritative).
 */
import { randomUUID } from "crypto";
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./verifyLock.js";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay-verify", level, message, ...meta })
  );
}

// Terminal states where we should NOT contact the HooshPay API
const TERMINAL_STATUSES = ["expired", "cancelled", "failed", "reversed"];

export async function verifyHooshPayment(uid, bot, chatId) {
  const cid = randomUUID();

  // Load invoice
  const invoice = await HooshPayInvoice.findOne({ uid });
  if (!invoice) {
    log("warn", "Invoice not found", { cid, uid });
    return { success: false, error: "Invoice not found" };
  }

  // Already fully settled
  if (invoice.fulfilled && invoice.balanceCredited) {
    log("info", "Already fulfilled — returning alreadyFulfilled", { cid, uid });
    return { success: false, alreadyFulfilled: true };
  }

  // Terminal state — do not contact API
  if (TERMINAL_STATUSES.includes(invoice.status)) {
    log("info", "Invoice in terminal state", { cid, uid, status: invoice.status });

    if (invoice.status === "cancelled") {
      return { success: false, cancelled: true };
    }
    return { success: false, expired: true };
  }

  // Acquire in-flight lock (fail-open on Redis error)
  const lockAcquired = await acquireVerifyLock(uid);
  if (!lockAcquired) {
    log("info", "Lock not acquired — duplicate in-flight call", { cid, uid });
    return { success: false, locked: true };
  }

  try {
    log("info", "PAYMENT_VERIFICATION_STARTED — calling HooshPay verify API", { cid, uid });

    let verifyResult;
    try {
      verifyResult = await apiVerify(uid);
    } catch (err) {
      log("error", "HooshPay API error", { cid, uid, error: err.message });
      return { success: false, error: err.message, correlationId: cid };
    }

    // Official verify response: { success, paid, status, data: { uid, tracking_code, ... } }
    const isPaid = verifyResult?.paid === true || verifyResult?.status === "paid";

    // Store tracking code if returned
    if (verifyResult?.data?.tracking_code) {
      await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
        $set: { trackingCode: verifyResult.data.tracking_code },
      });
    }

    if (!isPaid) {
      log("info", "HooshPay reports not paid", {
        cid, uid,
        status: verifyResult?.status,
        paid: verifyResult?.paid,
      });
      return { success: false, notPaid: true };
    }

    log("info", "Payment confirmed — running fulfillment", { cid, uid });
    await fulfillHooshOrder({ invoice, bot, chatId, correlationId: cid });
    return { success: true, correlationId: cid };

  } finally {
    await releaseVerifyLock(uid);
  }
}