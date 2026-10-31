/**
 * Read-only projection: turns stored records into the lifecycle a person can follow. Pure.
 *
 * Nothing is invented. An event exists only when its timestamp exists, and each one names the field it came from. A step
 * with no evidence is "unknown" or "pending", never a guessed time. The lifecycle differs by record: a top-up ends at the
 * wallet, an order starts there, and a wallet is fungible, so no single payment can be proven to have paid for a single
 * order. The two meet at the wallet and only there. The only inferred link is flagged as inferred.
 */
import { PAYMENT_PROVIDERS } from "./constants.js";
import { ledgerSets, wholeToman } from "./ledger.js";

export function maskId(id) {
  const text = String(id ?? "");
  if (!text) return null;
  if (text.length <= 4) return "••••";
  return `${text.slice(0, 2)}••••${text.slice(-2)}`;
}

export function maskSubject(key) {
  return String(key ?? "").replace(/user:(\d+)/g, (_match, id) => `user:${maskId(id)}`);
}

const MODEL_NAME = { hooshpay: "HooshPayInvoice", nowpayments: "NowPaymentsInvoice", bank: "invoice", trx: "CryptoInvoice" };
const event = (record, stage, at, source, extra = {}) => (at ? {
  id: `${record.key}#${stage}`,
  key: record.key,
  kind: record.purchaseId ? "order" : "payment",
  provider: record.provider || "wallet",
  stage,
  at: new Date(at).toISOString(),
  amount: wholeToman(record.amount),
  currency: "Toman",
  user: maskId(record.userId),
  status: record.status,
  source,
  basis: "recorded",
  ...extra,
} : null);

export function paymentEvents(payment) {
  const model = MODEL_NAME[payment.provider];
  return [
    event(payment, "initiated", payment.createdAt, `${model}.createdAt`),
    event(payment, "confirmed", payment.confirmedAt, payment.provider === "bank" ? `${model}.confirmedAt` : `${model}.paidAt`),
    event(payment, "credited", payment.creditedAt, `${model}.balanceCreditedAt`),
    event(payment, "reversed", payment.reversedAt, payment.provider === "hooshpay" ? `${model}.reversedAt` : `${model}.updatedAt`),
    event(payment, "failed", payment.rejectedAt, `${model}.rejectedAt`),
  ].filter(Boolean);
}

export function orderEvents(order) {
  return [
    event(order, "reserved", order.reservedAt, "WalletPurchase.reservedAt"),
    event(order, "provisioning", order.provisioningStartedAt, "WalletPurchase.provisioningStartedAt"),
    event(order, "awaiting_provider", order.awaitingProviderSince, "WalletPurchase.awaitingProviderSince"),
    event(order, "fulfilled", order.completedAt, "WalletPurchase.completedAt"),
    event(order, "refund_requested", order.refundRequestedAt, "WalletPurchase.refundRequestedAt"),
    event(order, "refunded", order.refundedAt, "WalletPurchase.refundedAt"),
  ].filter(Boolean);
}

const stage = (name, state, at, source, detail = null) => ({ stage: name, state, at: at ? new Date(at).toISOString() : null, source, detail, basis: "recorded" });

/** The ordered lifecycle of one top-up. `state`: done, pending, failed, skipped or contradiction. */
export function paymentFlow(payment, ledger) {
  const model = MODEL_NAME[payment.provider];
  const keyed = payment.creditKey != null && ledger.payment.has(payment.creditKey);
  const closed = !payment.confirmed && !payment.reversed && ["expired", "cancelled", "failed", "rejected", "creation_failed"].includes(payment.status);
  const everConfirmed = payment.confirmed || (payment.reversed && (payment.confirmedAt || payment.credited));
  const flow = [stage("initiated", "done", payment.createdAt, `${model}.createdAt`)];
  flow.push(stage(
    "confirmed",
    everConfirmed ? "done" : closed ? "failed" : "pending",
    payment.confirmedAt,
    `${model}.status`,
    `Provider status: ${payment.status}`,
  ));
  let creditState = "pending";
  if (keyed && (payment.credited || !everConfirmed)) creditState = everConfirmed ? "done" : "contradiction";
  else if (keyed) creditState = "done";
  else if (payment.credited) creditState = payment.ledgerVersion === 2 ? "contradiction" : "done";
  else if (closed) creditState = "skipped";
  const detail = keyed
    ? `Ledger entry present (appliedPaymentKeys); invoice flag ${payment.credited ? "set" : "not set"}`
    : `No ledger entry; invoice flag ${payment.credited ? "set" : "not set"}${payment.ledgerVersion !== 2 && payment.credited ? " (predates the ledger)" : ""}`;
  flow.push(stage("credited", creditState, payment.creditedAt, "User.appliedPaymentKeys", detail));
  if (payment.reversed) {
    flow.push(stage("reversed", "done", payment.reversedAt, `${model}.status`, keyed || payment.credited ? "The wallet still holds this amount" : "Closed before any credit"));
  }
  return flow;
}

/** The ordered lifecycle of one order. */
export function orderFlow(order, ledger) {
  const reserved = ledger.reservation.has(order.purchaseId);
  const refunded = ledger.refund.has(order.purchaseId);
  const failed = order.status === "failed";
  const flow = [stage(
    "reserved",
    reserved ? "done" : order.legacy && ["completed", "refunded"].includes(order.status) ? "done" : failed ? "skipped" : "pending",
    order.reservedAt,
    "User.appliedPurchaseReservations",
    reserved ? "Ledger entry present" : order.legacy ? "Predates the ledger" : "No ledger entry",
  )];
  if (order.provisioningStartedAt) flow.push(stage("provisioning", "done", order.provisioningStartedAt, "WalletPurchase.provisioningStartedAt"));
  if (order.awaitingProviderSince) {
    flow.push(stage("awaiting_provider", order.status === "awaiting_provider" ? "pending" : "done", order.awaitingProviderSince, "WalletPurchase.awaitingProviderSince", "Provider wallet short of funds"));
  }
  const refunding = refunded || ["refund_pending", "refunded"].includes(order.status);
  if (refunding) {
    flow.push(stage("refund_requested", "done", order.refundRequestedAt, "WalletPurchase.refundStatus", order.refundReason ? `Reason: ${order.refundReason}` : null));
    flow.push(stage("refunded", refunded && order.status === "refunded" ? "done" : order.status === "refunded" ? "contradiction" : "pending", order.refundedAt, "User.refundedPurchaseIds", refunded ? "Ledger entry present" : "No ledger entry"));
  }
  if (order.status === "completed" || order.completedAt) {
    flow.push(stage("fulfilled", refunded ? "contradiction" : "done", order.completedAt, "WalletPurchase.completedAt", "Debit finalized: orders are prepaid, so delivery is the consumption"));
  } else if (!refunding) {
    flow.push(stage("fulfilled", failed ? "failed" : "pending", null, "WalletPurchase.status", `Order status: ${order.status}`));
  }
  return flow;
}

/** How this record relates to others, each edge saying whether it is recorded or inferred. */
export function relationships(subject, bundle) {
  const ledger = ledgerSets(bundle.user);
  const edges = [];
  if (subject.purchaseId) {
    const debited = ledger.reservation.has(subject.purchaseId);
    edges.push({
      from: subject.key, to: `wallet:user`, type: "debit", basis: debited ? "recorded" : "absent",
      evidence: debited ? "User.appliedPurchaseReservations holds this order id" : "User.appliedPurchaseReservations does not hold this order id",
    });
    if (ledger.refund.has(subject.purchaseId)) edges.push({ from: `wallet:user`, to: subject.key, type: "refund", basis: "recorded", evidence: "User.refundedPurchaseIds holds this order id" });
    for (const payment of bundle.payments) {
      if (payment.planId && payment.planId === subject.planId && payment.credited) {
        const gap = new Date(subject.createdAt) - new Date(payment.creditedAt);
        if (gap >= 0 && gap <= 24 * 60 * 60_000) {
          edges.push({ from: payment.key, to: subject.key, type: "likely_funded_by", basis: "inferred", evidence: "Same plan, credited within 24 hours before this order. A wallet is fungible, so this is a hint and not proof." });
        }
      }
    }
  } else {
    const credited = subject.creditKey != null && ledger.payment.has(subject.creditKey);
    edges.push({
      from: subject.key, to: `wallet:user`, type: "credit", basis: credited ? "recorded" : "absent",
      evidence: credited ? "User.appliedPaymentKeys holds this payment's key" : "User.appliedPaymentKeys does not hold this payment's key",
    });
  }
  return edges;
}

export const providerLabel = (provider) => PAYMENT_PROVIDERS[provider]?.label ?? (provider === "wallet" ? "Wallet order" : provider);
