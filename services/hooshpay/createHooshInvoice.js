/**
 * createHooshInvoice
 * ------------------
 * Calls the HooshPay API to create an invoice, persists it to MongoDB,
 * and returns the stored document.
 *
 * Generates a unique order_id using crypto.randomUUID() so there is zero
 * chance of collision even on restart.
 */
import { randomUUID } from "node:crypto";
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
  const apiData = await apiCreateInvoice({
    order_id: orderId,
    amount,
    callback_url: callbackUrl,
    fee_mode: "buyer",
    description,
  });

  // Defensive: ensure we got what we need
  if (!apiData?.uid || !apiData?.payment_url) {
    throw new Error(
      `HooshPay API returned unexpected response: ${JSON.stringify(apiData)}`
    );
  }

  // Persist to DB with all fields from the API response
  const doc = await HooshPayInvoice.create({
    uid: apiData.uid,
    orderId,
    userId,
    amount: apiData.amount ?? amount,
    feeMode: apiData.fee_mode ?? "buyer",
    feePercent: apiData.fee_percent ?? null,
    feeAmount: apiData.fee_amount ?? null,
    payableAmount: apiData.payable_amount ?? null,
    merchantCredit: apiData.merchant_credit ?? null,
    cardNumber: apiData?.card?.card_number ?? null,
    cardHolder: apiData?.card?.holder_name ?? null,
    cardBank: apiData?.card?.bank_name ?? null,
    paymentUrl: apiData.payment_url,
    expiresAt: apiData.expires_at ? new Date(apiData.expires_at) : null,
    status: "pending",
  });

  return doc;
}