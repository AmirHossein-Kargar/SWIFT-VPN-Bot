/**
 * verifyHooshPayment
 * ------------------
 * Manual fallback verification — called when the user presses "پرداخت کردم".
 * Also handles the race between double-clicks and duplicate Telegram callbacks.
 *
 * Returns a discriminated union so callers can render the right bot message:
 *   { success: true }
 *   { success: false, alreadyFulfilled: true }
 *   { success: false, notPaid: true }
 *   { success: false, locked: true }       ← NEW: another call already in-flight
 *   { success: false, expired: true }       ← NEW: invoice has expired
 *   { success: false, error: string }
 */
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireVerifyLock, releaseVerifyLock } from "./verifyLock.js";

/**
 * @param {string} uid    - HooshPay invoice UID
 * @param {object} bot    - node-telegram-bot-api instance
 * @param {number} chatId - Telegram chat ID for delivery
 */
export async function verifyHooshPayment(uid, bot, chatId) {
  // Load invoice
  const invoice = await HooshPayInvoice.findOne({ uid });
  if (!invoice) {
    return { success: false, error: "Invoice not found" };
  }

  // Already fully settled
  if (invoice.fulfilled && invoice.balanceCredited) {
    return { success: false, alreadyFulfilled: true };
  }

  // Expired — do not contact API
  if (invoice.status === "expired" || invoice.status === "failed" || invoice.status === "reversed") {
    return { success: false, expired: true };
  }

  // ── Acquire per-invoice in-flight lock ─────────────────────────────────
  // Prevents double-click / duplicate Telegram callback races.
  const lockAcquired = await acquireVerifyLock(uid);
  if (!lockAcquired) {
    return { success: false, locked: true };
  }

  try {
    // Ask HooshPay
    let verifyResult;
    try {
      verifyResult = await apiVerify(uid);
    } catch (err) {
      console.error(`[HooshPay] verifyInvoice error for uid=${uid}:`, err.message);
      return { success: false, error: err.message };
    }

    if (!verifyResult?.paid) {
      return { success: false, notPaid: true };
    }

    // Payment confirmed — run idempotent fulfillment
    await fulfillHooshOrder({ invoice, bot, chatId });
    return { success: true };

  } finally {
    // Always release the lock, even on error, so the user can retry
    await releaseVerifyLock(uid);
  }
}
