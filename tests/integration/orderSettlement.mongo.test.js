/**
 * Settling an order whose create has an unknown outcome, against a disposable MongoDB and a local panel that follows the document.
 *
 * These orders had no exit: the debit stayed held for ever even when the service existed. The risks of the way out are the ones
 * tested here: fulfilling twice, one service paying for two orders, and refunding an order the provider really fulfilled.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { startFakeWizardPanel } from "../helpers/fakeWizardPanel.js";

process.env.ADMINS = "424242";
process.env.USER_SPEND_HOOK = "off";
process.env.NODE_ENV = "test";
process.env.VPN_API_KEY = "unit-wizard-key-not-real";
const ADMIN = "424242";
const MIN = 60_000;

const dbAvailable = await connectTestDB();
after(async () => { await disconnectTestDB(); });

describe("settling an unknown outcome", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  let panel, User, WalletPurchase, AdminAuditLog, settleUnknownOrder, refundPurchaseReservation, resolvePaymentRecovery, getPaymentDetail, evaluateBundle, loadBundles, readSentinelConfig, defaultSources;
  let serial = 0;
  const leases = { acquire: async (key) => ({ key }), release: async () => {} };
  const operation = () => randomUUID().replace(/-/g, "");
  const makeBot = () => { const sent = []; return { sent, sendMessage: async (...args) => { sent.push(["message", ...args]); }, sendPhoto: async (...args) => { sent.push(["photo", ...args]); } }; };
  const settle = (fields) => settleUnknownOrder({ actorId: ADMIN, operationId: operation(), reason: "checked the provider list by hand", leases, ...fields });

  /** An order as a lost `create` answer leaves it, with the debit really taken. */
  async function heldOrder({ gig = 20, days = 30, age = 30 * MIN, ...fields } = {}) {
    serial += 1;
    const telegramId = String(980_000_000 + serial);
    const purchaseId = `held-${serial}`;
    const startedAt = new Date(Date.now() - age);
    await User.create({ telegramId, balance: 500, appliedPurchaseReservations: [purchaseId] });
    await WalletPurchase.create({ purchaseId, telegramId, planId: "p1", planName: "Plan", gig, days, amount: 40_000, status: "manual_review", walletDebitStatus: "reserved", errorCode: "ECONNABORTED", recoveryStatus: "required", provisioningStartedAt: startedAt, createdAt: startedAt, ...fields });
    return { purchaseId, telegramId, startedAt };
  }
  const providerService = (startedAt, fields = {}) => panel.add({ gig: 20, day: 30, createdAt: Math.floor(startedAt.getTime() / 1000) + 5, ...fields });
  const order = (purchaseId) => WalletPurchase.findOne({ purchaseId }).lean();
  const user = (telegramId) => User.findOne({ telegramId }).lean();

  before(async () => {
    panel = await startFakeWizardPanel();
    process.env.WIZARD_API_URL = panel.url;
    ({ default: User } = await import("../../models/User.js"));
    ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
    ({ default: AdminAuditLog } = await import("../../models/AdminAuditLog.js"));
    ({ settleUnknownOrder } = await import("../../services/admin/orderSettlement.js"));
    ({ refundPurchaseReservation } = await import("../../services/buyService/purchaseLedger.js"));
    ({ resolvePaymentRecovery, getPaymentDetail } = await import("../../services/admin/payments.js"));
    ({ evaluateBundle } = await import("../../services/sentinel/rules.js"));
    ({ loadBundles } = await import("../../services/sentinel/bundle.js"));
    ({ readSentinelConfig } = await import("../../services/sentinel/constants.js"));
    ({ defaultSources } = await import("../../services/sentinel/readOnly.js"));
  });
  after(async () => { await panel?.close(); });
  beforeEach(() => { panel.calls.length = 0; panel.services.clear(); });

  const mutations = () => panel.calls.filter((call) => ["create", "renew", "upg_time", "upg_size", "delsv", "change_link", "reverse_mode"].includes(call.method));

  async function findings(telegramId) {
    const config = { ...readSentinelConfig({}), ledgerEpoch: new Date(0) };
    const bundles = await loadBundles([telegramId], { sources: defaultSources(), config });
    return evaluateBundle(bundles.get(telegramId), { now: new Date(), config }).map((item) => item.code);
  }

  describe("the service exists", () => {
    test("it goes to the customer, the held debit pays for it, and nothing is created or charged", async () => {
      const { purchaseId, telegramId, startedAt } = await heldOrder();
      const service = providerService(startedAt);
      const bot = makeBot();
      const result = await settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot });
      assert.deepEqual([result.outcome, result.status], ["created", "completed"]);
      const stored = await order(purchaseId);
      assert.deepEqual([stored.status, stored.walletDebitStatus, stored.serviceUsername], ["completed", "finalized", service.username]);
      assert.equal(stored.expiresAt.getTime(), service.expire * 1000, "the provider's date");
      const owner = await user(telegramId);
      assert.equal(owner.balance, 500, "no second debit and no refund");
      assert.deepEqual(owner.services.map((item) => item.username), [service.username]);
      assert.deepEqual(owner.completedPurchaseIds, [purchaseId]);
      assert.deepEqual(owner.refundedPurchaseIds, []);
      assert.deepEqual(mutations(), [], "reads only: the provider is not asked to create anything");
      assert.equal(bot.sent.filter(([kind]) => kind === "photo").length, 1, "the customer gets the service");
      assert.deepEqual((await findings(telegramId)).filter((code) => /ORDER_NEEDS_REVIEW|COMPLETED_NOT_COMMITTED|RESERVATION|REFUND/.test(code)), []);
    });

    test("a repeat of the same settlement changes nothing", async () => {
      const { purchaseId, telegramId, startedAt } = await heldOrder();
      const service = providerService(startedAt);
      const operationId = operation();
      const bot = makeBot();
      await settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot, operationId });
      const replay = await settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot, operationId });
      assert.ok(replay);
      const owner = await user(telegramId);
      assert.equal(owner.services.length, 1);
      assert.equal(bot.sent.filter(([kind]) => kind === "photo").length, 1);
    });

    test("two admins at once: one wins, and the customer gets one service", async () => {
      const { purchaseId, telegramId, startedAt } = await heldOrder();
      const service = providerService(startedAt);
      const results = await Promise.allSettled([1, 2, 3].map(() => settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() })));
      assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal((await user(telegramId)).services.length, 1);
    });

    test("one service cannot pay for two orders", async () => {
      const first = await heldOrder();
      const second = await heldOrder();
      const service = providerService(first.startedAt);
      await settle({ purchaseId: first.purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() });
      await assert.rejects(() => settle({ purchaseId: second.purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() }), (error) => error.code === "service_already_linked");
      assert.equal((await order(second.purchaseId)).status, "manual_review");
    });

    for (const [name, fields, code] of [
      ["a smaller volume", { gig: 10 }, "service_terms_mismatch"],
      ["unlimited, when volume was sold", { unlimited: true, gig: 0 }, "service_terms_mismatch"],
      ["created long before the attempt", { createdAt: Math.floor(Date.now() / 1000) - 86_400 }, "service_outside_window"],
    ]) {
      test(`refused: ${name}`, async () => {
        const { purchaseId, telegramId, startedAt } = await heldOrder();
        const service = providerService(startedAt, fields);
        await assert.rejects(() => settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() }), (error) => error.code === code);
        assert.equal((await order(purchaseId)).status, "manual_review");
        assert.equal((await user(telegramId)).services.length, 0);
      });
    }

    for (const [name, fields] of [
      ["a test service, which paid for nothing", { test: true }],
      ["a service with no link to give the customer", { sub_link: "" }],
    ]) {
      test(`refused: ${name}`, async () => {
        const { purchaseId, telegramId, startedAt } = await heldOrder();
        const service = providerService(startedAt);
        panel.fail("info", { status: 200, body: { ok: true, error: "", http_code: 200, result: { username: service.username, status: "active", source: "panel", test: false, sub_link: "https://sub.example.test/sub/x", data_limit_gb: 20, created_at: Math.floor(startedAt.getTime() / 1000) + 5, ...fields } } });
        await assert.rejects(() => settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() }), (error) => error.code === "service_terms_mismatch");
        assert.equal((await order(purchaseId)).status, "manual_review");
        assert.equal((await user(telegramId)).services.length, 0);
      });
    }

    test("an unlimited order links only an unlimited service", async () => {
      const { purchaseId, startedAt } = await heldOrder({ gig: 0 });
      const service = providerService(startedAt, { unlimited: true, gig: 0 });
      await settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() });
      assert.equal((await order(purchaseId)).status, "completed");
    });

    test("a service the panel does not have, or an answer from its stored copy, settles nothing", async () => {
      const { purchaseId, startedAt } = await heldOrder();
      await assert.rejects(() => settle({ purchaseId, outcome: "created", serviceUsername: "NOSUCHSVC", bot: makeBot() }), (error) => error.code === "wizard_service_not_found");
      const service = providerService(startedAt);
      panel.fail("info", { status: 200, body: { ok: true, error: "", http_code: 200, result: { username: service.username, status: "active", source: "cache", sub_link: "https://sub.example.test/sub/x", data_limit_gb: 20, created_at: service.createdAt } } });
      await assert.rejects(() => settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() }), (error) => error.code === "wizard_stale");
      assert.equal((await order(purchaseId)).status, "manual_review");
    });
  });

  describe("nothing was created", () => {
    test("the held debit returns once, and the customer is told", async () => {
      const { purchaseId, telegramId } = await heldOrder();
      const bot = makeBot();
      const result = await settle({ purchaseId, outcome: "not_created", bot });
      assert.equal(result.outcome, "not_created");
      const stored = await order(purchaseId);
      assert.deepEqual([stored.status, stored.walletDebitStatus, stored.refundStatus, stored.refundAmount], ["refunded", "refunded", "completed", 40_000]);
      const owner = await user(telegramId);
      assert.equal(owner.balance, 40_500);
      assert.deepEqual(owner.refundedPurchaseIds, [purchaseId]);
      assert.equal(bot.sent.filter(([kind]) => kind === "message").length, 1);
      assert.deepEqual(mutations(), []);
      assert.deepEqual((await findings(telegramId)).filter((code) => /REFUND|ORDER_NEEDS_REVIEW|TRANSITION/.test(code)), []);
    });

    test("three admins at once refund once", async () => {
      const { purchaseId, telegramId } = await heldOrder();
      await Promise.allSettled([1, 2, 3].map(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() })));
      assert.equal((await user(telegramId)).balance, 40_500);
    });

    test("refused while the provider shows a service that could be this order", async () => {
      const { purchaseId, telegramId, startedAt } = await heldOrder();
      providerService(startedAt);
      await assert.rejects(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() }), (error) => error.code === "provider_candidates_exist");
      assert.equal((await user(telegramId)).balance, 500);
      assert.equal((await order(purchaseId)).status, "manual_review");
    });

    test("refused when the provider's list cannot be read: no evidence, no refund", async () => {
      const { purchaseId, telegramId } = await heldOrder();
      panel.fail("clients", "drop");
      await assert.rejects(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() }));
      assert.equal((await user(telegramId)).balance, 500);
      assert.equal((await order(purchaseId)).status, "manual_review");
    });
  });

  describe("a partial answer and the automatic paths", () => {
    test("a list shorter than its own total is no evidence, even with nothing matching in it", async () => {
      const { purchaseId, telegramId } = await heldOrder();
      panel.fail("clients", { status: 200, body: { ok: true, error: "", http_code: 200, result: { count: 0, total: 5, list: [] } } });
      await assert.rejects(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() }), (error) => error.code === "provider_list_incomplete");
      assert.equal((await user(telegramId)).balance, 500);
      assert.equal((await order(purchaseId)).status, "manual_review");
    });

    test("the refund path refuses a held order unless settlement asked, so no cron can refund a service that may exist", async () => {
      const { purchaseId, telegramId } = await heldOrder();
      const held = await order(purchaseId);
      await assert.rejects(() => refundPurchaseReservation(held, { reason: "RECOVERED_UNFULFILLED_ORDER" }), (error) => error.code === "PURCHASE_NOT_REFUNDABLE");
      assert.equal((await user(telegramId)).balance, 500);
      assert.equal((await order(purchaseId)).status, "manual_review");
    });
  });

  describe("what is never allowed", () => {
    test("an order too recent to judge: create may still answer, and the list lags", async () => {
      const { purchaseId, telegramId, startedAt } = await heldOrder({ age: 5 * MIN });
      const service = providerService(startedAt);
      await assert.rejects(() => settle({ purchaseId, outcome: "created", serviceUsername: service.username, bot: makeBot() }), (error) => error.code === "order_too_recent");
      await assert.rejects(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() }), (error) => error.code === "order_too_recent");
      assert.equal((await user(telegramId)).balance, 500);
    });

    for (const status of ["provisioning", "completed", "refunded", "awaiting_provider"]) {
      test(`an order that is ${status}`, async () => {
        const { purchaseId } = await heldOrder({ status });
        await assert.rejects(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() }), (error) => error.code === "order_not_held");
      });
    }

    test("an order whose debit cannot be proved", async () => {
      const { purchaseId, telegramId } = await heldOrder();
      await User.updateOne({ telegramId }, { $set: { appliedPurchaseReservations: [] } });
      await assert.rejects(() => settle({ purchaseId, outcome: "not_created", bot: makeBot() }), (error) => error.code === "reservation_not_verified");
    });

    test("anyone but an admin, or without a reason", async () => {
      const { purchaseId } = await heldOrder();
      await assert.rejects(() => settleUnknownOrder({ actorId: "5", operationId: operation(), purchaseId, outcome: "not_created", reason: "a long enough reason", leases }), { code: "forbidden" });
      await assert.rejects(() => settleUnknownOrder({ actorId: ADMIN, operationId: operation(), purchaseId, outcome: "not_created", reason: "x", leases }));
      await assert.rejects(() => settleUnknownOrder({ actorId: ADMIN, operationId: operation(), purchaseId, outcome: "maybe", reason: "a long enough reason", leases }), (error) => error.code === "invalid_settlement");
    });

    test("every settlement is on the audit record before it acts", async () => {
      const { purchaseId } = await heldOrder();
      await settle({ purchaseId, outcome: "not_created", bot: makeBot() });
      const row = await AdminAuditLog.findOne({ action: "ORDER_UNKNOWN_SETTLED", targetId: purchaseId }).lean();
      assert.equal(row.status, "succeeded");
      assert.equal(row.metadata.outcome, "not_created");
    });

    test("the note-only resolve cannot close a held order and hide the money", async () => {
      const { purchaseId } = await heldOrder();
      await assert.rejects(() => resolvePaymentRecovery({ actorId: ADMIN, operationId: operation(), key: `wallet:${purchaseId}`, reason: "closing this with a note" }), (error) => error.code === "order_needs_settlement");
      assert.equal((await order(purchaseId)).status, "manual_review");
      const details = await getPaymentDetail({ actorId: ADMIN, key: `wallet:${purchaseId}` });
      assert.equal(JSON.stringify(details).includes('"manualResolve":true'), false, "the panel does not offer it");
    });
  });
});
