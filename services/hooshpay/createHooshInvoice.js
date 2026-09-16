/**
 * createHooshInvoice
 * ------------------
 * Calls the HooshPay API to create an invoice, persists it to MongoDB,
 * and returns the stored document.
 *
 * Generates a unique order_id using crypto.randomUUID() so there is zero
 * chance of collision even on restart.
 */
import { randomUUID } from "crypto";
import { createInvoice as apiCreateInvoice } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";

/**
 * @param {object} params
 * @param {number} params.userId      - Telegram user ID
 * @param {number} params.amount      - Amount in Toman
 * @param {string} [params.description]
 * @returns {Promise<HooshPayInvoice>} Saved Mongoose document
 */
export async function createHooshInvoice({ userId, amount, description = "VPN wallet top-up" }) {
  const webhookBase = process.env.WEBHOOK_BASE_URL;
  if (!webhookBase) {
    throw new Error("WEBHOOK_BASE_URL environment variable is not set");
  }

  const orderId = `HP-${randomUUID()}`;
  const callbackUrl = `${webhookBase}/api/hooshpay/webhook`;

  // Call HooshPay API — throws on network / auth errors (caller handles)
  const apiResponse = await apiCreateInvoice({
    order_id: orderId,
    amount,
    callback_url: callbackUrl,
    description,
  });

  // Defensive: ensure we got what we need
  if (!apiResponse?.uid || !apiResponse?.payment_url) {
    throw new Error(
      `HooshPay API returned unexpected response: ${JSON.stringify(apiResponse)}`
    );
  }

  // Persist to DB
  const doc = await HooshPayInvoice.create({
    uid: apiResponse.uid,
    orderId,
    userId,
    amount,
    paymentUrl: apiResponse.payment_url,
    status: "pending",
  });

  return doc;
}
