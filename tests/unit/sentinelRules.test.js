/** Every Sentinel detection rule against plain bundles: what it must raise, and what it must leave alone. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateBundle } from "../../services/sentinel/rules.js";
import { explainFinding, explainedCodes } from "../../services/sentinel/explain.js";
import { FINDING_CATALOG, readSentinelConfig, REPEATED_CALLBACK_MIN } from "../../services/sentinel/constants.js";
import { HOUR, MIN, USER, ago, audit, bank, bundle, ctx, hoosh, nowPayment, order } from "../helpers/sentinelFixtures.js";

const codes = (value) => evaluateBundle(value, ctx).map((finding) => finding.code).sort();
const only = (value, code) => {
  const found = evaluateBundle(value, ctx).filter((finding) => finding.code === code);
  assert.equal(found.length, 1, `expected exactly one ${code}, got ${JSON.stringify(evaluateBundle(value, ctx).map((item) => item.code))}`);
  return found[0];
};

describe("healthy money raises nothing", () => {
  test("credited payments, a fulfilled order, a refunded order and an admin credit agree", () => {
    const value = bundle({
      payments: [hoosh("h1"), nowPayment("np1"), bank("b1")],
      orders: [order("o1"), order("o2", { status: "refunded", walletDebitStatus: "refunded", refundStatus: "completed", refundAmount: 60_000, refundedAt: ago(HOUR), completedAt: null })],
      audits: [audit("op-add-0000000001")],
    });
    assert.deepEqual(codes(value), []);
  });

  test("an order that never debited, and a failed payment, are not problems", () => {
    const value = bundle({
      payments: [hoosh("h2", { status: "expired", fulfilled: false, balanceCredited: false, balanceCreditedAt: null, paidAt: null })],
      orders: [order("o3", { status: "failed", walletDebitStatus: "not_debited", completedAt: null })],
    });
    assert.deepEqual(codes(value), []);
  });

  test("a brand-new payment inside the grace period waits", () => {
    const value = bundle({ payments: [hoosh("h3", { balanceCredited: false, balanceCreditedAt: null, paidAt: ago(2 * MIN), fulfilledAt: ago(2 * MIN), createdAt: ago(3 * MIN) })] });
    assert.deepEqual(codes(value), []);
  });
});

describe("payment to wallet", () => {
  test("confirmed but not credited", () => {
    const value = bundle({ payments: [hoosh("h4", { balanceCredited: false, balanceCreditedAt: null })] });
    const finding = only(value, "CONFIRMED_NOT_CREDITED");
    assert.equal(finding.classification, "confirmed");
    assert.equal(finding.amountToman, 100_000);
    assert.equal(finding.direction, "owed_to_customer");
  });

  test("the ledger holds the credit but the invoice flag is behind: a pending flag, not a missing credit", () => {
    const value = bundle({ payments: [hoosh("h5", { balanceCredited: false, balanceCreditedAt: null })], user: { appliedPaymentKeys: ["hooshpay:h5"], balance: 100_000, successfulPayments: 1 } });
    assert.deepEqual(codes(value), ["CREDIT_FLAG_PENDING"]);
  });

  test("invoice claims a credit with no ledger entry", () => {
    const value = bundle({ payments: [hoosh("h6")], user: { appliedPaymentKeys: [], balance: 0, successfulPayments: 0 } });
    assert.equal(only(value, "CREDITED_WITHOUT_LEDGER").severity, "critical");
  });

  test("a credit on an unconfirmed payment", () => {
    const value = bundle({ payments: [hoosh("h7", { status: "pending", fulfilled: false, balanceCredited: false, balanceCreditedAt: null, paidAt: null })], user: { appliedPaymentKeys: ["hooshpay:h7"], balance: 100_000, successfulPayments: 1 } });
    assert.equal(only(value, "CREDIT_ON_UNCONFIRMED_PAYMENT").direction, "excess_in_wallet");
  });

  test("a reversal after the credit, unless an admin already resolved it", () => {
    const reversed = bundle({ payments: [hoosh("h8", { status: "reversed", reversedAt: ago(HOUR), recoveryStatus: "required", recoveryReason: "provider_reversal_after_wallet_credit" })] });
    assert.equal(only(reversed, "REVERSED_AFTER_CREDIT").amountToman, 100_000);
    const resolved = bundle({ payments: [hoosh("h9", { status: "reversed", reversedAt: ago(HOUR), recoveryStatus: "resolved" })] });
    assert.deepEqual(codes(resolved), []);
  });

  test("a reversal before any credit is fine", () => {
    const value = bundle({ payments: [hoosh("h10", { status: "reversed", fulfilled: false, balanceCredited: false, balanceCreditedAt: null, reversedAt: ago(HOUR), paidAt: null })] });
    assert.deepEqual(codes(value), []);
  });

  test("a legacy payment is informational and never claims a missing credit", () => {
    const value = bundle({ payments: [hoosh("h11", { balanceCredited: undefined, balanceCreditedAt: null, creditLedgerVersion: undefined, createdAt: ago(9000 * HOUR) })], user: { createdAt: ago(9000 * HOUR) } });
    const findings = evaluateBundle(value, ctx);
    assert.ok(findings.some((item) => item.code === "LEGACY_CREDIT_UNVERIFIABLE" && item.classification === "informational"));
    assert.ok(!findings.some((item) => item.code === "CONFIRMED_NOT_CREDITED"));
  });

  test("late, mismatched and underpaid provider evidence", () => {
    assert.equal(only(bundle({ payments: [nowPayment("np2", { status: "expired", balanceCredited: false, balanceCreditedAt: null, paidAt: null, recoveryStatus: "required", recoveryReason: "payment_after_terminal_status" })] }), "LATE_PAYMENT_UNCREDITED").classification, "probable");
    assert.ok(only(bundle({ payments: [nowPayment("np3", { status: "pending", balanceCredited: false, balanceCreditedAt: null, paidAt: null, recoveryStatus: "required", recoveryReason: "amount_mismatch" })] }), "PROVIDER_EVIDENCE_MISMATCH").observed.includes("amount_mismatch"));
    assert.equal(only(bundle({ payments: [nowPayment("np4", { status: "partially_paid", balanceCredited: false, balanceCreditedAt: null, paidAt: null, actuallyPaid: 4 })] }), "UNDERPAID_PAYMENT").classification, "informational");
    assert.equal(only(bundle({ payments: [nowPayment("np5", { actuallyPaid: 9 })] }), "UNDERPAID_PAYMENT").classification, "probable");
  });

  test("a tombstone that heard about a payment", () => {
    const tombstone = { provider: "hooshpay", key: "hooshpay:gone", creditKeys: ["hooshpay:gone"], userId: USER, amount: 70_000, finalStatus: "cancelled", lateEvents: [{ at: ago(HOUR), status: "paid" }] };
    assert.equal(only(bundle({ tombstones: [tombstone] }), "LATE_PAYMENT_UNCREDITED").amountToman, 70_000);
  });

  test("repeated confirmations are informational, and only from the threshold", () => {
    const callbacks = (count) => ({ webhookLog: Array.from({ length: count }, (_, index) => ({ receivedAt: ago(index * MIN), payload: { status: "paid" } })) });
    assert.deepEqual(codes(bundle({ payments: [hoosh("h12", callbacks(REPEATED_CALLBACK_MIN - 1))] })), []);
    const finding = only(bundle({ payments: [hoosh("h13", callbacks(REPEATED_CALLBACK_MIN))] }), "REPEATED_CALLBACKS");
    assert.equal(finding.classification, "informational");
    assert.equal(finding.amountToman, 0);
  });

  test("one tracking code on two confirmed invoices, for one customer or across customers", () => {
    const same = bundle({ payments: [hoosh("h14", { trackingCode: "TRK-1" }), hoosh("h15", { trackingCode: "TRK-1" })] });
    assert.equal(only(same, "DUPLICATE_PROVIDER_REFERENCE").amountToman, 100_000);
    const other = hoosh("h17", { trackingCode: "TRK-2", userId: 700000002 });
    assert.equal(only(bundle({ payments: [hoosh("h16", { trackingCode: "TRK-2" })], foreignTracking: [other] }), "DUPLICATE_PROVIDER_REFERENCE").refs.length, 3);
  });

  test("stuck payments", () => {
    assert.equal(only(bundle({ payments: [nowPayment("np6", { status: "creation_unknown", balanceCredited: false, balanceCreditedAt: null, paidAt: null, createdAt: ago(2 * HOUR) })] }), "PAYMENT_STUCK").classification, "probable");
    assert.equal(only(bundle({ payments: [nowPayment("np7", { status: "confirming", balanceCredited: false, balanceCreditedAt: null, paidAt: null, updatedAt: ago(30 * HOUR), createdAt: ago(40 * HOUR) })] }), "PAYMENT_STUCK").classification, "informational");
    assert.equal(only(bundle({ payments: [bank("b2", { status: "waiting_for_approval", balanceCredited: false, balanceCreditedAt: null, confirmedAt: null, createdAt: ago(30 * HOUR) })] }), "PAYMENT_STUCK").severity, "low");
  });

  test("a contradiction inside one invoice", () => {
    assert.ok(codes(bundle({ payments: [hoosh("h18", { status: "failed", fulfilled: false, balanceCredited: true })], user: { appliedPaymentKeys: [], balance: 0, successfulPayments: 0 } })).includes("PAYMENT_STATE_CONTRADICTION"));
    assert.ok(codes(bundle({ payments: [hoosh("h19", { status: "paid", fulfilled: false })] })).includes("PAYMENT_STATE_CONTRADICTION"));
  });
});

describe("wallet ledger", () => {
  test("a ledger key nothing explains, and one for a removed invoice", () => {
    assert.equal(only(bundle({ user: { appliedPaymentKeys: ["hooshpay:ghost"], balance: 0, successfulPayments: 1 } }), "LEDGER_KEY_WITHOUT_PAYMENT").classification, "probable");
    const tombstone = { provider: "hooshpay", key: "hooshpay:gone2", creditKeys: ["hooshpay:gone2"], userId: USER, amount: 10_000, finalStatus: "failed", lateEvents: [] };
    assert.equal(only(bundle({ tombstones: [tombstone], user: { appliedPaymentKeys: ["hooshpay:gone2"], balance: 0, successfulPayments: 1 } }), "CREDIT_ON_UNCONFIRMED_PAYMENT").amountToman, 10_000);
  });

  test("a key naming another customer's record", () => {
    const foreign = hoosh("h20", { userId: 700000002 });
    assert.equal(only(bundle({ foreignPayments: [foreign], user: { appliedPaymentKeys: ["hooshpay:h20"], balance: 100_000, successfulPayments: 1 } }), "KEY_OWNER_MISMATCH").severity, "critical");
    const foreignOrder = order("o20", { telegramId: "700000002" });
    assert.ok(codes(bundle({ foreignOrders: [foreignOrder], user: { appliedPurchaseReservations: ["o20"], balance: -60_000 } })).includes("KEY_OWNER_MISMATCH"));
  });

  test("a key applied twice", () => {
    assert.ok(codes(bundle({ payments: [hoosh("h21")], user: { appliedPaymentKeys: ["hooshpay:h21", "hooshpay:h21"], balance: 100_000, successfulPayments: 2 } })).includes("DUPLICATE_LEDGER_KEY"));
  });

  test("admin adjustments must match their audit", () => {
    assert.ok(codes(bundle({ user: { appliedAdminBalanceKeys: ["op-missing-000001"] } })).includes("ADMIN_KEY_WITHOUT_AUDIT"));
    assert.ok(codes(bundle({ audits: [audit("op-failed-000001", { status: "failed" })], user: { appliedAdminBalanceKeys: ["op-failed-000001"], balance: 5_000 } })).includes("ADMIN_AUDIT_OUTCOME_MISMATCH"));
    assert.ok(codes(bundle({ audits: [audit("op-keyless-00001")], user: { appliedAdminBalanceKeys: [], balance: 0 } })).includes("ADMIN_AUDIT_OUTCOME_MISMATCH"));
  });

  test("balance drift on a fully ledgered customer is confirmed, with the exact difference", () => {
    const finding = only(bundle({ payments: [hoosh("h22")], user: { balance: 130_000 } }), "BALANCE_DRIFT");
    assert.equal(finding.classification, "confirmed");
    assert.equal(finding.amountToman, 30_000);
    assert.equal(finding.direction, "excess_in_wallet");
    assert.equal(finding.expectedToman, 100_000);
    assert.equal(finding.observedToman, 130_000);
  });

  test("drift on a pre-ledger customer stays informational", () => {
    const finding = only(bundle({ user: { balance: 40_000, createdAt: new Date("2026-01-01T00:00:00Z") } }), "BALANCE_DRIFT");
    assert.equal(finding.classification, "informational");
    assert.equal(finding.severity, "info");
  });

  test("unresolved keys make drift probable, not confirmed", () => {
    const finding = only(bundle({ user: { appliedPaymentKeys: ["hooshpay:ghost2"], balance: 90_000, successfulPayments: 1 } }), "BALANCE_DRIFT");
    assert.equal(finding.classification, "probable");
    assert.equal(finding.facts.coverage, "partial");
  });

  test("negative and non-integer balances", () => {
    assert.ok(codes(bundle({ user: { balance: -1 } })).includes("NEGATIVE_BALANCE"));
    assert.deepEqual(codes(bundle({ user: { balance: 10.5 } })), ["INVALID_BALANCE"]);
  });

  test("the payment counter behind the ledger", () => {
    assert.ok(codes(bundle({ payments: [hoosh("h23")], user: { successfulPayments: 0 } })).includes("PAYMENT_COUNTER_MISMATCH"));
  });
});

describe("orders and refunds", () => {
  test("an order claiming a debit the ledger lacks; legacy orders are exempt", () => {
    assert.equal(only(bundle({ orders: [order("o4")], user: { appliedPurchaseReservations: [], balance: 0 } }), "RESERVATION_MISSING").severity, "critical");
    const legacy = order("o5", { createdAt: new Date("2026-01-01T00:00:00Z") });
    assert.ok(!codes(bundle({ orders: [legacy], user: { appliedPurchaseReservations: [], balance: -60_000 } })).includes("RESERVATION_MISSING"));
  });

  test("a ledger debit or refund with no order", () => {
    assert.ok(codes(bundle({ user: { appliedPurchaseReservations: ["nope"], balance: 0 } })).includes("RESERVATION_WITHOUT_ORDER"));
    assert.ok(codes(bundle({ user: { refundedPurchaseIds: ["nope2"], balance: 0 } })).includes("REFUND_WITHOUT_ORDER"));
  });

  test("a failed order that kept the money", () => {
    const value = bundle({ orders: [order("o6", { status: "failed", walletDebitStatus: "reserved", completedAt: null })], user: { appliedPurchaseReservations: ["o6"], balance: -60_000 } });
    assert.equal(only(value, "FAILED_ORDER_DEBIT_KEPT").direction, "owed_to_customer");
  });

  test("a refund on record but not in the wallet", () => {
    const value = bundle({ orders: [order("o7", { status: "refunded", walletDebitStatus: "refunded", refundStatus: "completed", refundAmount: 60_000, refundedAt: ago(HOUR), completedAt: null })], user: { refundedPurchaseIds: [], balance: -60_000 } });
    assert.equal(only(value, "REFUND_WITHOUT_LEDGER").severity, "critical");
  });

  test("a refund in the wallet with the order behind", () => {
    const value = bundle({ orders: [order("o8", { status: "refund_pending", walletDebitStatus: "reserved", refundStatus: "pending", refundAmount: 60_000, refundRequestedAt: ago(2 * HOUR), completedAt: null })], user: { refundedPurchaseIds: ["o8"], balance: 0 } });
    assert.deepEqual(codes(value), ["REFUND_RECORD_PENDING"]);
  });

  test("refunded and fulfilled at once", () => {
    assert.equal(only(bundle({ orders: [order("o9")], user: { refundedPurchaseIds: ["o9"], balance: 0 } }), "REFUNDED_AND_FULFILLED").severity, "critical");
  });

  test("a refund on an order in another state", () => {
    const value = bundle({ orders: [order("o10", { status: "provisioning", walletDebitStatus: "reserved", completedAt: null })], user: { refundedPurchaseIds: ["o10"], balance: 0 } });
    assert.ok(codes(value).includes("REFUND_CONTRADICTS_ORDER"));
  });

  test("a refund of the wrong amount", () => {
    const finding = only(bundle({ orders: [order("o11", { status: "refunded", walletDebitStatus: "refunded", refundStatus: "completed", refundAmount: 90_000, refundedAt: ago(HOUR), completedAt: null })] }), "REFUND_AMOUNT_MISMATCH");
    assert.equal(finding.amountToman, 30_000);
    assert.equal(finding.direction, "excess_in_wallet");
  });

  test("a refund with no debit", () => {
    const value = bundle({ orders: [order("o12", { status: "refunded", walletDebitStatus: "refunded", refundStatus: "completed", refundAmount: 60_000, refundedAt: ago(HOUR), completedAt: null })], user: { appliedPurchaseReservations: [], balance: 60_000 } });
    assert.ok(codes(value).includes("REFUND_WITHOUT_DEBIT"));
  });

  test("a completed order with no delivered service", () => {
    assert.equal(only(bundle({ orders: [order("o13")], user: { services: [] } }), "COMPLETED_NOT_COMMITTED").direction, "owed_to_customer");
    assert.equal(only(bundle({ orders: [order("o14")], user: { completedPurchaseIds: [] } }), "COMPLETED_NOT_COMMITTED").code, "COMPLETED_NOT_COMMITTED");
  });

  test("a debit label that disagrees with the state", () => {
    assert.equal(only(bundle({ orders: [order("o15", { walletDebitStatus: "reserved" })] }), "DEBIT_STATUS_MISMATCH").amountToman, 0);
  });

  test("one order with two services; a service with no order; trial services are not orders", () => {
    assert.ok(codes(bundle({ orders: [order("o16")], user: { services: [{ purchaseId: "o16", productId: "p" }, { purchaseId: "o16", productId: "p" }] } })).includes("DUPLICATE_SERVICE_FOR_ORDER"));
    assert.deepEqual(codes(bundle({ user: { services: [{ purchaseId: "missing", productId: "p" }] } })), ["SERVICE_WITHOUT_ORDER"]);
    assert.deepEqual(codes(bundle({ user: { services: [{ purchaseId: "trial-attempt" }] } })), []);
  });

  test("stuck orders, held debits and waiting orders", () => {
    assert.equal(only(bundle({ orders: [order("o17", { status: "reserved", walletDebitStatus: "reserved", completedAt: null, createdAt: ago(2 * HOUR) })] }), "ORDER_STUCK").direction, "held");
    assert.equal(only(bundle({ orders: [order("o18", { status: "manual_review", walletDebitStatus: "reserved", completedAt: null, errorCode: "PANEL_RESULT_UNKNOWN" })] }), "ORDER_NEEDS_REVIEW").severity, "high");
    assert.equal(only(bundle({ orders: [order("o19", { status: "awaiting_provider", walletDebitStatus: "reserved", completedAt: null, awaitingProviderSince: ago(30 * HOUR) })] }), "ORDER_AWAITING_PROVIDER").classification, "informational");
    assert.deepEqual(codes(bundle({ payments: [hoosh("h30")], orders: [order("o21", { status: "awaiting_provider", walletDebitStatus: "reserved", completedAt: null, awaitingProviderSince: ago(2 * HOUR) })] })), []);
  });

  test("a state change the schema forbids", () => {
    const value = bundle({ orders: [order("o22", { events: [{ at: ago(HOUR), type: "weird", from: "completed", to: "provisioning" }] })] });
    assert.equal(only(value, "IMPOSSIBLE_TRANSITION").observed, "completed → provisioning");
  });
});

describe("resilience and identity", () => {
  test("money records for a missing user are reported, not crashed on", () => {
    const value = { ...bundle({ payments: [hoosh("h24", { balanceCredited: false, balanceCreditedAt: null })] }), user: null };
    const [finding] = evaluateBundle(value, ctx);
    assert.equal(finding.code, "CONFIRMED_NOT_CREDITED");
    assert.equal(finding.facts.ownerMissing, true);
  });

  test("the same problem always has the same fingerprint, so a rerun cannot raise a second alert", () => {
    const value = bundle({ payments: [hoosh("h25", { balanceCredited: false, balanceCreditedAt: null })] });
    assert.deepEqual(evaluateBundle(value, ctx).map((item) => item.fingerprint), evaluateBundle(value, { ...ctx, now: new Date(ctx.now.getTime() + 5 * HOUR) }).map((item) => item.fingerprint));
  });

  test("thresholds follow configuration, and bad values fall back", () => {
    const value = bundle({ payments: [hoosh("h26", { balanceCredited: false, balanceCreditedAt: null })] });
    const patient = { now: ctx.now, config: { ...ctx.config, stuckMs: 24 * HOUR } };
    assert.deepEqual(evaluateBundle(value, patient).filter((item) => item.code === "CONFIRMED_NOT_CREDITED"), []);
    assert.equal(readSentinelConfig({ SENTINEL_STUCK_MINUTES: "-5" }).stuckMs, 30 * MIN);
    assert.equal(readSentinelConfig({ SENTINEL_INTERVAL_SECONDS: "1" }).intervalMs, 120_000);
    assert.equal(readSentinelConfig({ SENTINEL_ENABLED: "off" }).enabled, false);
    assert.equal(readSentinelConfig({ SENTINEL_LEDGER_EPOCH: "nonsense" }).ledgerEpoch.toISOString(), "2026-10-05T00:00:00.000Z");
  });

  test("findings hold no links, cards or addresses", () => {
    const value = bundle({ payments: [hoosh("h27", { balanceCredited: false, balanceCreditedAt: null })] });
    const text = JSON.stringify(evaluateBundle(value, ctx));
    assert.doesNotMatch(text, /https?:\/\//);
  });

  test("every catalog code explains itself and offers a way forward", () => {
    assert.deepEqual(explainedCodes().sort(), Object.keys(FINDING_CATALOG).sort());
    for (const code of Object.keys(FINDING_CATALOG)) {
      const explanation = explainFinding({ code, subjectKey: "hooshpay:x", userId: USER, amountToman: 1, classification: "probable", direction: "owed_to_customer" });
      assert.ok(explanation.why && explanation.likelyCause, `${code} is missing its explanation`);
      assert.ok(explanation.options.length > 0, `${code} offers no option`);
      for (const option of explanation.options) assert.match(option.id, /^[a-z_]{1,40}$/);
    }
  });
});
