/**
 * refundRequestedAt is the age of a refund measured from its FIRST request. Retries (recovery re-enters
 * refundPurchaseReservation every cycle) must not reset it, or System Health's "refunds pending" would flap.
 * Real MongoDB; unique throwaway database from tests/helpers/db.js.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

after(async () => { await disconnectTestDB(); });

const dbAvailable = await connectTestDB();
const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let User, WalletPurchase, refundPurchaseReservation;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ refundPurchaseReservation } = await import("../../services/buyService/purchaseLedger.js"));
}

let serial = 0;
async function setup({ credited = true, status = "reserved", extra = {} } = {}) {
  serial += 1;
  const purchaseId = `rr-${serial}`;
  const telegramId = String(9_300_000 + serial);
  await User.create({ telegramId, balance: 0, appliedPurchaseReservations: credited ? [purchaseId] : [] });
  await WalletPurchase.collection.insertOne({
    purchaseId, telegramId, planId: "mini", planName: "Mini", gig: 5, days: 7, amount: 25_000, status,
    walletDebitStatus: "reserved", createdAt: new Date(Date.now() - 3600_000), ...extra,
  });
  return { purchaseId, telegramId, purchase: { purchaseId, telegramId, amount: 25_000 } };
}
const row = (purchaseId) => WalletPurchase.findOne({ purchaseId }).lean();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

dbTest("the first refund request stamps refundRequestedAt", async () => {
  const { purchaseId, purchase } = await setup();
  const before = Date.now();
  const result = await refundPurchaseReservation(purchase, { reason: "TEST" });
  assert.equal(result.refunded, true);
  const stored = await row(purchaseId);
  assert.equal(stored.status, "refunded");
  assert.ok(stored.refundRequestedAt.getTime() >= before - 1000 && stored.refundRequestedAt.getTime() <= Date.now());
});

dbTest("retries of a stuck refund keep the FIRST timestamp, and so does its eventual completion", async () => {
  const { purchaseId, telegramId, purchase } = await setup({ credited: false }); // wallet ledger key missing: the credit cannot apply
  await assert.rejects(() => refundPurchaseReservation(purchase, { reason: "TEST" }), (error) => error.code === "REFUND_NOT_APPLIED");
  const first = (await row(purchaseId)).refundRequestedAt;
  assert.ok(first instanceof Date);
  assert.equal((await row(purchaseId)).status, "refund_pending");

  await pause(30);
  await assert.rejects(() => refundPurchaseReservation(purchase, { reason: "TEST" }), (error) => error.code === "REFUND_NOT_APPLIED");
  await pause(30);
  await assert.rejects(() => refundPurchaseReservation(purchase, { reason: "RETRY_AGAIN" }), (error) => error.code === "REFUND_NOT_APPLIED");
  assert.equal((await row(purchaseId)).refundRequestedAt.getTime(), first.getTime(), "retries do not reset the age");

  // Operator repairs the ledger key; the next retry completes the SAME refund lifecycle.
  await User.updateOne({ telegramId }, { $addToSet: { appliedPurchaseReservations: purchaseId } });
  const done = await refundPurchaseReservation(purchase, { reason: "TEST" });
  assert.equal(done.refunded, true);
  const stored = await row(purchaseId);
  assert.equal(stored.status, "refunded");
  assert.equal(stored.refundRequestedAt.getTime(), first.getTime(), "completion keeps the first request time");
  assert.equal((await User.findOne({ telegramId }).lean()).balance, 25_000, "credited exactly once");
});

dbTest("a legacy refund_pending row without the timestamp gets one on its first retry, then keeps it", async () => {
  const { purchaseId, telegramId, purchase } = await setup({
    credited: false, status: "refund_pending", extra: { refundStatus: "pending", refundAmount: 25_000, refundReason: "LEGACY" },
  });
  assert.equal((await row(purchaseId)).refundRequestedAt ?? null, null);
  await assert.rejects(() => refundPurchaseReservation(purchase, { reason: "LEGACY" }), (error) => error.code === "REFUND_NOT_APPLIED");
  const stamped = (await row(purchaseId)).refundRequestedAt;
  assert.ok(stamped instanceof Date);
  await pause(20);
  await assert.rejects(() => refundPurchaseReservation(purchase, { reason: "LEGACY" }), (error) => error.code === "REFUND_NOT_APPLIED");
  assert.equal((await row(purchaseId)).refundRequestedAt.getTime(), stamped.getTime());
  void telegramId;
});

dbTest("concurrent first requests stamp once, and a refunded order can never start a second lifecycle", async () => {
  const { purchaseId, purchase } = await setup();
  const results = await Promise.all([1, 2, 3, 4].map(() => refundPurchaseReservation(purchase, { reason: "TEST" }).catch((error) => ({ error: error.code }))));
  assert.ok(results.some((result) => result.refunded === true));
  const stored = await row(purchaseId);
  assert.equal(stored.status, "refunded");
  const stamp = stored.refundRequestedAt.getTime();
  // Terminal: a later request is a replay, not a new refund and not a new timestamp.
  const replay = await refundPurchaseReservation(purchase, { reason: "AGAIN" });
  assert.equal(replay.alreadyRefunded, true);
  assert.equal((await row(purchaseId)).refundRequestedAt.getTime(), stamp);
  assert.equal((await User.findOne({ telegramId: purchase.telegramId }).lean()).balance, 25_000, "never credited twice");
});
