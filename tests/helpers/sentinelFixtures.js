/**
 * Plain bundles for the Sentinel rule and ledger tests. Identifiers are obviously fake; records are what
 * services/sentinel/bundle.js produces, so the rules are tested against the shape they really receive.
 */
import { normalizeOrder, normalizePayment } from "../../services/sentinel/bundle.js";
import { readSentinelConfig } from "../../services/sentinel/constants.js";

export const NOW = new Date("2026-11-01T12:00:00.000Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const USER = "700000001";
export const ago = (ms) => new Date(NOW.getTime() - ms);
export const config = readSentinelConfig({ SENTINEL_LEDGER_EPOCH: "2026-10-05T00:00:00.000Z" });
export const ctx = { now: NOW, config };

export function hoosh(uid, overrides = {}) {
  return normalizePayment("hooshpay", {
    uid, orderId: `order-${uid}`, userId: Number(USER), amount: 100_000, status: "paid", fulfilled: true, fulfilledAt: ago(3 * HOUR),
    balanceCredited: true, balanceCreditedAt: ago(3 * HOUR), paidAt: ago(3 * HOUR), creditLedgerVersion: 2, createdAt: ago(4 * HOUR),
    recoveryStatus: "none", ...overrides,
  });
}

export function nowPayment(orderId, overrides = {}) {
  return normalizePayment("nowpayments", {
    orderId, userId: Number(USER), amountToman: 200_000, status: "finished", balanceCredited: true, balanceCreditedAt: ago(3 * HOUR), paidAt: ago(3 * HOUR),
    creditLedgerVersion: 2, createdAt: ago(4 * HOUR), updatedAt: ago(3 * HOUR), payCurrency: "trx", payAmount: 10, actuallyPaid: 10, recoveryStatus: "none", ...overrides,
  });
}

export function bank(paymentId, overrides = {}) {
  return normalizePayment("bank", { paymentId, userId: Number(USER), amount: 50_000, status: "confirmed", balanceCredited: true, balanceCreditedAt: ago(3 * HOUR), confirmedAt: ago(3 * HOUR), creditLedgerVersion: 2, createdAt: ago(4 * HOUR), ...overrides });
}

export function order(purchaseId, overrides = {}) {
  return normalizeOrder({
    purchaseId, telegramId: USER, planId: "plan-a", planName: "Plan A", gig: 10, days: 30, amount: 60_000, status: "completed",
    walletDebitStatus: "finalized", reservedAt: ago(2 * HOUR), provisioningStartedAt: ago(2 * HOUR), provisionedAt: ago(2 * HOUR), completedAt: ago(2 * HOUR),
    serviceUsername: `svc-${purchaseId}`, refundStatus: "none", recoveryStatus: "none", events: [], createdAt: ago(2 * HOUR), ...overrides,
  }, config);
}

export function audit(operationId, overrides = {}) {
  return {
    id: `a-${operationId}`, operationId, action: "USER_BALANCE_ADDED", status: "succeeded", amount: 5_000, direction: "add",
    userId: USER, actor: "424242", createdAt: ago(HOUR), legacy: false, ...overrides,
  };
}

/** A customer whose records and ledger agree. Pass records; keys and the balance are derived unless overridden. */
export function bundle({ payments = [], orders = [], audits = [], tombstones = [], foreignPayments = [], foreignOrders = [], foreignTracking = [], user = {}, truncated = false } = {}) {
  const appliedPaymentKeys = payments.filter((item) => item.credited).map((item) => item.creditKey);
  const appliedPurchaseReservations = orders.filter((item) => item.status !== "failed").map((item) => item.purchaseId);
  const refundedPurchaseIds = orders.filter((item) => item.status === "refunded").map((item) => item.purchaseId);
  const completedPurchaseIds = orders.filter((item) => item.status === "completed").map((item) => item.purchaseId);
  const appliedAdminBalanceKeys = audits.filter((item) => item.status === "succeeded").map((item) => item.operationId);
  const services = orders.filter((item) => item.status === "completed").map((item) => ({ purchaseId: item.purchaseId, username: item.serviceUsername, productId: item.planId }));
  const balance = payments.filter((item) => item.credited).reduce((sum, item) => sum + item.amount, 0)
    - orders.filter((item) => item.status !== "failed").reduce((sum, item) => sum + item.amount, 0)
    + orders.filter((item) => item.status === "refunded").reduce((sum, item) => sum + item.amount, 0)
    + audits.filter((item) => item.status === "succeeded").reduce((sum, item) => sum + (item.direction === "add" ? item.amount : -item.amount), 0);
  return {
    userId: USER,
    payments,
    orders,
    audits,
    tombstones,
    foreignPayments,
    foreignOrders,
    foreignTracking,
    truncated,
    user: {
      telegramId: USER,
      balance,
      successfulPayments: appliedPaymentKeys.length,
      appliedPaymentKeys,
      appliedPurchaseReservations,
      refundedPurchaseIds,
      completedPurchaseIds,
      appliedAdminBalanceKeys,
      services,
      createdAt: ago(240 * HOUR),
      ...user,
    },
  };
}
