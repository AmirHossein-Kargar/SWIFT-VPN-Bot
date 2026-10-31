/**
 * The wallet ledger as it really exists, and the balance it implies. Pure functions over a loaded bundle.
 *
 * There is no ledger collection. The ledger is five key arrays on the User document, each written in the same atomic
 * update as the balance it changes, so one read of the User is a consistent cut of balance and keys. The arrays hold keys,
 * not amounts; amounts come from the record each key names, and those are immutable once the key exists (the invoice or
 * order is written first). That is why the reconstruction needs no lock and no transaction.
 *
 *   appliedPaymentKeys           + invoice amount         (services/walletCredit.js)
 *   appliedPurchaseReservations  - order amount           (services/buyService/purchaseLedger.js reserveBalance)
 *   refundedPurchaseIds          + order amount           (refundPurchaseReservation)
 *   appliedAdminBalanceKeys      +/- audited amount       (services/admin/users.js changeUserBalance)
 *
 * Records older than the ledger left no keys, so they are counted as INFERRED from their own claims and the result is
 * labelled partial. A partial reconstruction can suggest a difference but never prove one.
 */
import { ORDER_DEBIT_CLAIMING_STATUSES } from "./constants.js";

/** Whole Toman or nothing: a non-integer amount is reported as unusable, never rounded into a total. */
export function wholeToman(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function addToman(total, amount) {
  const sum = total + amount;
  if (!Number.isSafeInteger(sum)) throw new RangeError("Toman total left the safe integer range");
  return sum;
}

const asArray = (value) => (Array.isArray(value) ? value.map(String) : []);

export function ledgerSets(user) {
  const payment = asArray(user?.appliedPaymentKeys);
  const admin = asArray(user?.appliedAdminBalanceKeys);
  const reservation = asArray(user?.appliedPurchaseReservations);
  const refund = asArray(user?.refundedPurchaseIds);
  const completed = asArray(user?.completedPurchaseIds);
  return {
    payment: new Set(payment),
    admin: new Set(admin),
    reservation: new Set(reservation),
    refund: new Set(refund),
    completed: new Set(completed),
    raw: { payment, admin, reservation, refund },
  };
}

export function duplicateKeys(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

/**
 * Rebuild the balance a user should hold.
 * `coverage: "complete"` means every ledger key resolved to an amount and no unkeyed money record exists.
 */
export function reconstructBalance(bundle) {
  const { user, payments, orders, audits, foreignPayments = [], foreignOrders = [] } = bundle;
  const ledger = ledgerSets(user);
  const totals = { credits: 0, debits: 0, refunds: 0, adminAdded: 0, adminRemoved: 0, inferredCredits: 0, inferredDebits: 0, inferredRefunds: 0, inferredAdmin: 0 };
  const counts = { credits: 0, debits: 0, refunds: 0, admin: 0 };
  const unresolved = [];
  const paymentByKey = new Map([...payments, ...foreignPayments].map((payment) => [payment.creditKey, payment]));
  const orderById = new Map([...orders, ...foreignOrders].map((order) => [order.purchaseId, order]));
  const auditById = new Map(audits.map((audit) => [audit.operationId, audit]));

  for (const key of ledger.payment) {
    const payment = paymentByKey.get(key);
    const amount = wholeToman(payment?.amount);
    if (amount == null) { unresolved.push({ kind: "payment", key }); continue; }
    totals.credits = addToman(totals.credits, amount);
    counts.credits += 1;
  }
  for (const purchaseId of ledger.reservation) {
    const amount = wholeToman(orderById.get(purchaseId)?.amount);
    if (amount == null) { unresolved.push({ kind: "reservation", key: purchaseId }); continue; }
    totals.debits = addToman(totals.debits, amount);
    counts.debits += 1;
  }
  for (const purchaseId of ledger.refund) {
    const amount = wholeToman(orderById.get(purchaseId)?.amount);
    if (amount == null) { unresolved.push({ kind: "refund", key: purchaseId }); continue; }
    totals.refunds = addToman(totals.refunds, amount);
    counts.refunds += 1;
  }
  for (const operationId of ledger.admin) {
    const audit = auditById.get(operationId);
    const amount = wholeToman(audit?.amount);
    if (amount == null || !audit?.direction) { unresolved.push({ kind: "admin", key: operationId }); continue; }
    if (audit.direction === "add") totals.adminAdded = addToman(totals.adminAdded, amount);
    else totals.adminRemoved = addToman(totals.adminRemoved, amount);
    counts.admin += 1;
  }

  // Money records from before the ledger existed. They count, but only as what they claim about themselves.
  const unkeyed = { credits: 0, debits: 0, refunds: 0, admin: 0 };
  for (const payment of payments) {
    if (ledger.payment.has(payment.creditKey) || payment.ledgerVersion === 2) continue;
    if (!payment.credited && !payment.confirmed) continue;
    const amount = wholeToman(payment.amount);
    if (amount == null) { unresolved.push({ kind: "legacy_payment", key: payment.key }); continue; }
    totals.inferredCredits = addToman(totals.inferredCredits, amount);
    unkeyed.credits += 1;
  }
  for (const order of orders) {
    if (ledger.reservation.has(order.purchaseId) || !order.legacy) continue;
    if (!ORDER_DEBIT_CLAIMING_STATUSES.includes(order.status)) continue;
    const amount = wholeToman(order.amount);
    if (amount == null) { unresolved.push({ kind: "legacy_order", key: order.key }); continue; }
    totals.inferredDebits = addToman(totals.inferredDebits, amount);
    unkeyed.debits += 1;
    if (order.status === "refunded" && !ledger.refund.has(order.purchaseId)) {
      totals.inferredRefunds = addToman(totals.inferredRefunds, amount);
      unkeyed.refunds += 1;
    }
  }
  for (const audit of audits) {
    if (ledger.admin.has(audit.operationId) || audit.status !== "succeeded" || !audit.legacy) continue;
    const amount = wholeToman(audit.amount);
    if (amount == null) continue;
    totals.inferredAdmin = addToman(totals.inferredAdmin, audit.direction === "add" ? amount : -amount);
    unkeyed.admin += 1;
  }

  const expected = [
    totals.credits, -totals.debits, totals.refunds, totals.adminAdded, -totals.adminRemoved,
    totals.inferredCredits, -totals.inferredDebits, totals.inferredRefunds, totals.inferredAdmin,
  ].reduce(addToman, 0);
  const balance = wholeToman(user?.balance);
  const successfulPayments = wholeToman(user?.successfulPayments) ?? 0;
  const uncountedCredits = Math.max(0, successfulPayments - ledger.raw.payment.length - unkeyed.credits);
  const hasUnkeyed = Object.values(unkeyed).some(Boolean);
  const coverage = unresolved.length || hasUnkeyed || uncountedCredits > 0 || bundle.truncated ? "partial" : "complete";
  return {
    balance,
    expected,
    drift: balance == null ? null : balance - expected,
    coverage,
    totals,
    counts,
    unkeyed,
    uncountedCredits,
    unresolved,
  };
}

/**
 * Exposure of a set of open findings without counting the same money twice.
 *
 * Findings about one payment share an impactKey and count once at their largest amount. A balance drift and the record
 * findings that explain it are the same money seen from two sides, so per customer and direction the larger of the two
 * wins rather than their sum. Findings that are informational or dismissed carry no exposure.
 */
export function computeExposure(findings) {
  const users = new Map();
  for (const finding of findings) {
    const amount = wholeToman(finding.amountToman);
    if (!amount || amount <= 0 || finding.classification === "informational" || finding.review === "false_positive") continue;
    if (!["owed_to_customer", "excess_in_wallet"].includes(finding.direction)) continue;
    const user = users.get(finding.userId) || { owed_to_customer: new Map(), excess_in_wallet: new Map(), drift: { owed_to_customer: 0, excess_in_wallet: 0 } };
    users.set(finding.userId, user);
    if (finding.code === "BALANCE_DRIFT") {
      user.drift[finding.direction] = Math.max(user.drift[finding.direction], amount);
    } else {
      const key = finding.impactKey || finding.fingerprint;
      user[finding.direction].set(key, Math.max(user[finding.direction].get(key) || 0, amount));
    }
  }
  const out = { owedToCustomers: 0, excessInWallets: 0, affectedUsers: users.size };
  const sum = (map) => [...map.values()].reduce(addToman, 0);
  for (const user of users.values()) {
    out.owedToCustomers = addToman(out.owedToCustomers, Math.max(sum(user.owed_to_customer), user.drift.owed_to_customer));
    out.excessInWallets = addToman(out.excessInWallets, Math.max(sum(user.excess_in_wallet), user.drift.excess_in_wallet));
  }
  return out;
}

/** The customer's wallet movements in time order. A running balance is only stated when the reconstruction is complete. */
export function walletEntries(bundle, reconstruction = reconstructBalance(bundle)) {
  const ledger = ledgerSets(bundle.user);
  const entries = [];
  for (const payment of [...bundle.payments, ...(bundle.foreignPayments || [])]) {
    if (!ledger.payment.has(payment.creditKey)) continue;
    entries.push({ id: `credit:${payment.key}`, type: "credit", at: payment.creditedAt || payment.confirmedAt || payment.createdAt, delta: wholeToman(payment.amount), ref: payment.key, ledgerKey: "appliedPaymentKeys", basis: "recorded" });
  }
  for (const order of [...bundle.orders, ...(bundle.foreignOrders || [])]) {
    if (ledger.reservation.has(order.purchaseId)) {
      entries.push({ id: `debit:${order.key}`, type: "debit", at: order.reservedAt || order.createdAt, delta: -wholeToman(order.amount), ref: order.key, ledgerKey: "appliedPurchaseReservations", basis: "recorded" });
    }
    if (ledger.refund.has(order.purchaseId)) {
      entries.push({ id: `refund:${order.key}`, type: "refund", at: order.refundedAt || order.refundRequestedAt || order.createdAt, delta: wholeToman(order.amount), ref: order.key, ledgerKey: "refundedPurchaseIds", basis: "recorded" });
    }
  }
  for (const audit of bundle.audits) {
    if (!ledger.admin.has(audit.operationId)) continue;
    const amount = wholeToman(audit.amount);
    entries.push({ id: `admin:${audit.id}`, type: audit.direction === "add" ? "admin_credit" : "admin_debit", at: audit.createdAt, delta: audit.direction === "add" ? amount : -amount, ref: `audit:${audit.id}`, ledgerKey: "appliedAdminBalanceKeys", basis: "recorded" });
  }
  entries.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0) || a.id.localeCompare(b.id));
  let running = 0;
  const complete = reconstruction.coverage === "complete" && reconstruction.drift === 0;
  return entries.map((item) => {
    running = addToman(running, item.delta ?? 0);
    return { ...item, balanceAfter: complete ? running : null };
  });
}
