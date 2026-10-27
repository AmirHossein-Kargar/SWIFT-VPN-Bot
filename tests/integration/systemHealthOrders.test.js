/**
 * Order-fulfilment health against a REAL MongoDB (the counts must reflect real documents, null dates and the state
 * machine in models/WalletPurchase.js). Uses the per-file unique throwaway database from tests/helpers/db.js (its name
 * must contain "test"); skipped when MongoDB is unreachable.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

after(async () => { await disconnectTestDB(); });

const dbAvailable = await connectTestDB();
const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let WalletPurchase;
let HEALTH_CHECKERS;
let getSystemHealth;
let resetHealthCacheForTests;
if (dbAvailable) {
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ HEALTH_CHECKERS, getSystemHealth, resetHealthCacheForTests } = await import("../../services/admin/monitoring.js"));
}

beforeEach(async () => {
  if (dbAvailable) await WalletPurchase.collection.deleteMany({}); // the unique throwaway database of this file only
});

const MIN = 60_000;
const ago = (minutes) => new Date(Date.now() - minutes * MIN);
let serial = 0;
/** Inserts straight into the collection (the status-transition hook only guards query updates), so fixtures can be any state. */
async function order(fields) {
  serial += 1;
  await WalletPurchase.collection.insertOne({
    purchaseId: `health-${serial}`, telegramId: String(8_000_000 + serial), planId: "mini", planName: "Mini",
    gig: 5, days: 7, amount: 25_000, status: "completed", walletDebitStatus: "finalized", createdAt: new Date(), ...fields,
  });
}
const details = async () => (await HEALTH_CHECKERS.orders()).details;

dbTest("an empty ledger is healthy with zero counts", async () => {
  const result = await HEALTH_CHECKERS.orders();
  assert.equal(result.status, "healthy");
  assert.equal(result.error, null);
  assert.deepEqual(result.details, {
    awaitingProvider: 0, needsReview: 0, refundPending: 0, stalledProvisioning: 0, ledgerStalled: 0, deliveryPending: 0, alertPending: 0, oldestAwaitingMinutes: null,
  });
});

dbTest("normal in-progress and terminal orders are never reported as stalled or failed", async () => {
  await order({ status: "reserving", createdAt: ago(1) });
  await order({ status: "reserved", createdAt: ago(1) });
  await order({ status: "provisioning", provisioningStartedAt: ago(1), createdAt: ago(1) });
  await order({ status: "provisioned", provisionedAt: ago(1), createdAt: ago(1) });
  await order({ status: "completed", notificationPending: true, completedAt: new Date() }); // delivery is seconds away
  await order({ status: "completed", notificationPending: false, completedAt: ago(500) });
  await order({ status: "refund_pending", refundStatus: "pending", refundRequestedAt: new Date(), createdAt: ago(900) }); // old order, refund just started
  await order({ status: "refunded", refundStatus: "completed" });
  await order({ status: "failed" });
  // An admin approval of an old reserved order: provisioning measured from the claim, not from creation.
  await order({ status: "provisioning", provisioningStartedAt: new Date(), createdAt: ago(5000) });

  const result = await HEALTH_CHECKERS.orders();
  assert.equal(result.status, "healthy", result.error);
  assert.deepEqual(result.details, {
    awaitingProvider: 0, needsReview: 0, refundPending: 0, stalledProvisioning: 0, ledgerStalled: 0, deliveryPending: 0, alertPending: 0, oldestAwaitingMinutes: null,
  });
});

dbTest("each backlog kind is counted once, from real documents, and degrades (never downs) the check", async () => {
  await order({ status: "awaiting_provider", walletDebitStatus: "reserved", awaitingProviderSince: ago(60), adminAlertPending: true });
  await order({ status: "awaiting_provider", walletDebitStatus: "reserved", awaitingProviderSince: ago(5), adminAlertPending: false });
  await order({ status: "manual_review", walletDebitStatus: "reserved" });
  await order({ status: "uncertain", walletDebitStatus: "reserved" });
  await order({ status: "refund_pending", refundStatus: "pending", refundRequestedAt: ago(30) });
  await order({ status: "provisioning", provisioningStartedAt: ago(30) });
  await order({ status: "reserved", createdAt: ago(30) });
  await order({ status: "provisioned", provisionedAt: ago(30) });
  await order({ status: "completed", notificationPending: true, completedAt: ago(30) });

  const result = await HEALTH_CHECKERS.orders();
  assert.equal(result.status, "degraded");
  assert.deepEqual({ ...result.details, oldestAwaitingMinutes: undefined }, {
    awaitingProvider: 2, needsReview: 2, refundPending: 1, stalledProvisioning: 1, ledgerStalled: 2, deliveryPending: 1, alertPending: 1, oldestAwaitingMinutes: undefined,
  });
  assert.ok(result.details.oldestAwaitingMinutes >= 59 && result.details.oldestAwaitingMinutes <= 62);
  // Every seeded problem order is counted exactly once; the only overlap is alertPending within awaitingProvider.
  const disjoint = result.details.awaitingProvider + result.details.needsReview + result.details.refundPending
    + result.details.stalledProvisioning + result.details.ledgerStalled + result.details.deliveryPending;
  assert.equal(disjoint, await WalletPurchase.countDocuments({}), "no order is counted in two categories");
  assert.ok(result.details.alertPending <= result.details.awaitingProvider);
  for (const phrase of [/reconciliation/, /stuck in provisioning/, /ledger step/, /refund/, /WizardXray funds/, /alert/, /not delivered/]) assert.match(result.error, phrase);
  assert.equal(/health-\d|8000\d{3}/.test(JSON.stringify(result)), false, "no order or customer identifiers leak");
});

dbTest("null or missing dates fall back to createdAt instead of hiding a stuck order", async () => {
  await order({ status: "provisioning", provisioningStartedAt: null, createdAt: ago(60) }); // stuck, marker missing
  await order({ status: "provisioning", provisioningStartedAt: null, createdAt: ago(1) }); // brand new, marker missing
  await order({ status: "completed", notificationPending: true, createdAt: ago(60) }); // completedAt field absent entirely
  await order({ status: "completed", notificationPending: true, createdAt: ago(1) }); // delivery still within its grace
  await order({ status: "refund_pending", refundStatus: "pending", createdAt: ago(60) }); // legacy row without refundRequestedAt
  await order({ status: "provisioned", createdAt: ago(60) }); // provisionedAt absent

  const d = await details();
  assert.equal(d.stalledProvisioning, 1);
  assert.equal(d.deliveryPending, 1);
  assert.equal(d.refundPending, 1);
  assert.equal(d.ledgerStalled, 1);
});

dbTest("the oldest-waiting age ignores an order whose date is missing instead of reporting null", async () => {
  await order({ status: "awaiting_provider", walletDebitStatus: "reserved" }); // no awaitingProviderSince at all
  await order({ status: "awaiting_provider", walletDebitStatus: "reserved", awaitingProviderSince: ago(120) });
  const d = await details();
  assert.equal(d.awaitingProvider, 2);
  assert.ok(d.oldestAwaitingMinutes >= 119 && d.oldestAwaitingMinutes <= 122, String(d.oldestAwaitingMinutes));
});

dbTest("a fresh alert is not 'undelivered' yet, a stale one is, and alertPending is a subset of awaitingProvider", async () => {
  await order({ status: "awaiting_provider", awaitingProviderSince: new Date(), adminAlertPending: true });
  assert.equal((await details()).alertPending, 0);
  await order({ status: "awaiting_provider", awaitingProviderSince: ago(10), adminAlertPending: true });
  const d = await details();
  assert.equal(d.alertPending, 1);
  assert.equal(d.awaitingProvider, 2);
});

dbTest("the refund intent written by the ledger carries refundRequestedAt so a live refund is not flagged", async () => {
  const { default: User } = await import("../../models/User.js");
  const { refundPurchaseReservation } = await import("../../services/buyService/purchaseLedger.js");
  await User.create({ telegramId: "8100001", balance: 0, appliedPurchaseReservations: ["rr-1"] });
  await order({ purchaseId: "rr-1", telegramId: "8100001", status: "awaiting_provider", walletDebitStatus: "reserved", awaitingProviderSince: ago(5), createdAt: ago(600) });
  const before = Date.now();
  await refundPurchaseReservation({ purchaseId: "rr-1", telegramId: "8100001", amount: 25_000 }, { allowAwaitingProvider: true, reason: "TEST" });
  const row = await WalletPurchase.findOne({ purchaseId: "rr-1" }).lean();
  assert.equal(row.status, "refunded");
  assert.ok(row.refundRequestedAt.getTime() >= before - 1000);
});

dbTest("the aggregate endpoint keeps the existing checks and reports orders without making overall 'down'", async () => {
  process.env.ADMINS = "9401";
  await order({ status: "awaiting_provider", awaitingProviderSince: ago(5), adminAlertPending: false });
  resetHealthCacheForTests();
  const health = await getSystemHealth({ actorId: 9401, fresh: true });
  const orders = health.services.find((service) => service.name === "orders");
  assert.equal(orders.status, "degraded");
  const mongo = health.services.find((service) => service.name === "mongodb");
  assert.equal(mongo.status, "healthy", "the real MongoDB check still works");
  assert.ok(health.services.some((service) => service.name === "redis"));
  const critical = health.services.filter((service) => ["mongodb", "redis", "telegram"].includes(service.name) && service.status === "down");
  assert.equal(health.overall === "down", critical.length > 0);
});
