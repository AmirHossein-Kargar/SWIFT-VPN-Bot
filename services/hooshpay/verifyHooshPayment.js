import { randomUUID } from "node:crypto";
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./verifyLock.js";
import {
  HOOSH_TERMINAL_NONPAYABLE,
  hooshProviderData,
  normalizeHooshStatus,
  validateHooshPaidDetails,
} from "./paymentValidation.js";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay-verify", level, message, ...meta })
  );
}

function terminalResult(status, cid) {
  if (status === "cancelled") return { success: false, cancelled: true, status, correlationId: cid };
  if (status === "expired") return { success: false, expired: true, status, correlationId: cid };
  if (status === "failed") return { success: false, failed: true, status, correlationId: cid };
  if (status === "reversed") return { success: false, reversed: true, status, correlationId: cid };
  return null;
}

export async function verifyHooshPayment(uid, bot, chatId, {
  invoiceModel = HooshPayInvoice,
  verifyInvoice = apiVerify,
  fulfill = fulfillHooshOrder,
  acquireLock = acquireVerifyLock,
  releaseLock = releaseVerifyLock,
} = {}) {
  const cid = randomUUID();
  let invoice;
  try {
    invoice = await invoiceModel.findOne({ uid });
  } catch (error) {
    log("error", "Invoice lookup failed", { cid, errorType: error?.name || "DatabaseError" });
    return { success: false, error: "Unable to check this payment right now", correlationId: cid };
  }
  if (!invoice) return { success: false, error: "Invoice not found", correlationId: cid };

  const localStatus = normalizeHooshStatus(invoice.status);
  const localTerminal = terminalResult(localStatus, cid);
  if (localTerminal) return localTerminal;
  if (invoice.fulfilled && invoice.balanceCredited) return { success: false, alreadyFulfilled: true, correlationId: cid };

  const lock = await acquireLock(uid);
  if (!lock.acquired) return { success: false, locked: true, correlationId: cid };

  try {
    let verifyResult;
    try {
      verifyResult = await verifyInvoice(uid);
    } catch (error) {
      log("warn", "HooshPay verification API unavailable", {
        cid, uid, errorType: error?.name || "HooshPayApiError", code: error?.code,
      });
      return { success: false, error: "Payment verification is temporarily unavailable", correlationId: cid };
    }

    const data = hooshProviderData(verifyResult);
    const status = normalizeHooshStatus(data.status);
    const paidFlag = verifyResult?.paid ?? data.paid;
    if ((paidFlag === true && status !== "paid") || (paidFlag === false && status === "paid")) {
      log("error", "HooshPay verification returned conflicting status fields", { cid, uid, status });
      return { success: false, error: "Conflicting payment verification result", correlationId: cid };
    }

    if (status !== "paid") {
      if (HOOSH_TERMINAL_NONPAYABLE.includes(status)) {
        const closed = await invoiceModel.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false, balanceCredited: false },
          { $set: { status } },
          { new: true },
        );
        if (!closed) {
          await invoiceModel.findOneAndUpdate(
            { _id: invoice._id, status: "paid" },
            {
              $set: {
                recoveryStatus: "required",
                recoveryReason: `provider_${status}_after_payment_claim`,
              },
            },
          );
        }
        return terminalResult(status, cid);
      }
      if (status === "reversed") {
        let reversed = await invoiceModel.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false, balanceCredited: false },
          { $set: { status: "reversed", reversedAt: new Date() } },
          { new: true },
        );
        if (!reversed) {
          reversed = await invoiceModel.findOneAndUpdate(
            { _id: invoice._id, status: "paid" },
            {
              $set: {
                status: "reversed",
                reversedAt: new Date(),
                recoveryStatus: "required",
                recoveryReason: "provider_reversal_after_payment_claim",
              },
            },
            { new: true },
          );
        }
        return terminalResult(status, cid);
      }
      return { success: false, notPaid: true, status: status || "pending", correlationId: cid };
    }

    const mismatch = validateHooshPaidDetails(invoice, data, {
      requireUid: true,
      requireOrderId: true,
      requireCurrency: true,
    });
    if (mismatch) {
      log("error", "HooshPay verification did not match the local invoice", { cid, uid, reason: mismatch });
      return { success: false, error: "The verified payment details do not match the invoice", correlationId: cid };
    }

    const trackingCode = data.tracking_code;
    if (typeof trackingCode === "string" && trackingCode.length <= 128) {
      await invoiceModel.findOneAndUpdate(
        { _id: invoice._id, status: { $in: ["pending", "paid"] } },
        { $set: { trackingCode } }
      );
      invoice.trackingCode = trackingCode;
    }

    const result = await fulfill({
      invoice,
      bot,
      chatId: chatId ?? invoice.userId,
      correlationId: cid,
      paidAt: data.paid_at,
      invoiceModel,
    });
    return { success: Boolean(result.credited || result.alreadyCredited || result.notified), ...result, correlationId: cid };
  } catch (error) {
    log("error", "Payment verification/fulfillment failed", {
      cid, uid, errorType: error?.name || "Error",
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
    });
    return { success: false, error: "Payment confirmation is temporarily unavailable", correlationId: cid };
  } finally {
    await releaseLock(lock);
  }
}
