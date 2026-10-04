import { randomUUID } from "node:crypto";
import { createInvoice as apiCreateInvoice, cancelInvoice as apiCancelInvoice } from "./hooshpayClient.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";

function requireHttpsUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} returned an invalid URL`); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials`);
  }
  return parsed.toString();
}

function optionalNonNegativeInteger(value, fieldName) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`HooshPay returned invalid ${fieldName}`);
  return number;
}

/** Create and persist a HooshPay invoice. A persistence error triggers best-effort cancellation. */
export async function createHooshInvoice({ userId, amount, description = "VPN wallet top-up" }) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) {
    throw new TypeError("userId must be a positive Telegram user ID");
  }
  if (!Number.isSafeInteger(amount) || amount < 1_000) {
    throw new TypeError("amount must be a positive integer amount in Toman");
  }

  const webhookBase = process.env.WEBHOOK_BASE_URL?.trim();
  if (!webhookBase) throw new Error("WEBHOOK_BASE_URL is not configured");
  let parsedBase;
  try { parsedBase = new URL(webhookBase); } catch { throw new Error("WEBHOOK_BASE_URL is invalid"); }
  if (parsedBase.protocol !== "https:" || !parsedBase.hostname || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error("WEBHOOK_BASE_URL must be a public HTTPS base URL");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname.toLowerCase())) {
    throw new Error("WEBHOOK_BASE_URL cannot point to localhost");
  }

  const orderId = `HP-${randomUUID()}`;
  const callbackUrl = `${webhookBase.replace(/\/+$/, "")}/api/hooshpay/webhook`;
  const apiData = await apiCreateInvoice({
    order_id: orderId,
    amount,
    callback_url: callbackUrl,
    fee_mode: "buyer",
    description: String(description).slice(0, 250),
  });

  let uid;
  try {
    if (typeof apiData?.uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(apiData.uid)) {
      throw new Error("HooshPay returned an invalid invoice UID");
    }
    uid = apiData.uid;
    if (!apiData.payment_url) throw new Error("HooshPay did not return a payment URL");
    const paymentUrl = requireHttpsUrl(apiData.payment_url, "payment_url");
    if (apiData.amount != null && optionalNonNegativeInteger(apiData.amount, "amount") !== amount) {
      throw new Error("HooshPay invoice amount does not match the requested amount");
    }

    const feeMode = apiData.fee_mode ?? "buyer";
    if (!["seller", "buyer", "split"].includes(feeMode)) throw new Error("HooshPay returned an unsupported fee mode");
    const feePercent = apiData.fee_percent == null ? null : Number(apiData.fee_percent);
    if (feePercent != null && (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100)) {
      throw new Error("HooshPay returned an invalid fee percentage");
    }
    const expiresAt = apiData.expires_at == null ? null : new Date(apiData.expires_at);
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("HooshPay returned an invalid expiry time");

    return await HooshPayInvoice.create({
      uid,
      orderId,
      userId: Number(userId),
      amount,
      currency: "TOMAN",
      feeMode,
      feePercent,
      feeAmount: optionalNonNegativeInteger(apiData.fee_amount, "fee amount"),
      payableAmount: optionalNonNegativeInteger(apiData.payable_amount, "payable amount"),
      merchantCredit: optionalNonNegativeInteger(apiData.merchant_credit, "merchant credit"),
      cardNumber: typeof apiData.card?.card_number === "string" ? apiData.card.card_number.slice(0, 64) : null,
      cardHolder: typeof apiData.card?.holder_name === "string" ? apiData.card.holder_name.slice(0, 128) : null,
      cardBank: typeof apiData.card?.bank_name === "string" ? apiData.card.bank_name.slice(0, 128) : null,
      paymentUrl,
      expiresAt,
      status: "pending",
      creditLedgerVersion: 2,
    });
  } catch (error) {
    if (uid) {
      try { await apiCancelInvoice(uid); } catch { /* remote cancellation is best effort; never hide the original failure */ }
    }
    throw error;
  }
}
