/**
 * HooshPay API Client
 * Base URL: https://hooshpay.xyz/api/v1
 * Auth: X-API-KEY header on every request
 */
import axios from "axios";

const BASE_URL = "https://hooshpay.xyz/api/v1";

/**
 * Returns an axios instance pre-configured with the HooshPay API key.
 * Throws immediately if the key is missing so misconfiguration is caught
 * at startup rather than on the first payment attempt.
 */
function getClient() {
  const apiKey = process.env.HOOSHPAY_API_KEY;
  if (!apiKey) {
    throw new Error("HOOSHPAY_API_KEY environment variable is not set");
  }

  return axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

/**
 * POST /invoices
 * Creates a new HooshPay invoice.
 *
 * @param {object} params
 * @param {string} params.order_id   - Our unique order identifier
 * @param {number} params.amount     - Amount in Toman (IRR/10)
 * @param {string} params.callback_url - Webhook URL HooshPay will POST to
 * @param {string} [params.description] - Optional description shown to payer
 * @returns {Promise<{uid: string, payment_url: string, status: string}>}
 */
export async function createInvoice({ order_id, amount, callback_url, description = "" }) {
  const client = getClient();
  const { data } = await client.post("/invoices", {
    order_id,
    amount,
    callback_url,
    description,
    fee_mode: "buyer",
  });
  return data;
}

/**
 * POST /invoices/:uid/verify
 * Manually verifies a payment (fallback when webhook is missed).
 *
 * @param {string} uid - HooshPay invoice UID
 * @returns {Promise<{paid: boolean, status: string, amount: number}>}
 */
export async function verifyInvoice(uid) {
  const client = getClient();
  const { data } = await client.post(`/invoices/${uid}/verify`);
  return data;
}

/**
 * GET /invoices/:uid
 * Fetches full invoice details by UID.
 *
 * @param {string} uid
 * @returns {Promise<object>}
 */
export async function getInvoice(uid) {
  const client = getClient();
  const { data } = await client.get(`/invoices/${uid}`);
  return data;
}
