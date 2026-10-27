/**
 * Wallet-purchase recovery must not be starved by unresolved manual-review orders.
 *
 * recoverWalletPurchases() takes a bounded, oldest-first batch (50). `manual_review` is not terminal: it waits for a human,
 * so an alerted review order is a no-op for recovery. If such orders were re-selected every cycle, 50 or more of them would
 * fill the whole batch and newer recoverable orders (provisioned, undelivered, stalled) would never be reached.
 *
 * Real MongoDB (the selection is a real query, ordering and limit included); unique throwaway database from tests/helpers/db.js.
 */
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

const GROUP = -100555123;
const ADMIN = 9501;
const savedEnv = { ADMINS: process.env.ADMINS, GROUP_ID: process.env.GROUP_ID };
before(() => {
  process.env.ADMINS = String(ADMIN);
  process.env.GROUP_ID = String(GROUP);
});
after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await disconnectTestDB();
});

const dbAvailable = await connectTestDB();
const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let User, WalletPurchase, recoverWalletPurchases, getRecoveryQueue;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ recoverWalletPurchases } = await import("../../services/buyService/purchaseLedger.js"));
  ({ getRecoveryQueue } = await import("../../services/admin/recovery.js"));
}

beforeEach(async () => {
  // Only this file's own unique throwaway database (its name contains "test"; see tests/helpers/db.js).
  if (dbAvailable) await Promise.all([WalletPurchase.collection.deleteMany({}), User.collection.deleteMany({})]);
});

const HOUR = 3_600_000;
const ago = (hours) => new Date(Date.now() - hours * HOUR);
const REVIEW_COUNT = 55; // more than the 50-order recovery batch
let serial = 0;

function base(fields) {
  serial += 1;
  return {
    purchaseId: `starve-${serial}`, telegramId: String(9_100_000 + serial), planId: "mini", planName: "Mini",
    gig: 5, days: 7, amount: 25_000, createdAt: new Date(), walletDebitStatus: "reserved", ...fields,
  };
}
const seedUser = (order, extra = {}) => User.create({ telegramId: order.telegramId, balance: 0, appliedPurchaseReservations: [order.purchaseId], ...extra });
const row = (purchaseId) => WalletPurchase.findOne({ purchaseId }).lean();
const groupMessages = (bot) => bot.sent.filter((entry) => entry.kind === "message" && String(entry.chatId) === String(GROUP));

dbTest("55 alerted manual-review orders do not starve newer recoverable orders; review orders stay untouched and listed", async () => {
  // Oldest first: the review orders would fill the entire batch if they were selected.
  const review = [];
  for (let i = 0; i < REVIEW_COUNT; i += 1) {
    review.push(base({
      status: "manual_review", errorCode: "PANEL_RESULT_UNKNOWN", recoveryStatus: "required", recoveryReason: "PANEL_RESULT_UNKNOWN",
      createdAt: ago(100 + (REVIEW_COUNT - i)), provisioningStartedAt: ago(100 + (REVIEW_COUNT - i)), adminAlertedAt: ago(90),
    }));
  }
  await WalletPurchase.collection.insertMany(review);

  // Newer, genuinely recoverable work.
  const provisioned = base({
    status: "provisioned", createdAt: ago(20), serviceUsername: "svc_starve_a", serviceHash: "hash_starve-a",
    serviceLink: "https://panel.example.test/sub/a", provisionedAt: ago(20), expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
  });
  const undelivered = base({
    status: "completed", createdAt: ago(21), completedAt: ago(21), notificationPending: true, walletDebitStatus: "finalized",
    serviceUsername: "svc_starve_b", serviceHash: "hash_starve-b", serviceLink: "https://panel.example.test/sub/b",
  });
  const stalled = base({ status: "provisioning", createdAt: ago(22), provisioningStartedAt: ago(1), adminAlertedAt: null });
  const unalertedReview = base({ status: "manual_review", errorCode: "PANEL_RESULT_UNKNOWN", createdAt: ago(23), provisioningStartedAt: ago(23), adminAlertedAt: null });
  await WalletPurchase.collection.insertMany([provisioned, undelivered, stalled, unalertedReview]);
  await seedUser(provisioned);
  await seedUser(undelivered, { services: [{ username: "svc_starve_b", purchaseId: undelivered.purchaseId }], completedPurchaseIds: [undelivered.purchaseId] });
  await seedUser(stalled);
  await seedUser(unalertedReview);

  const bot = makeBotStub();
  await recoverWalletPurchases(bot);

  // 1. Eligible newer work was reached and processed.
  assert.equal((await row(provisioned.purchaseId)).status, "completed", "provisioned order is committed");
  assert.equal((await User.findOne({ telegramId: provisioned.telegramId }).lean()).services.length, 1);
  assert.equal((await row(undelivered.purchaseId)).notificationPending, false, "undelivered service is delivered");
  assert.ok(bot.sent.filter((entry) => entry.kind === "photo").length >= 2, "both services were sent to their owners");
  assert.equal((await row(stalled.purchaseId)).status, "manual_review", "a stalled provisioning order is moved to manual review");
  assert.equal((await row(unalertedReview.purchaseId)).adminAlertedAt != null, true, "an UNALERTED review order is still processed once");
  const alerts = groupMessages(bot);
  assert.equal(alerts.length, 2, "exactly the two newly-surfaced orders are alerted, no review order is re-alerted");
  assert.ok(alerts.every((alert) => !review.some((order) => alert.text.includes(`<code>${order.purchaseId}</code>`))), "ids are matched exactly (starve-5 is a prefix of starve-57)");

  // 2. The already-alerted review orders are exactly as they were: status, audit fields, no claim left behind.
  const after = await WalletPurchase.find({ purchaseId: { $in: review.map((order) => order.purchaseId) } }).lean();
  assert.equal(after.length, REVIEW_COUNT);
  for (const order of after) {
    assert.equal(order.status, "manual_review");
    assert.equal(order.recoveryStatus, "required");
    assert.equal(order.errorCode, "PANEL_RESULT_UNKNOWN");
    assert.ok(!order.recoveryClaimedAt, "no recovery claim is taken on a review order");
    assert.equal(order.walletDebitStatus, "reserved", "funds stay reserved: no refund, no retry");
  }
  assert.equal(await User.countDocuments({ refundedPurchaseIds: { $exists: true, $ne: [] } }), 0, "nothing was refunded");

  // 3. Review orders remain available to the manual-review workflow (admin recovery queue).
  const queue = await getRecoveryQueue({ actorId: ADMIN, pageSize: 100 });
  assert.ok(queue.counts["provisioning-uncertain"] >= REVIEW_COUNT, JSON.stringify(queue.counts));

  // 4. A second cycle is idempotent: nothing new to alert, nothing changes.
  const second = makeBotStub();
  await recoverWalletPurchases(second);
  assert.equal(groupMessages(second).length, 0);
  assert.equal(second.sent.filter((entry) => entry.kind === "photo").length, 0);
});

dbTest("selection is deterministic: equal creation times are ordered by _id", async () => {
  const sameTime = ago(5);
  const orders = [];
  for (let i = 0; i < 3; i += 1) {
    orders.push(base({ status: "provisioning", createdAt: sameTime, provisioningStartedAt: ago(1), adminAlertedAt: null }));
  }
  await WalletPurchase.collection.insertMany(orders);
  for (const order of orders) await seedUser(order);
  const bot = makeBotStub();
  await recoverWalletPurchases(bot);
  const texts = groupMessages(bot).map((entry) => entry.text);
  const ids = (await WalletPurchase.find({ purchaseId: { $in: orders.map((o) => o.purchaseId) } }).sort({ _id: 1 }).lean()).map((o) => o.purchaseId);
  const alertedOrder = texts.map((text) => ids.find((id) => text.includes(id)));
  assert.deepEqual(alertedOrder, ids, "processed in _id order when createdAt ties");
});
