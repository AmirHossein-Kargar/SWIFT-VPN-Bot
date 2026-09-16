/**
 * verifyHooshPayment
 * ------------------
 * Manual fallback verification — called when the user presses "I've Paid".
 * Calls POST /invoices/:uid/verify on HooshPay, then runs fulfillment if paid.
 *
 * Returns an object so callers can render the right bot message:
 *   { success: true }   — payment confirmed, balance credited
 *   { success: false, alreadyFulfilled: true }  — duplicate call, no action needed
 *   { success: false, notPaid: true }  — HooshPay says not yet paid
 *   { success: false, error: string }  — unexpected error
 */
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";

/**
 * @param {string} uid          - HooshPay invoice UID
 * @param {object} bot          - node-telegram-bot-api instance
 * @param {number} chatId       - Telegram chat ID to send updates to
 */
export async function verifyHooshPayment(uid, bot, chatId) {
  // Load invoice from DB
  const invoice = await HooshPayInvoice.findOne({ uid });
  if (!invoice) {
    return { success: false, error: "Invoice not found" };
  }

  // Guard: already fulfilled — idempotency
  if (invoice.fulfilled) {
    return { success: false, alreadyFulfilled: true };
  }

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

  // Payment confirmed — run fulfillment (idempotent internally)
  await fulfillHooshOrder({ invoice, bot, chatId });
  return { success: true };
}
