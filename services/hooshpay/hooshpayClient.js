/**
 * HooshPay API Client
 * Base URL: https://hooshpay.xyz/api/v1
 * Auth: X-API-KEY header on every request
 *
 * Official docs: https://hooshpay.xyz/developers
 *
 * All API responses are wrapped as:
 *   { success: true, data: { ... } }
 *   { success: false, message: "...", errors: [...] }
 *
 * This client unwraps the `data` field for convenience and throws
 * on `success: false` so callers can use try/catch.
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
 * Unwrap the official response envelope { success, data }.
 * Throws on success:false with the API's error message.
 */
function unwrap(res) {
  const body = res.data;
  if (!body?.success) {
    const msg = body?.message || `HooshPay API error (HTTP ${res.status})`;
    const err = new Error(msg);
    err.apiResponse = body;
    throw err;
  }
  return body.data ?? body;
}

/**
 * POST /invoices
 * Creates a new HooshPay invoice.
 *
 * @param {object} params
 * @param {string} params.order_id      - Our unique order identifier
 * @param {number} params.amount         - Amount in Toman (min 1000)
 * @param {string} [params.callback_url] - Webhook URL HooshPay will POST to
 * @param {string} [params.return_url]   - URL to redirect customer after payment
 * @param {string} [params.fee_mode]      - "seller" | "buyer" | "split"
 * @param {string} [params.description]   - Optional description shown to payer
 * @returns {Promise<object>} Invoice data from HooshPay
 */
export async function createInvoice({ order_id, amount, callback_url, return_url, fee_mode = "buyer", description = "" }) {
  const client = getClient();
  const payload = {
    order_id,
    amount,
    fee_mode,
    description,
  };
  if (callback_url) payload.callback_url = callback_url;
  if (return_url) payload.return_url = return_url;

  const { data } = await client.post("/invoices", payload);
  return unwrap({ data });
}

/**
 * POST /invoices/:uid/verify
 * Manually verifies a payment (fallback when webhook is missed).
 *
 * @param {string} uid - HooshPay invoice UID
 * @returns {Promise<object>} { paid, status, data: { uid, tracking_code, ... } }
 */
export async function verifyInvoice(uid) {
  const client = getClient();
  const { data } = await client.post(`/invoices/${uid}/verify`);
  // Verify response is: { success, paid, status, data: { uid, tracking_code, ... } }
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
  return unwrap({ data });
}

/**
 * POST /invoices/:uid/cancel
 * Cancels a pending invoice. Only invoices in "pending" status can be cancelled.
 *
 * @param {string} uid
 * @returns {Promise<object>}
 */
export async function cancelInvoice(uid) {
  const client = getClient();
  const { data } = await client.post(`/invoices/${uid}/cancel`);
  return unwrap({ data });
}