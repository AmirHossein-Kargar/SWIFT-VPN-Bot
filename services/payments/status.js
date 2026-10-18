/**
 * Provider status normalization shared by customer-facing payment history.
 *
 * Provider integrations persist canonical lowercase states, but old deployments
 * may contain title-cased English or Persian labels. Normalize those values at
 * the boundary so legacy rows cannot leak cancelled/expired entries back into
 * the profile.
 */
const LEGACY_STATUS_ALIASES = new Map([
  ["canceled", "cancelled"],
  ["cancel", "cancelled"],
  ["لغو شده", "cancelled"],
  ["لغوشده", "cancelled"],
  ["منقضی شده", "expired"],
  ["منقضی‌شده", "expired"],
]);

export const HIDDEN_RECENT_ORDER_STATUSES = Object.freeze([
  "cancelled",
  "canceled",
  "expired",
  "لغو شده",
  "لغوشده",
  "منقضی شده",
  "منقضی‌شده",
]);

export function normalizePaymentStatus(provider, value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const status = LEGACY_STATUS_ALIASES.get(raw) || raw;

  if (provider === "nowpayments") {
    if (status === "finished") return "paid";
    if (["waiting", "pending", "confirming", "confirmed", "sending", "creating", "creation_unknown"].includes(status)) {
      return "pending";
    }
    if (status === "partially_paid") return "partially_paid";
    if (status === "refunded") return "reversed";
    if (status === "creation_failed") return "failed";
  }
  return status || "unknown";
}

export function isHiddenRecentOrderStatus(provider, value) {
  return ["cancelled", "expired"].includes(normalizePaymentStatus(provider, value));
}

/**
 * MongoDB predicate used before sorting/limiting recent payments. The $nin
 * handles exact legacy values and $not handles case variants such as
 * "Cancelled". Persian aliases are explicitly listed because /i has no effect
 * on those strings.
 */
export function eligibleRecentOrderStatusQuery() {
  return {
    $nin: HIDDEN_RECENT_ORDER_STATUSES,
    $not: /^(?:cancelled|canceled|expired)$/i,
  };
}

export default {
  normalizePaymentStatus,
  isHiddenRecentOrderStatus,
  eligibleRecentOrderStatusQuery,
};
