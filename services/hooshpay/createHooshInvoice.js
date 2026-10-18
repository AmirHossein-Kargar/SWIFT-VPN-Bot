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

function duplicateKey(error) {
  return error?.code === 11000;
}

async function setCreationFailed(model, orderId, now) {
  await model.updateOne(
    { orderId, creationStatus: "creating" },
    {
      $set: { creationStatus: "creation_failed", recoveryStatus: "none", recoveryReason: null },
      $unset: { openCreateKey: 1 },
    },
  ).catch(() => {});
}

async function setCreationUnknown(model, orderId, now, uid = null) {
  await model.updateOne(
    { orderId, creationStatus: "creating" },
    {
      $set: {
        creationStatus: "creation_unknown",
        creationUnknownAt: now(),
        recoveryStatus: "required",
        recoveryReason: "provider_creation_outcome_unknown",
        ...(uid ? { uid } : {}),
      },
    },
  ).catch(() => {});
}

/**
 * Create and persist a HooshPay invoice.
 *
 * The local order is written before the provider request. A transport timeout
 * therefore leaves a durable `creation_unknown` record keyed by order_id and
 * blocks an accidental second invoice until it is reconciled.
 */
export async function createHooshInvoice({
  userId,
  amount,
  description = "VPN wallet top-up",
  invoiceModel = HooshPayInvoice,
  createInvoice = apiCreateInvoice,
  cancelInvoice = apiCancelInvoice,
  now = () => new Date(),
} = {}) {
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

  const numericUserId = Number(userId);
  const orderId = `HP-${randomUUID()}`;
  const openCreateKey = `user:${numericUserId}`;
  const callbackUrl = `${webhookBase.replace(/\/+$/, "")}/api/hooshpay/webhook`;

  try {
    await invoiceModel.create({
      orderId,
      userId: numericUserId,
      amount,
      currency: "TOMAN",
      feeMode: "buyer",
      status: "pending",
      creationStatus: "creating",
      openCreateKey,
      creditLedgerVersion: 2,
      createdAt: now(),
    });
  } catch (error) {
    if (duplicateKey(error)) {
      const inFlight = new Error("A HooshPay invoice creation is already unresolved for this user");
      inFlight.code = "in_flight";
      throw inFlight;
    }
    throw error;
  }

  await invoiceModel.updateOne(
    { orderId, creationStatus: "creating" },
    { $set: { apiAttemptedAt: now() } },
  );

  let apiData;
  try {
    apiData = await createInvoice({
      order_id: orderId,
      amount,
      callback_url: callbackUrl,
      fee_mode: "buyer",
      description: String(description).slice(0, 250),
    });
  } catch (error) {
    if (error?.ambiguous) await setCreationUnknown(invoiceModel, orderId, now);
    else await setCreationFailed(invoiceModel, orderId, now);
    throw error;
  }

  let uid = null;
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

    const feeMode = String(apiData.fee_mode ?? "buyer").toLowerCase();
    if (!["seller", "buyer", "split"].includes(feeMode)) throw new Error("HooshPay returned an unsupported fee mode");
    const feePercent = apiData.fee_percent == null ? null : Number(apiData.fee_percent);
    if (feePercent != null && (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100)) {
      throw new Error("HooshPay returned an invalid fee percentage");
    }
    const expiresAt = apiData.expires_at == null ? null : new Date(apiData.expires_at);
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("HooshPay returned an invalid expiry time");

    const invoice = await invoiceModel.findOneAndUpdate(
      { orderId, creationStatus: "creating" },
      {
        $set: {
          uid,
          paymentUrl,
          feeMode,
          feePercent,
          feeAmount: optionalNonNegativeInteger(apiData.fee_amount, "fee amount"),
          payableAmount: optionalNonNegativeInteger(apiData.payable_amount, "payable amount"),
          merchantCredit: optionalNonNegativeInteger(apiData.merchant_credit, "merchant credit"),
          cardNumber: typeof apiData.card?.card_number === "string" ? apiData.card.card_number.slice(0, 64) : null,
          cardHolder: typeof apiData.card?.holder_name === "string" ? apiData.card.holder_name.slice(0, 128) : null,
          cardBank: typeof apiData.card?.bank_name === "string" ? apiData.card.bank_name.slice(0, 128) : null,
          expiresAt,
          creationStatus: "created",
          recoveryStatus: "none",
          recoveryReason: null,
        },
        $unset: { openCreateKey: 1, creationUnknownAt: 1 },
      },
      { new: true },
    );
    if (!invoice) throw new Error("HooshPay invoice creation state changed before it could be persisted");
    return invoice;
  } catch (error) {
    let cancelled = false;
    if (uid) {
      try {
        await cancelInvoice(uid);
        cancelled = true;
      } catch {
        // Cancellation itself can be ambiguous. Keep the order blocked for
        // signed-webhook/admin reconciliation instead of risking a duplicate.
      }
    }
    if (cancelled) await setCreationFailed(invoiceModel, orderId, now);
    else await setCreationUnknown(invoiceModel, orderId, now, uid);
    throw error;
  }
}
