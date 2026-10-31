/** Balance reconstruction, exposure without double counting, the lifecycle projection and the wallet history. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addToman, computeExposure, ledgerSets, reconstructBalance, walletEntries, wholeToman } from "../../services/sentinel/ledger.js";
import { maskId, maskSubject, orderEvents, orderFlow, paymentEvents, paymentFlow, relationships } from "../../services/sentinel/projection.js";
import { HOUR, ago, audit, bundle, hoosh, nowPayment, order } from "../helpers/sentinelFixtures.js";

describe("reconstructBalance", () => {
  test("credits, debits, refunds and admin adjustments add up exactly", () => {
    const value = bundle({
      payments: [hoosh("r1"), nowPayment("r2")],
      orders: [order("r3"), order("r4", { status: "refunded", walletDebitStatus: "refunded", refundedAt: ago(HOUR), completedAt: null })],
      audits: [audit("op-add-0000000001", { amount: 7_000 }), audit("op-rem-0000000001", { action: "USER_BALANCE_REMOVED", direction: "remove", amount: 2_000 })],
    });
    const result = reconstructBalance(value);
    assert.equal(result.expected, 100_000 + 200_000 - 60_000 - 60_000 + 60_000 + 7_000 - 2_000);
    assert.equal(result.drift, 0);
    assert.equal(result.coverage, "complete");
  });

  test("an unresolved key makes coverage partial and contributes nothing invented", () => {
    const result = reconstructBalance(bundle({ user: { appliedPaymentKeys: ["hooshpay:ghost"], balance: 0, successfulPayments: 1 } }));
    assert.equal(result.expected, 0);
    assert.equal(result.coverage, "partial");
    assert.deepEqual(result.unresolved, [{ kind: "payment", key: "hooshpay:ghost" }]);
  });

  test("legacy records count as inferred and the result is partial", () => {
    const legacyPayment = hoosh("r5", { creditLedgerVersion: undefined, createdAt: new Date("2026-02-01T00:00:00Z") });
    const legacyOrder = order("r6", { createdAt: new Date("2026-02-02T00:00:00Z") });
    const value = bundle({ payments: [legacyPayment], orders: [legacyOrder], user: { appliedPaymentKeys: [], appliedPurchaseReservations: [], balance: 40_000, successfulPayments: 1 } });
    const result = reconstructBalance(value);
    assert.equal(result.totals.inferredCredits, 100_000);
    assert.equal(result.totals.inferredDebits, 60_000);
    assert.equal(result.drift, 0);
    assert.equal(result.coverage, "partial");
  });

  test("a counter beyond the ledger means credits the ledger never saw", () => {
    const result = reconstructBalance(bundle({ user: { successfulPayments: 3 } }));
    assert.equal(result.uncountedCredits, 3);
    assert.equal(result.coverage, "partial");
  });

  test("a truncated load is never called complete", () => {
    assert.equal(reconstructBalance(bundle({ truncated: true })).coverage, "partial");
  });

  test("arithmetic stays in whole Toman and refuses to leave the safe range", () => {
    assert.equal(wholeToman(10.5), null);
    assert.equal(wholeToman("12"), 12);
    assert.throws(() => addToman(Number.MAX_SAFE_INTEGER, 1), RangeError);
  });
});

describe("computeExposure", () => {
  const base = { userId: "1", classification: "confirmed", review: "new", direction: "owed_to_customer" };

  test("two findings about one payment count once", () => {
    const result = computeExposure([
      { ...base, code: "A", impactKey: "hooshpay:x", fingerprint: "1", amountToman: 100 },
      { ...base, code: "B", impactKey: "hooshpay:x", fingerprint: "2", amountToman: 100 },
    ]);
    assert.equal(result.owedToCustomers, 100);
  });

  test("a drift and the records explaining it are the same money", () => {
    const result = computeExposure([
      { ...base, code: "CONFIRMED_NOT_CREDITED", impactKey: "hooshpay:x", fingerprint: "1", amountToman: 100 },
      { ...base, code: "CONFIRMED_NOT_CREDITED", impactKey: "hooshpay:y", fingerprint: "2", amountToman: 50 },
      { ...base, code: "BALANCE_DRIFT", impactKey: "user:1", fingerprint: "3", amountToman: 150 },
    ]);
    assert.equal(result.owedToCustomers, 150);
    assert.equal(result.affectedUsers, 1);
  });

  test("an unexplained part of a drift still counts", () => {
    const result = computeExposure([
      { ...base, code: "CONFIRMED_NOT_CREDITED", impactKey: "hooshpay:x", fingerprint: "1", amountToman: 100 },
      { ...base, code: "BALANCE_DRIFT", impactKey: "user:1", fingerprint: "2", amountToman: 400 },
    ]);
    assert.equal(result.owedToCustomers, 400);
  });

  test("directions, customers, dismissed and informational findings stay apart", () => {
    const result = computeExposure([
      { ...base, code: "A", impactKey: "a", fingerprint: "1", amountToman: 100 },
      { ...base, userId: "2", direction: "excess_in_wallet", code: "B", impactKey: "b", fingerprint: "2", amountToman: 30 },
      { ...base, userId: "3", classification: "informational", code: "C", impactKey: "c", fingerprint: "3", amountToman: 999 },
      { ...base, userId: "4", review: "false_positive", code: "D", impactKey: "d", fingerprint: "4", amountToman: 999 },
      { ...base, userId: "5", direction: "held", code: "E", impactKey: "e", fingerprint: "5", amountToman: 999 },
    ]);
    assert.deepEqual(result, { owedToCustomers: 100, excessInWallets: 30, affectedUsers: 2 });
  });
});

describe("projection", () => {
  test("events exist only for timestamps that exist", () => {
    const pending = hoosh("p1", { status: "pending", paidAt: null, balanceCredited: false, balanceCreditedAt: null, fulfilled: false });
    assert.deepEqual(paymentEvents(pending).map((event) => event.stage), ["initiated"]);
    assert.deepEqual(paymentEvents(hoosh("p2")).map((event) => event.stage), ["initiated", "confirmed", "credited"]);
    assert.deepEqual(orderEvents(order("p3", { provisioningStartedAt: null })).map((event) => event.stage), ["reserved", "fulfilled"]);
  });

  test("every event id is stable and names its source field", () => {
    const [first, second] = [paymentEvents(hoosh("p4")), paymentEvents(hoosh("p4"))];
    assert.deepEqual(first.map((event) => event.id), second.map((event) => event.id));
    assert.ok(first.every((event) => event.source.includes(".")));
    assert.ok(first.every((event) => event.basis === "recorded"));
  });

  test("a top-up flow shows pending, failed and contradiction honestly", () => {
    const ledger = ledgerSets({ appliedPaymentKeys: [] });
    const unconfirmed = paymentFlow(hoosh("p5", { status: "pending", paidAt: null, balanceCredited: false, balanceCreditedAt: null }), ledger);
    assert.deepEqual(unconfirmed.map((item) => item.state), ["done", "pending", "pending"]);
    const expired = paymentFlow(hoosh("p6", { status: "expired", paidAt: null, balanceCredited: false, balanceCreditedAt: null }), ledger);
    assert.deepEqual(expired.map((item) => item.state), ["done", "failed", "skipped"]);
    const claim = paymentFlow(hoosh("p7"), ledger);
    assert.equal(claim[2].state, "contradiction");
  });

  test("an order that was refunded ends at the refund and is not shown as fulfilled", () => {
    const refunded = order("p8", { status: "refunded", refundedAt: ago(HOUR), refundRequestedAt: ago(HOUR), completedAt: null });
    const flow = orderFlow(refunded, ledgerSets({ appliedPurchaseReservations: ["p8"], refundedPurchaseIds: ["p8"] }));
    assert.deepEqual(flow.map((item) => item.stage), ["reserved", "provisioning", "refund_requested", "refunded"]);
    assert.ok(flow.every((item) => item.state === "done"));
  });

  test("a wallet is fungible: the only payment-to-order link is inferred", () => {
    const payment = nowPayment("p9", { planId: "plan-a", balanceCreditedAt: ago(3 * HOUR) });
    const purchase = order("p10", { createdAt: ago(2 * HOUR) });
    const value = bundle({ payments: [payment], orders: [purchase] });
    const edges = relationships(purchase, value);
    const hint = edges.find((edge) => edge.type === "likely_funded_by");
    assert.equal(hint.basis, "inferred");
    assert.ok(edges.filter((edge) => edge.type !== "likely_funded_by").every((edge) => edge.basis !== "inferred"));
  });

  test("identifiers are masked", () => {
    assert.equal(maskId("700000001"), "70••••01");
    assert.equal(maskId("123"), "••••");
    assert.equal(maskSubject("user:700000001:counter"), "user:70••••01:counter");
  });
});

describe("walletEntries", () => {
  test("a running balance appears only when the reconstruction is complete and clean", () => {
    const clean = bundle({ payments: [hoosh("w1")], orders: [order("w2")] });
    const entries = walletEntries(clean);
    assert.deepEqual(entries.map((item) => item.delta), [100_000, -60_000]);
    assert.deepEqual(entries.map((item) => item.balanceAfter), [100_000, 40_000]);
    const drifted = bundle({ payments: [hoosh("w3")], user: { balance: 1 } });
    assert.ok(walletEntries(drifted).every((item) => item.balanceAfter === null));
  });
});
