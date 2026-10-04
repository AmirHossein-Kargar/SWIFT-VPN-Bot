import { randomUUID } from "node:crypto";
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./verifyLock.js";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay-verify", level, message, ...meta })
  );
}

function verifiedAmountMatches(invoice, result) {
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  const amount = data?.amount;
  if (amount == null) return true;
  return Number.isSafeInteger(Number(amount)) && Number(amount) === Number(invoice.amount);
}

export async function verifyHooshPayment(uid, bot, chatId) {
  const cid = randomUUID();
  let invoice;
  try {
    invoice = await HooshPayInvoice.findOne({ uid });
  } catch (error) {
    log("error", "Invoice lookup failed", { cid, errorType: error?.name || "DatabaseError" });
    return { success: false, error: "Unable to check this payment right now", correlationId: cid };
  }
  if (!invoice) return { success: false, error: "Invoice not found", correlationId: cid };
  if (invoice.status === "reversed") return { success: false, error: "Payment was reversed", correlationId: cid };
  if (invoice.fulfilled && invoice.balanceCredited) return { success: false, alreadyFulfilled: true, correlationId: cid };

  const lock = await acquireVerifyLock(uid);
  if (!lock.acquired) return { success: false, locked: true, correlationId: cid };

  try {
    let verifyResult;
    try {
      verifyResult = await apiVerify(uid);
    } catch (error) {
      log("warn", "HooshPay verification API unavailable", {
        cid, uid, errorType: error?.name || "HooshPayApiError", code: error?.code,
      });
      return { success: false, error: "Payment verification is temporarily unavailable", correlationId: cid };
    }

    const status = String(verifyResult?.status ?? verifyResult?.data?.status ?? "").toLowerCase();
    const isPaid = verifyResult?.paid === true || status === "paid";
    if (verifyResult?.paid === false && status === "paid") {
      return { success: false, error: "Conflicting payment verification result", correlationId: cid };
    }
    if (!isPaid) {
      return { success: false, notPaid: true, status: status || "pending", correlationId: cid };
    }

    const verifiedUid = verifyResult?.data?.uid ?? verifyResult?.uid;
    if (verifiedUid != null && String(verifiedUid) !== String(uid)) {
      log("error", "HooshPay verification UID mismatch", { cid, uid });
      return { success: false, error: "Payment verification could not be matched to this invoice", correlationId: cid };
    }
    if (!verifiedAmountMatches(invoice, verifyResult)) {
      log("error", "HooshPay verification amount mismatch", { cid, uid });
      return { success: false, error: "The verified payment amount does not match the invoice", correlationId: cid };
    }

    const trackingCode = verifyResult?.data?.tracking_code ?? verifyResult?.tracking_code;
    if (typeof trackingCode === "string" && trackingCode.length <= 128) {
      await HooshPayInvoice.findOneAndUpdate(
        { _id: invoice._id, status: { $ne: "reversed" } },
        { $set: { trackingCode } }
      );
      invoice.trackingCode = trackingCode;
    }

    const paidAt = verifyResult?.data?.paid_at ?? verifyResult?.paid_at;
    const result = await fulfillHooshOrder({
      invoice,
      bot,
      chatId: chatId ?? invoice.userId,
      correlationId: cid,
      paidAt,
    });
    return { success: Boolean(result.credited || result.alreadyCredited || result.notified), ...result, correlationId: cid };
  } catch (error) {
    log("error", "Payment verification/fulfillment failed", {
      cid, uid, errorType: error?.name || "Error",
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
    });
    return { success: false, error: "Payment confirmation is temporarily unavailable", correlationId: cid };
  } finally {
    await releaseVerifyLock(lock);
  }
}
