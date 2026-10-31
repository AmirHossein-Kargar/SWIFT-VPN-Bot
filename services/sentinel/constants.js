/**
 * Shared vocabulary of Money Flow Sentinel: providers, thresholds and the catalog of findings.
 * Classification is the strength of the evidence, not a suspicion of fraud:
 *   confirmed     - the records contradict each other; nothing needs to be assumed
 *   probable      - the records point at a problem, but a legitimate explanation is possible
 *   informational - worth knowing, no inconsistency is claimed
 */
export const SENTINEL_JOB = "money-flow-sentinel";
export const RULE_VERSION = 1;
export const DEFAULT_LEDGER_EPOCH = "2026-10-05T00:00:00.000Z";
export const REPEATED_CALLBACK_MIN = 3;

export const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, info: 4 });

/** Every provider's identifying field and how it spells "the provider confirmed this payment". */
export const PAYMENT_PROVIDERS = Object.freeze({
  hooshpay: { label: "HooshPay", refField: "uid", amountField: "amount", ownerField: "userId", confirmed: ["paid"], reversed: ["reversed"] },
  nowpayments: { label: "NOWPayments", refField: "orderId", amountField: "amountToman", ownerField: "userId", confirmed: ["finished"], reversed: ["refunded"] },
  bank: { label: "Bank transfer", refField: "paymentId", amountField: "amount", ownerField: "userId", confirmed: ["confirmed", "paid"], reversed: [] },
  trx: { label: "TRX", refField: "invoiceId", amountField: "amount", ownerField: "userId", confirmed: ["paid"], reversed: [] },
});

export const ORDER_DEBIT_CLAIMING_STATUSES = Object.freeze([
  "reserved", "provisioning", "uncertain", "manual_review", "awaiting_provider", "provisioned", "completed", "refund_pending", "refunded",
]);
export const ORDER_HELD_STATUSES = Object.freeze(["reserved", "provisioning", "uncertain", "manual_review", "awaiting_provider", "provisioned", "refund_pending"]);

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function sentinelEnabled(env = process.env) {
  return String(env.SENTINEL_ENABLED ?? "").trim().toLowerCase() !== "off";
}

/** Out-of-range values fall back to the default: a typo must not turn detection off or make it hammer the database. */
export function readSentinelConfig(env = process.env) {
  const epoch = new Date(env.SENTINEL_LEDGER_EPOCH || DEFAULT_LEDGER_EPOCH);
  return {
    enabled: sentinelEnabled(env),
    intervalMs: boundedInt(env.SENTINEL_INTERVAL_SECONDS, 120, 30, 3600) * 1000,
    usersPerTick: boundedInt(env.SENTINEL_USERS_PER_TICK, 100, 10, 2000),
    graceMs: boundedInt(env.SENTINEL_GRACE_MINUTES, 15, 1, 1440) * MINUTE,
    stuckMs: boundedInt(env.SENTINEL_STUCK_MINUTES, 30, 5, 10_080) * MINUTE,
    awaitingProviderMs: boundedInt(env.SENTINEL_AWAITING_PROVIDER_HOURS, 24, 1, 720) * HOUR,
    ledgerEpoch: Number.isNaN(epoch.getTime()) ? new Date(DEFAULT_LEDGER_EPOCH) : epoch,
  };
}

const entry = (category, classification, severity, title) => Object.freeze({ category, classification, severity, title });

export const FINDING_CATALOG = Object.freeze({
  // Payment to wallet
  CONFIRMED_NOT_CREDITED: entry("payment", "confirmed", "high", "Confirmed payment without a wallet credit"),
  CREDIT_FLAG_PENDING: entry("payment", "probable", "low", "Wallet credited, invoice completion pending"),
  CREDITED_WITHOUT_LEDGER: entry("payment", "confirmed", "critical", "Invoice claims a credit the ledger does not hold"),
  CREDIT_ON_UNCONFIRMED_PAYMENT: entry("payment", "confirmed", "critical", "Wallet credited for an unconfirmed payment"),
  LEGACY_CREDIT_UNVERIFIABLE: entry("payment", "informational", "info", "Confirmed legacy payment with no ledger evidence"),
  REVERSED_AFTER_CREDIT: entry("refund", "confirmed", "high", "Provider reversed a payment the wallet still holds"),
  LATE_PAYMENT_UNCREDITED: entry("payment", "probable", "medium", "Payment reported after the invoice was closed"),
  PROVIDER_EVIDENCE_MISMATCH: entry("payment", "probable", "medium", "Provider callback disagrees with the stored invoice"),
  UNDERPAID_PAYMENT: entry("payment", "probable", "medium", "Provider reports less than the invoice amount"),
  DUPLICATE_PROVIDER_REFERENCE: entry("payment", "probable", "high", "One provider reference settled several invoices"),
  REPEATED_CALLBACKS: entry("payment", "informational", "info", "Provider repeated its confirmation"),
  PAYMENT_STUCK: entry("stuck", "probable", "medium", "Payment stuck in an intermediate state"),
  PAYMENT_STATE_CONTRADICTION: entry("transition", "confirmed", "medium", "Invoice fields contradict each other"),
  // Wallet ledger
  LEDGER_KEY_WITHOUT_PAYMENT: entry("wallet", "probable", "high", "Wallet credit without a supporting payment"),
  KEY_OWNER_MISMATCH: entry("wallet", "confirmed", "critical", "Ledger entry belongs to another customer's record"),
  DUPLICATE_LEDGER_KEY: entry("wallet", "confirmed", "critical", "Ledger entry applied more than once"),
  BALANCE_DRIFT: entry("wallet", "confirmed", "high", "Balance differs from the ledger"),
  NEGATIVE_BALANCE: entry("wallet", "confirmed", "critical", "Negative wallet balance"),
  INVALID_BALANCE: entry("wallet", "confirmed", "critical", "Wallet balance is not a whole Toman amount"),
  ADMIN_KEY_WITHOUT_AUDIT: entry("wallet", "confirmed", "high", "Admin adjustment without an audit record"),
  ADMIN_AUDIT_OUTCOME_MISMATCH: entry("wallet", "probable", "medium", "Admin adjustment and its audit record disagree"),
  PAYMENT_COUNTER_MISMATCH: entry("wallet", "probable", "low", "Payment counter is behind the ledger"),
  // Order reservation and fulfilment
  RESERVATION_MISSING: entry("order", "confirmed", "critical", "Order claims a wallet debit the ledger does not hold"),
  RESERVATION_WITHOUT_ORDER: entry("order", "confirmed", "high", "Wallet debit without an order"),
  DEBIT_NOT_RECORDED_ON_ORDER: entry("order", "probable", "medium", "Wallet debited, order does not show it"),
  FAILED_ORDER_DEBIT_KEPT: entry("order", "confirmed", "critical", "Failed order kept the customer's money"),
  COMPLETED_NOT_COMMITTED: entry("order", "confirmed", "high", "Completed order without a delivered service"),
  DEBIT_STATUS_MISMATCH: entry("order", "confirmed", "low", "Order debit status disagrees with its state"),
  DUPLICATE_SERVICE_FOR_ORDER: entry("order", "confirmed", "high", "One order delivered several services"),
  SERVICE_WITHOUT_ORDER: entry("order", "probable", "medium", "Service without a matching order"),
  ORDER_STUCK: entry("stuck", "probable", "medium", "Order stuck in an intermediate state"),
  ORDER_NEEDS_REVIEW: entry("stuck", "probable", "high", "Debit held on an ambiguous provider result"),
  ORDER_AWAITING_PROVIDER: entry("stuck", "informational", "medium", "Order waiting for provider funds"),
  IMPOSSIBLE_TRANSITION: entry("transition", "confirmed", "high", "Impossible order state change"),
  // Refunds
  REFUND_WITHOUT_LEDGER: entry("refund", "confirmed", "critical", "Refund recorded but not applied to the wallet"),
  REFUND_RECORD_PENDING: entry("refund", "probable", "medium", "Refund applied, order completion pending"),
  REFUNDED_AND_FULFILLED: entry("refund", "confirmed", "critical", "Order both refunded and fulfilled"),
  REFUND_CONTRADICTS_ORDER: entry("refund", "confirmed", "high", "Refund applied to an order in another state"),
  REFUND_AMOUNT_MISMATCH: entry("refund", "confirmed", "high", "Refund amount differs from the debit"),
  REFUND_WITHOUT_DEBIT: entry("refund", "confirmed", "critical", "Refund without a matching debit"),
  REFUND_WITHOUT_ORDER: entry("refund", "confirmed", "high", "Refund without an order"),
});

export function catalogEntry(code) {
  return FINDING_CATALOG[code] || entry("wallet", "informational", "info", code);
}
