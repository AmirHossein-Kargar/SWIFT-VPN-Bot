const CURRENCIES = new Set(["TOMAN", "TOMANS", "IRT"]);

export const HOOSH_TERMINAL_NONPAYABLE = Object.freeze(["expired", "cancelled", "failed"]);
export const HOOSH_REVERSAL_STATUSES = Object.freeze(["reversed", "refunded", "chargedback"]);

export function normalizeHooshStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "canceled") return "cancelled";
  if (HOOSH_REVERSAL_STATUSES.includes(status)) return "reversed";
  return status;
}

export function hooshProviderData(result) {
  if (result?.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    return { ...result, ...result.data };
  }
  return result && typeof result === "object" && !Array.isArray(result) ? result : {};
}

function safeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Compare provider-confirmed paid data with the immutable local invoice. Paid
 * payloads must carry amount and identity; optional fee fields are checked when
 * both the creation response and confirmation expose them.
 */
export function validateHooshPaidDetails(invoice, result, {
  requireUid = true,
  requireOrderId = true,
  requireCurrency = false,
} = {}) {
  const data = hooshProviderData(result);
  const providerUid = data.invoice ?? data.uid;
  const providerOrderId = data.order_id ?? data.orderId;

  if (requireUid && (providerUid == null || providerUid === "")) return "missing_invoice_uid";
  if (providerUid != null && invoice.uid != null && String(providerUid) !== String(invoice.uid)) return "invoice_uid_mismatch";
  if (requireOrderId && (providerOrderId == null || providerOrderId === "")) return "missing_order_id";
  if (providerOrderId != null && String(providerOrderId) !== String(invoice.orderId)) return "order_id_mismatch";

  const amount = safeNonNegativeInteger(data.amount);
  if (amount == null) return "missing_or_invalid_amount";
  if (amount !== Number(invoice.amount)) return "amount_mismatch";

  if (requireCurrency && data.currency == null) return "missing_currency";
  if (data.currency != null && !CURRENCIES.has(String(data.currency).trim().toUpperCase())) return "currency_mismatch";
  if (data.payable_amount != null) {
    const payable = safeNonNegativeInteger(data.payable_amount);
    if (payable == null) return "invalid_payable_amount";
    if (invoice.payableAmount != null && payable !== Number(invoice.payableAmount)) return "payable_amount_mismatch";
  }
  if (data.merchant_credit != null) {
    const credit = safeNonNegativeInteger(data.merchant_credit);
    const expected = invoice.merchantCredit == null ? Number(invoice.amount) : Number(invoice.merchantCredit);
    if (credit == null || credit !== expected) return "merchant_credit_mismatch";
  }
  if (data.fee_amount != null) {
    const fee = safeNonNegativeInteger(data.fee_amount);
    if (fee == null) return "invalid_fee_amount";
    if (invoice.feeAmount != null && fee !== Number(invoice.feeAmount)) return "fee_amount_mismatch";
  }
  if (data.fee_mode != null && String(data.fee_mode).trim().toLowerCase() !== String(invoice.feeMode || "buyer").toLowerCase()) {
    return "fee_mode_mismatch";
  }
  if (data.tracking_code != null && (typeof data.tracking_code !== "string" || data.tracking_code.length > 128)) {
    return "invalid_tracking_code";
  }
  if (data.paid_at != null && (typeof data.paid_at !== "string" || Number.isNaN(new Date(data.paid_at).getTime()))) {
    return "invalid_paid_at";
  }
  return null;
}

export default {
  normalizeHooshStatus,
  hooshProviderData,
  validateHooshPaidDetails,
  HOOSH_TERMINAL_NONPAYABLE,
  HOOSH_REVERSAL_STATUSES,
};
