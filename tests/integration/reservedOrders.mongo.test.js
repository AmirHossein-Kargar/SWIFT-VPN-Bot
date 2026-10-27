/**
 * Reserved-order / wallet-ledger invariants against a REAL MongoDB.
 *
 * Fake-model unit tests cannot prove database atomicity, so every concurrency claim here (single claimant, approve vs
 * cancel, duplicate recovery workers, duplicate callbacks) runs through the real Mongoose models and findOneAndUpdate
 * filters. The WizardXray client is replaced by an injected fake `createService`; Telegram is a stub. The suite refuses
 * to run unless tests/helpers/db.js connects to a database whose generated name contains "test" and is unique per file.
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

const ADMIN_A = 9101;
const ADMIN_B = 9102;
const GROUP = -100987654;
const PRICE = 25_000; // customer plan "mini"

const savedEnv = { ADMINS: process.env.ADMINS, GROUP_ID: process.env.GROUP_ID };
before(() => {
  process.env.NODE_ENV = "test";
  process.env.ADMINS = `${ADMIN_A},${ADMIN_B}`;
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

let User, WalletPurchase, purchasePlan, orderService, ledger, alerts, fulfillment, callbacks;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ purchasePlan } = await import("../../services/buyService/purchaseService.js"));
  orderService = (await import("../../services/buyService/orderService.js")).default;
  ledger = await import("../../services/buyService/purchaseLedger.js");
  alerts = await import("../../services/buyService/reservedAlerts.js");
  fulfillment = await import("../../services/buyService/reservedFulfillment.js");
  callbacks = await import("../../handlers/reservedOrderCallbacks.js");
}

const OK = { ok: true, result: { username: "svc_mongo_1", hash: "hash_mongo-1", sub_link: "https://panel.example.test/sub/x", tak_links: [] } };
const shortage = () => Object.assign(new Error("hidden"), { code: "provider_insufficient_balance", ambiguous: false });

function makeProvider({ funded = false } = {}) {
  const state = { funded, calls: 0, mode: "normal", gate: null };
  state.createService = async () => {
    state.calls += 1;
    if (state.gate) await state.gate;
    if (state.mode === "timeout") throw Object.assign(new Error("timeout"), { code: "ECONNABORTED", ambiguous: true });
    if (!state.funded) throw shortage();
    return { ...OK, result: { ...OK.result, username: `svc_${state.calls}` } };
  };
  return state;
}

let counter = 0;
async function seed(balance = 50_000) {
  counter += 1;
  const telegramId = String(5_000_000 + counter);
  await User.create({ telegramId, balance });
  return telegramId;
}

async function parked({ balance, provider = makeProvider() } = {}) {
  const telegramId = await seed(balance);
  const purchaseId = `mongo-${telegramId}`;
  const result = await purchasePlan(telegramId, "mini", { purchaseId, createService: provider.createService });
  const order = await WalletPurchase.findOne({ purchaseId });
  return { telegramId, purchaseId, provider, result, ref: String(order._id) };
}

const user = (telegramId) => User.findOne({ telegramId }).lean();
const order = (purchaseId) => WalletPurchase.findOne({ purchaseId }).lean();
const okDeliver = async () => true;

/** Proxy that makes selected writes fail like a lost database connection would. */
function failingModel(shouldFail) {
  return new Proxy(WalletPurchase, {
    get(target, prop) {
      const value = target[prop];
      if (prop === "findOneAndUpdate") {
        return (filter, update, ...rest) => {
          if (shouldFail(filter, update)) return Promise.reject(Object.assign(new Error("simulated database failure"), { name: "MongoNetworkError" }));
          return target.findOneAndUpdate(filter, update, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const writesProvisioned = (_filter, update) => update?.$set?.status === "provisioned";

describe("purchase intake under real MongoDB", () => {
  dbTest("concurrent purchases competing for one balance reserve exactly once", async () => {
    const telegramId = await seed(PRICE); // exactly one plan
    const provider = makeProvider({ funded: true });
    const results = await Promise.all([1, 2, 3, 4].map((i) =>
      purchasePlan(telegramId, "mini", { purchaseId: `compete-${telegramId}-${i}`, createService: provider.createService })));
    assert.equal(results.filter((r) => r.status === "completed").length, 1);
    assert.equal(results.filter((r) => r.failure === "insufficient_balance").length, 3);
    assert.equal((await user(telegramId)).balance, 0);
    assert.equal(provider.calls, 1, "failed reservations never reach the provider");
  });

  dbTest("duplicate purchase callbacks (same purchase ID) charge and create once", async () => {
    const telegramId = await seed(100_000);
    const provider = makeProvider({ funded: true });
    const purchaseId = `dup-${telegramId}`;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
      purchasePlan(telegramId, "mini", { purchaseId, createService: provider.createService }).catch((e) => ({ threw: e.code }))));
    assert.equal((await user(telegramId)).balance, 100_000 - PRICE);
    assert.equal((await user(telegramId)).services.length, 1);
    assert.equal(provider.calls, 1, JSON.stringify(results.map((r) => r.status || r.threw)));
    assert.equal(await WalletPurchase.countDocuments({ purchaseId }), 1);
  });

  dbTest("provider shortage parks the order with a live reservation and no refund", async () => {
    const { telegramId, purchaseId, result } = await parked();
    assert.equal(result.status, "awaiting_provider");
    const o = await order(purchaseId);
    assert.equal(o.status, "awaiting_provider");
    assert.equal(o.walletDebitStatus, "reserved");
    assert.equal(o.adminAlertPending, true);
    assert.equal(o.refundStatus, "none");
    assert.equal((await user(telegramId)).balance, 50_000 - PRICE);
  });
});

describe("approve / cancel / claim races under real MongoDB", () => {
  dbTest("two admins approving the same order create exactly one service", async () => {
    const { telegramId, purchaseId, provider, ref } = await parked();
    provider.funded = true;
    const base = provider.calls;
    const args = { createService: provider.createService, deliver: okDeliver };
    const outcomes = await Promise.all([
      fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args }),
      fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_B, ...args }),
      fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args }),
    ]);
    assert.equal(outcomes.filter((o) => o.outcome === "fulfilled").length, 1);
    assert.equal(provider.calls - base, 1);
    const u = await user(telegramId);
    assert.equal(u.services.length, 1);
    assert.equal(u.balance, 50_000 - PRICE);
    assert.equal((await order(purchaseId)).status, "completed");
  });

  dbTest("approve racing with cancel: exactly one wins, in either order, money consistent", async () => {
    for (let round = 0; round < 12; round += 1) {
      const { telegramId, purchaseId, provider, ref } = await parked();
      provider.funded = true;
      const base = provider.calls;
      const args = { createService: provider.createService, deliver: okDeliver, bot: makeBotStub() };
      const approve = () => fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args });
      const cancel = () => fulfillment.cancelReservedOrder({ orderRef: ref, adminId: ADMIN_B, ...args });
      const [first, second] = round % 2 ? [approve(), cancel()] : [cancel(), approve()];
      const results = await Promise.all([first, second]);
      const fulfilled = results.some((r) => r.outcome === "fulfilled");
      const cancelled = results.some((r) => r.outcome === "cancelled");
      assert.notEqual(fulfilled, cancelled, `round ${round}: ${results.map((r) => r.outcome)}`);
      const u = await user(telegramId);
      const o = await order(purchaseId);
      if (fulfilled) {
        assert.equal(u.balance, 50_000 - PRICE);
        assert.equal(u.services.length, 1);
        assert.equal(u.refundedPurchaseIds.length, 0);
        assert.equal(o.status, "completed");
      } else {
        assert.equal(u.balance, 50_000);
        assert.equal(u.services.length, 0);
        assert.equal(provider.calls, base, "no provider spend after a winning cancellation");
        assert.equal(o.status, "refunded");
      }
    }
  });

  dbTest("cancellation cannot interrupt an in-flight provider creation, and the creation still completes once", async () => {
    const { telegramId, purchaseId, provider, ref } = await parked();
    provider.funded = true;
    let release;
    provider.gate = new Promise((resolve) => { release = resolve; });
    const args = { createService: provider.createService, deliver: okDeliver, bot: makeBotStub() };
    const approving = fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args });
    // Wait until the claim is visible (status provisioning) before the competing cancel.
    for (let i = 0; i < 200 && (await order(purchaseId)).status !== "provisioning"; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await order(purchaseId)).status, "provisioning");
    const cancelled = await fulfillment.cancelReservedOrder({ orderRef: ref, adminId: ADMIN_B, ...args });
    assert.equal(cancelled.outcome, "not_cancellable");
    release();
    assert.equal((await approving).outcome, "fulfilled");
    const u = await user(telegramId);
    assert.equal(u.balance, 50_000 - PRICE);
    assert.equal(u.refundedPurchaseIds.length, 0);
  });

  dbTest("a stale cancel callback cannot refund a completed order", async () => {
    const { telegramId, purchaseId, provider, ref } = await parked();
    provider.funded = true;
    const args = { createService: provider.createService, deliver: okDeliver, bot: makeBotStub() };
    await fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args });
    const stale = await fulfillment.cancelReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args });
    assert.equal(stale.outcome, "not_cancellable");
    assert.equal((await order(purchaseId)).status, "completed");
    assert.equal((await user(telegramId)).balance, 50_000 - PRICE);
  });

  dbTest("a refund retried after an interruption (and run concurrently) credits at most once", async () => {
    const { telegramId, purchaseId, provider, ref } = await parked();
    // Interrupted cancellation: intent persisted, wallet not yet credited.
    await WalletPurchase.updateOne({ purchaseId, status: "awaiting_provider" }, {
      $set: { status: "refund_pending", refundStatus: "pending", refundAmount: PRICE, refundReason: "ADMIN_CANCELLED_RESERVED" },
    });
    const args = { createService: provider.createService, bot: makeBotStub() };
    const results = await Promise.all([1, 2, 3].map(() => fulfillment.cancelReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args })));
    assert.ok(results.every((r) => ["cancelled", "already_cancelled"].includes(r.outcome)), JSON.stringify(results.map((r) => r.outcome)));
    const u = await user(telegramId);
    assert.equal(u.balance, 50_000);
    assert.deepEqual(u.refundedPurchaseIds, [purchaseId]);
    assert.equal((await order(purchaseId)).status, "refunded");
  });

  dbTest("unauthorized users cannot spend provider funds or cancel", async () => {
    const { purchaseId, provider, ref } = await parked();
    provider.funded = true;
    const base = provider.calls;
    for (const intruder of [1, 424242, "x", null]) {
      assert.equal((await fulfillment.approveReservedOrder({ orderRef: ref, adminId: intruder, createService: provider.createService, deliver: okDeliver })).outcome, "forbidden");
      assert.equal((await fulfillment.cancelReservedOrder({ orderRef: ref, adminId: intruder })).outcome, "forbidden");
    }
    assert.equal(provider.calls, base);
    assert.equal((await order(purchaseId)).status, "awaiting_provider");
  });

  dbTest("the admin-group callback denies a non-admin and a private-chat tap", async () => {
    const { purchaseId, provider, ref } = await parked();
    provider.funded = true;
    const base = provider.calls;
    const deps = { createService: provider.createService, deliver: okDeliver };
    for (const q of [
      { id: "1", data: `rsv:ok:${ref}`, from: { id: 31337 }, message: { chat: { id: GROUP }, message_id: 1 } },
      { id: "2", data: `rsv:ok:${ref}`, from: { id: ADMIN_A }, message: { chat: { id: ADMIN_A }, message_id: 1 } },
    ]) await callbacks.handleReservedOrderCallback(makeBotStub(), q, deps);
    assert.equal(provider.calls, base);
    assert.equal((await order(purchaseId)).status, "awaiting_provider");
  });
});

describe("failure and recovery paths under real MongoDB", () => {
  dbTest("admin notification failure after persistence keeps the order and recovers once delivered", async () => {
    const { purchaseId } = await parked();
    const broken = makeBotStub();
    broken.sendMessage = async () => { throw new Error("Bad Request: chat not found"); };
    assert.equal(await alerts.notifyReservedOrder(broken, purchaseId), false);
    let o = await order(purchaseId);
    assert.equal(o.status, "awaiting_provider");
    assert.equal(o.adminAlertPending, true);
    assert.equal(o.adminAlertAttempts, 1);
    const healthy = makeBotStub();
    const mine = () => healthy.sent.filter((e) => e.kind === "message" && String(e.text).includes(purchaseId)).length;
    // Backoff not elapsed: the periodic sweep leaves this order alone.
    await alerts.retryPendingReservedAlerts(healthy);
    assert.equal(mine(), 0);
    // Backoff elapsed: concurrent duplicate workers deliver exactly one message.
    await WalletPurchase.updateOne({ purchaseId }, { $set: { adminAlertNextAt: null } });
    const results = await Promise.all([1, 2, 3].map(() => alerts.notifyReservedOrder(healthy, purchaseId)));
    assert.equal(results.filter(Boolean).length, 1, "one concurrent worker wins the outbox claim");
    assert.equal(mine(), 1);
    o = await order(purchaseId);
    assert.equal(o.adminAlertPending, false);
    assert.equal(o.adminAlertAttempts, 0);
    assert.ok(Number.isSafeInteger(o.adminAlertMessageId));
  });

  dbTest("provider success followed by a database failure is never recreated and ends in reconciliation", async () => {
    const telegramId = await seed();
    const provider = makeProvider({ funded: true });
    const purchaseId = `dbfail-${telegramId}`;
    const result = await purchasePlan(telegramId, "mini", {
      purchaseId,
      createService: provider.createService,
      purchaseModel: failingModel(writesProvisioned),
    });
    assert.equal(result.failure, "fulfillment_pending");
    assert.equal(provider.calls, 1);
    let o = await order(purchaseId);
    assert.equal(o.status, "provisioning");
    assert.equal(o.recoveryStatus, "required");
    // Replays and the recovery worker (twice, concurrently) never call the provider again.
    await purchasePlan(telegramId, "mini", { purchaseId, createService: provider.createService });
    await WalletPurchase.updateOne({ purchaseId }, { $set: { provisioningStartedAt: new Date(Date.now() - 3600_000) } });
    const bot = makeBotStub();
    await Promise.all([ledger.recoverWalletPurchases(bot), ledger.recoverWalletPurchases(bot)]);
    o = await order(purchaseId);
    assert.equal(o.status, "manual_review");
    assert.equal(provider.calls, 1, "a possibly-created service is reconciled, never blindly recreated");
    assert.equal((await user(telegramId)).balance, 50_000 - PRICE, "funds stay reserved");
    assert.equal(bot.sent.filter((e) => e.kind === "message" && String(e.chatId) === String(GROUP)).length, 1, "one admin alert despite two workers");
  });

  dbTest("the same database failure during an admin approval never recreates the service", async () => {
    const { telegramId, purchaseId, provider, ref } = await parked();
    provider.funded = true;
    const base = provider.calls;
    const outcome = await fulfillment.approveReservedOrder({
      orderRef: ref, adminId: ADMIN_A, createService: provider.createService, deliver: okDeliver,
      purchaseModel: failingModel(writesProvisioned),
    });
    assert.notEqual(outcome.outcome, "fulfilled");
    const second = await fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_B, createService: provider.createService, deliver: okDeliver });
    assert.equal(second.outcome, "not_claimable");
    assert.equal(provider.calls - base, 1);
    assert.equal((await user(telegramId)).balance, 50_000 - PRICE);
    assert.notEqual((await order(purchaseId)).status, "refunded");
  });

  dbTest("a provider timeout is held, never replayed by approve, cancel or recovery", async () => {
    const { telegramId, purchaseId, provider, ref } = await parked();
    provider.mode = "timeout";
    const args = { createService: provider.createService, deliver: okDeliver, bot: makeBotStub() };
    const outcome = await fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_A, ...args });
    assert.equal(outcome.outcome, "unknown_outcome");
    const calls = provider.calls;
    provider.mode = "normal"; provider.funded = true;
    assert.equal((await fulfillment.approveReservedOrder({ orderRef: ref, adminId: ADMIN_B, ...args })).outcome, "not_claimable");
    assert.equal((await fulfillment.cancelReservedOrder({ orderRef: ref, adminId: ADMIN_B, ...args })).outcome, "not_cancellable");
    await WalletPurchase.updateOne({ purchaseId }, { $set: { provisioningStartedAt: new Date(Date.now() - 3600_000) } });
    await ledger.recoverWalletPurchases(makeBotStub());
    assert.equal(provider.calls, calls);
    assert.equal((await order(purchaseId)).status, "manual_review");
    assert.equal((await user(telegramId)).balance, 50_000 - PRICE);
    assert.equal((await user(telegramId)).refundedPurchaseIds.length, 0);
  });

  dbTest("recovery of an interrupted (stale provisioning) admin claim is idempotent across duplicate workers", async () => {
    const { purchaseId, provider } = await parked();
    // Simulate a crash right after the admin claim: status provisioning, claim time long past.
    await WalletPurchase.updateOne({ purchaseId, status: "awaiting_provider" }, {
      $set: { status: "provisioning", provisioningStartedAt: new Date(Date.now() - 3600_000), fulfillmentClaimedBy: String(ADMIN_A) },
    });
    const base = provider.calls;
    const bot = makeBotStub();
    await Promise.all([1, 2, 3].map(() => ledger.recoverWalletPurchases(bot)));
    assert.equal((await order(purchaseId)).status, "manual_review");
    assert.equal(provider.calls, base);
    assert.equal(bot.sent.filter((e) => e.kind === "message").length, 1, "alertAdmin is claimed once");
  });

  dbTest("recovery never auto-refunds or auto-creates an awaiting_provider order", async () => {
    const { telegramId, purchaseId, provider } = await parked();
    await WalletPurchase.updateOne({ purchaseId }, { $set: { createdAt: new Date(Date.now() - 7 * 86400_000) } });
    const base = provider.calls;
    await Promise.all([ledger.recoverWalletPurchases(makeBotStub()), ledger.recoverWalletPurchases(makeBotStub())]);
    assert.equal((await order(purchaseId)).status, "awaiting_provider");
    assert.equal(provider.calls, base);
    assert.equal((await user(telegramId)).balance, 50_000 - PRICE);
  });

  dbTest("duplicate recovery of a provisioned order commits the service exactly once", async () => {
    const telegramId = await seed();
    const provider = makeProvider({ funded: true });
    const purchaseId = `commit-${telegramId}`;
    await purchasePlan(telegramId, "mini", { purchaseId, createService: provider.createService, purchaseModel: failingModel((f, u) => u?.$set?.status === "completed") }).catch(() => {});
    // The ledger stalled between 'provisioned' and 'completed'.
    await WalletPurchase.updateOne({ purchaseId }, { $set: { createdAt: new Date(Date.now() - 3600_000) } });
    assert.equal((await order(purchaseId)).status, "provisioned");
    await Promise.all([1, 2, 3].map(() => ledger.recoverWalletPurchases(makeBotStub())));
    const u = await user(telegramId);
    assert.equal(u.services.length, 1);
    assert.equal(u.totalServices, 1);
    assert.equal((await order(purchaseId)).status, "completed");
    assert.equal(provider.calls, 1);
  });

  dbTest("delivery failure keeps the service, retries are deduplicated, bounded and backed off", async () => {
    const telegramId = await seed();
    const provider = makeProvider({ funded: true });
    const purchaseId = `deliver-${telegramId}`;
    await purchasePlan(telegramId, "mini", { purchaseId, createService: provider.createService });
    assert.equal((await order(purchaseId)).notificationPending, true);

    const blocked = makeBotStub();
    blocked.sendPhoto = async () => { throw new Error("Forbidden: bot was blocked by the user"); };
    assert.equal(await ledger.deliverPurchaseNotificationById(purchaseId, blocked), false);
    let o = await order(purchaseId);
    assert.equal(o.notificationAttempts, 1);
    assert.ok(o.notificationNextAt > new Date(), "next attempt is scheduled in the future");

    // The recovery cycle respects the backoff: no delivery attempt is made while it is pending.
    let attempts = 0;
    const counting = makeBotStub();
    counting.sendPhoto = async () => { attempts += 1; throw new Error("still blocked"); };
    await WalletPurchase.updateOne({ purchaseId }, { $set: { notificationClaimedAt: null } });
    await ledger.recoverWalletPurchases(counting);
    assert.equal(attempts, 0);

    // After the backoff, concurrent workers send exactly one photo and stop retrying once delivered.
    await WalletPurchase.updateOne({ purchaseId }, { $set: { notificationNextAt: new Date(Date.now() - 1000), notificationClaimedAt: null } });
    const ok = makeBotStub();
    await Promise.all([1, 2, 3].map(() => ledger.recoverWalletPurchases(ok)));
    assert.equal(ok.sent.filter((e) => e.kind === "photo").length, 1);
    o = await order(purchaseId);
    assert.equal(o.notificationPending, false);
    assert.equal(provider.calls, 1, "delivery retries never create another subscription");
    await Promise.all([1, 2].map(() => ledger.recoverWalletPurchases(ok)));
    assert.equal(ok.sent.filter((e) => e.kind === "photo").length, 1);

    // The attempt cap stops automatic retries; the order stays visible to admins.
    const capped = await seed();
    const cappedId = `capped-${capped}`;
    await purchasePlan(capped, "mini", { purchaseId: cappedId, createService: provider.createService });
    await WalletPurchase.updateOne({ purchaseId: cappedId }, { $set: { notificationAttempts: ledger.NOTIFICATION_MAX_ATTEMPTS } });
    const untouched = makeBotStub();
    await ledger.recoverWalletPurchases(untouched);
    assert.equal(untouched.sent.filter((e) => e.kind === "photo").length, 0);
    assert.equal((await order(cappedId)).notificationPending, true);
  });

  dbTest("repeated admin-alert notifications for one reserved order post a single group message", async () => {
    const telegramId = await seed();
    const bot = makeBotStub();
    const purchaseId = `svc-${telegramId}`;
    const provider = makeProvider();
    const result = await purchasePlan(telegramId, "mini", { purchaseId, createService: provider.createService });
    await alerts.notifyReservedOrder(bot, result.purchaseId);
    await alerts.notifyReservedOrder(bot, result.purchaseId);
    assert.equal(bot.sent.filter((e) => e.kind === "message" && String(e.chatId) === String(GROUP)).length, 1);

  });
});
