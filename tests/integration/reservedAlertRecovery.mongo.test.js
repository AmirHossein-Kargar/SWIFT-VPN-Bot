/**
 * Reserved-order admin alerts under REAL MongoDB: the two review fixes (M-1, M-2).
 *
 * M-1  An order that already had a reserved-order alert must still get an admin alert when an interrupted or ambiguous
 *      approval leaves it in manual_review (previously the earlier alert's `adminAlertedAt` silenced recovery for good).
 * M-2  When the stored alert message was deleted, the outbox must send a replacement instead of failing forever.
 *
 * Unique throwaway database from tests/helpers/db.js (its name contains "test").
 */
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

const GROUP = -100666321;
const ADMIN = 9801;
const savedEnv = { ADMINS: process.env.ADMINS, GROUP_ID: process.env.GROUP_ID };
before(() => { process.env.ADMINS = String(ADMIN); process.env.GROUP_ID = String(GROUP); });
after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await disconnectTestDB();
});

const dbAvailable = await connectTestDB();
const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let User, WalletPurchase, notifyReservedOrder, approveReservedOrder, recoverWalletPurchases;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ notifyReservedOrder } = await import("../../services/buyService/reservedAlerts.js"));
  ({ approveReservedOrder } = await import("../../services/buyService/reservedFulfillment.js"));
  ({ recoverWalletPurchases } = await import("../../services/buyService/purchaseLedger.js"));
}
beforeEach(async () => {
  if (dbAvailable) await Promise.all([WalletPurchase.collection.deleteMany({}), User.collection.deleteMany({})]);
});

const HOUR = 3_600_000;
let n = 0;
async function parkedOrder() {
  n += 1;
  const doc = {
    purchaseId: `alertfix-${n}`, telegramId: String(9_800_000 + n), planId: "mini", planName: "Mini", gig: 5, days: 7, amount: 25_000,
    status: "awaiting_provider", walletDebitStatus: "reserved", createdAt: new Date(Date.now() - HOUR), awaitingProviderSince: new Date(Date.now() - HOUR),
    adminAlertPending: true, adminAlertAttempts: 0, adminAlertClaimedAt: null, adminAlertNextAt: null, adminAlertedAt: null,
  };
  await WalletPurchase.collection.insertOne(doc);
  await User.create({ telegramId: doc.telegramId, balance: 0, appliedPurchaseReservations: [doc.purchaseId] });
  const stored = await WalletPurchase.findOne({ purchaseId: doc.purchaseId }).lean();
  return { ...doc, ref: String(stored._id) };
}
const row = (purchaseId) => WalletPurchase.findOne({ purchaseId }).lean();
const groupMessages = (bot) => bot.sent.filter((entry) => entry.kind === "message" && String(entry.chatId) === String(GROUP));
const alertsFor = (bot, purchaseId) => groupMessages(bot).filter((entry) => entry.text.includes(`<code>${purchaseId}</code>`));
const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForStatus(purchaseId, status) {
  for (let i = 0; i < 200; i += 1) {
    if ((await row(purchaseId)).status === status) return;
    await settle(10);
  }
  throw new Error(`order never reached ${status}`);
}

dbTest("M-1: previous reserved alert -> approval interrupted -> manual_review -> exactly one new admin alert", async () => {
  const order = await parkedOrder();
  const firstBot = makeBotStub();
  assert.equal(await notifyReservedOrder(firstBot, order.purchaseId), true);
  const delivered = await row(order.purchaseId);
  assert.ok(delivered.adminAlertedAt, "precondition: the order already had an alert");
  assert.ok(Number.isSafeInteger(delivered.adminAlertMessageId));

  // An admin approves; the process dies while WizardXray is creating the service (the promise never settles).
  const neverSettles = new Promise(() => {});
  void approveReservedOrder({ orderRef: order.ref, adminId: ADMIN, bot: makeBotStub(), createService: () => neverSettles, deliver: async () => true });
  await waitForStatus(order.purchaseId, "provisioning");
  // Restart: the claim is now older than the recovery staleness window.
  await WalletPurchase.updateOne({ purchaseId: order.purchaseId, status: "provisioning" }, { $set: { provisioningStartedAt: new Date(Date.now() - HOUR) } });

  const recoveryBot = makeBotStub();
  await Promise.all([1, 2, 3].map(() => recoverWalletPurchases(recoveryBot))); // duplicate recovery workers
  const after = await row(order.purchaseId);
  assert.equal(after.status, "manual_review", "recovery never replays the provider create; it escalates");
  assert.equal(alertsFor(recoveryBot, order.purchaseId).length, 1, "exactly one new alert despite three concurrent workers");
  assert.ok(after.adminAlertedAt, "the review alert is recorded");
  assert.equal(after.walletDebitStatus, "reserved", "funds stay reserved");

  // Repeated processing is idempotent.
  const again = makeBotStub();
  await recoverWalletPurchases(again);
  assert.equal(alertsFor(again, order.purchaseId).length, 0, "no duplicate alert on the next cycle");

  // Audit trail kept: the earlier alert's message id and the approval event survive.
  assert.equal(after.adminAlertMessageId, delivered.adminAlertMessageId);
  assert.ok(after.events.some((event) => event.type === "admin_approved"));
  assert.equal(after.fulfillmentClaimedBy, String(ADMIN));
});

dbTest("M-1: an ambiguous provider outcome during approval is also escalated by recovery (once), not silenced", async () => {
  const order = await parkedOrder();
  await notifyReservedOrder(makeBotStub(), order.purchaseId);
  const timeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED", ambiguous: true });
  const outcome = await approveReservedOrder({ orderRef: order.ref, adminId: ADMIN, bot: makeBotStub(), createService: async () => { throw timeout; }, deliver: async () => true });
  assert.equal(outcome.outcome, "unknown_outcome");
  assert.equal((await row(order.purchaseId)).status, "manual_review");

  await WalletPurchase.updateOne({ purchaseId: order.purchaseId, status: "manual_review" }, { $set: { provisioningStartedAt: new Date(Date.now() - HOUR) } });
  const bot = makeBotStub();
  await recoverWalletPurchases(bot);
  assert.equal(alertsFor(bot, order.purchaseId).length, 1);
  const next = makeBotStub();
  await recoverWalletPurchases(next);
  assert.equal(alertsFor(next, order.purchaseId).length, 0);
});

dbTest("M-1: a provider that is still short re-parks the order and the outbox re-stamps adminAlertedAt", async () => {
  const order = await parkedOrder();
  const bot = makeBotStub();
  await notifyReservedOrder(bot, order.purchaseId);
  const short = Object.assign(new Error("short"), { code: "provider_insufficient_balance", ambiguous: false });
  const outcome = await approveReservedOrder({ orderRef: order.ref, adminId: ADMIN, bot, createService: async () => { throw short; }, deliver: async () => true });
  assert.equal(outcome.outcome, "still_short");
  const parked = await row(order.purchaseId);
  assert.equal(parked.status, "awaiting_provider");
  assert.equal(parked.adminAlertPending, true);
  assert.equal(await notifyReservedOrder(bot, order.purchaseId), true, "the re-park alert (an edit of the same message) is delivered");
  assert.ok((await row(order.purchaseId)).adminAlertedAt, "adminAlertedAt describes the latest delivered alert again");
});

dbTest("M-1: an order that was never alerted is still escalated exactly as before (no regression)", async () => {
  const order = await parkedOrder();
  await WalletPurchase.updateOne({ purchaseId: order.purchaseId, status: "awaiting_provider" }, { $set: { status: "provisioning", provisioningStartedAt: new Date(Date.now() - HOUR), adminAlertPending: false } });
  const bot = makeBotStub();
  await recoverWalletPurchases(bot);
  assert.equal((await row(order.purchaseId)).status, "manual_review");
  assert.equal(alertsFor(bot, order.purchaseId).length, 1);
});

dbTest("M-2: a deleted alert message is replaced once, the new id is persisted, and concurrent workers do not duplicate it", async () => {
  const order = await parkedOrder();
  const bot = makeBotStub();
  await notifyReservedOrder(bot, order.purchaseId);
  const original = (await row(order.purchaseId)).adminAlertMessageId;

  // The admins delete the message; the order is re-parked with a fresh pending alert.
  bot.editMessageText = async () => { throw Object.assign(new Error("ETELEGRAM: 400 Bad Request: message to edit not found"), { response: { statusCode: 400, body: { description: "Bad Request: message to edit not found" } } }); };
  await WalletPurchase.updateOne({ purchaseId: order.purchaseId, status: "awaiting_provider" }, { $set: { adminAlertPending: true, adminAlertNextAt: null, adminAlertClaimedAt: null } });
  const before = groupMessages(bot).length;
  const results = await Promise.all([1, 2, 3, 4].map(() => notifyReservedOrder(bot, order.purchaseId)));
  assert.equal(results.filter(Boolean).length, 1, "one worker wins the outbox claim");
  assert.equal(groupMessages(bot).length - before, 1, "exactly one replacement message");

  const stored = await row(order.purchaseId);
  assert.notEqual(stored.adminAlertMessageId, original, "the replacement id is persisted");
  assert.equal(stored.adminAlertPending, false);
  assert.equal(stored.adminAlertAttempts, 0);

  // Later alerts edit the NEW message, so the replacement keeps working.
  let editedId = null;
  bot.editMessageText = async (text, options) => { editedId = options.message_id; return { message_id: options.message_id }; };
  await WalletPurchase.updateOne({ purchaseId: order.purchaseId, status: "awaiting_provider" }, { $set: { adminAlertPending: true } });
  assert.equal(await notifyReservedOrder(bot, order.purchaseId), true);
  assert.equal(editedId, stored.adminAlertMessageId);
});

dbTest("M-2: unrelated Telegram errors on an existing message keep the retry/backoff behaviour (real database)", async () => {
  const order = await parkedOrder();
  const bot = makeBotStub();
  await notifyReservedOrder(bot, order.purchaseId);
  const original = (await row(order.purchaseId)).adminAlertMessageId;
  const sentBefore = groupMessages(bot).length;

  bot.editMessageText = async () => { throw Object.assign(new Error("ETELEGRAM: 429 Too Many Requests: retry after 5"), { response: { statusCode: 429, body: { description: "Too Many Requests: retry after 5" } } }); };
  await WalletPurchase.updateOne({ purchaseId: order.purchaseId, status: "awaiting_provider" }, { $set: { adminAlertPending: true } });
  assert.equal(await notifyReservedOrder(bot, order.purchaseId), false);
  const stored = await row(order.purchaseId);
  assert.equal(groupMessages(bot).length, sentBefore, "no replacement for a rate limit");
  assert.equal(stored.adminAlertMessageId, original);
  assert.equal(stored.adminAlertPending, true);
  assert.equal(stored.adminAlertAttempts, 1);
  assert.ok(stored.adminAlertNextAt > new Date());
});
