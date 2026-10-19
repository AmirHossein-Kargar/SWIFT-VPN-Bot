/**
 * Provider status normalization shared by customer-facing payment history.
 *
 * Provider integrations persist canonical lowercase states, but old deployments
 * may contain title-cased English or Persian labels. Normalize those values at
 * the boundary so legacy rows cannot leak cancelled/expired entries back into
 * the profile.
 *
 * Profile policy (display only, nothing is ever deleted):
 *   hidden  - definitively unsuccessful: cancelled, expired, failed, rejected,
 *             creation_failed, plus pending rows older than the active window.
 *   visible - paid / finished, still-active pending, partially_paid, refunded
 *             or reversed, and any row flagged for manual review.
 */
const LEGACY_STATUS_ALIASES = new Map([
  ["canceled", "cancelled"],
  ["cancel", "cancelled"],
  ["لغو شده", "cancelled"],
  ["لغوشده", "cancelled"],
  ["منقضی شده", "expired"],
  ["منقضی‌شده", "expired"],
]);

/** Raw persisted values that are never shown in the customer's order list. */
export const HIDDEN_RECENT_ORDER_STATUSES = Object.freeze([
  "cancelled",
  "canceled",
  "expired",
  "failed",
  "rejected",
  "creation_failed",
  "لغو شده",
  "لغوشده",
  "منقضی شده",
  "منقضی‌شده",
]);

/** Pending-class raw statuses per provider (awaiting payment / settlement). */
export const PENDING_STATUSES = Object.freeze({
  hoosh: ["pending"],
  nowpayments: ["creating", "pending", "waiting", "confirming", "confirmed", "sending"],
  trx: ["unpaid"],
  bank: ["unpaid", "pending", "waiting_for_approval"],
});

/** A pending invoice older than this is considered abandoned and is hidden. */
export const ACTIVE_PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  if (provider === "bank") {
    if (["unpaid", "waiting_for_approval"].includes(status)) return "pending";
    if (status === "confirmed") return "paid";
    if (status === "rejected") return "failed";
  }
  if (provider === "trx") {
    if (status === "unpaid") return "pending";
    if (status === "rejected") return "failed";
  }
  return status || "unknown";
}

/** Definitively unsuccessful by status alone (age is handled separately). */
export function isHiddenRecentOrderStatus(provider, value) {
  return ["cancelled", "expired", "failed"].includes(normalizePaymentStatus(provider, value));
}

/**
 * Whether a persisted row belongs in the customer's recent-order list. This is
 * the in-memory twin of the database predicate and is applied defensively.
 */
export function isVisibleRecentOrder(provider, record, now = Date.now()) {
  if (!record || isHiddenRecentOrderStatus(provider, record.status)) return false;
  if (record.recoveryStatus === "required") return true; // manual review stays visible
  if (normalizePaymentStatus(provider, record.status) !== "pending") return true;
  const created = new Date(record.createdAt || 0).getTime();
  return Number.isFinite(created) && created >= now - ACTIVE_PENDING_WINDOW_MS;
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
    $not: /^(?:cancelled|canceled|expired|failed|rejected|creation_failed)$/i,
  };
}

/**
 * Extra predicate (merge with the status predicate) that drops abandoned
 * pending rows while always keeping rows flagged for manual review.
 */
export function activeWindowQuery(provider, now = Date.now()) {
  const pending = PENDING_STATUSES[provider] || [];
  return {
    $or: [
      { status: { $nin: pending } },
      { createdAt: { $gte: new Date(now - ACTIVE_PENDING_WINDOW_MS) } },
      { recoveryStatus: "required" },
    ],
  };
}

export default {
  normalizePaymentStatus,
  isHiddenRecentOrderStatus,
  isVisibleRecentOrder,
  eligibleRecentOrderStatusQuery,
  activeWindowQuery,
};
