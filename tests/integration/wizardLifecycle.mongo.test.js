/**
 * A service from delivery to deletion, through the real admin and bot code, a disposable MongoDB and a local panel that follows
 * the document (tests/helpers/fakeWizardPanel.js). It proves this application's half of the contract. Live behaviour of the
 * provider is not proven here. The Redis lease is replaced in memory; the real one fails closed when Redis is down.
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

const dbAvailable = await connectTestDB();
after(async () => { await disconnectTestDB(); });
const options = { skip: dbAvailable ? false : "MongoDB not reachable" };

describe("service lifecycle", options, () => {
  let panel, User, WalletPurchase, AdminAuditLog;
  let vpns, wizardStatus, wizardAccount, deleteCustomer, changeServiceLink, deactivate, sentinelBundle, sentinelRules, sentinelConstants, defaultSources;
  let serial = 0;
  const leases = { acquire: async (key) => ({ key }), release: async () => {} };
  const action = (fields) => vpns.performVpnAction({ actorId: ADMIN, operationId: randomUUID().replace(/-/g, ""), reason: "lifecycle test", leases, ...fields });
  const makeBot = () => {
    const edits = [];
    return { edits, editMessageText: async (text, options_) => { edits.push({ text, options: options_ }); return true; } };
  };

  /** A completed order and its service, as a real purchase leaves them. */
  async function owned(fields = {}) {
    serial += 1;
    const telegramId = String(990_000_000 + serial);
    const service = panel.add(fields);
    const purchaseId = `life-${serial}`;
    const expiresAt = new Date(service.expire * 1000);
    await User.create({ telegramId, completedPurchaseIds: [purchaseId], appliedPurchaseReservations: [purchaseId], totalServices: 1, services: [{ username: service.username, sub_link: `https://sub.example.test/sub/${service.hash}`, purchaseId, productId: "p1", trafficGb: service.unlimited ? 0 : service.gig, createdAt: new Date(), expiresAt }] });
    await WalletPurchase.create({ purchaseId, telegramId, planId: "p1", planName: "Plan", gig: service.unlimited ? 0 : service.gig, days: 30, amount: 10_000, status: "completed", walletDebitStatus: "finalized", serviceUsername: service.username, serviceHash: service.hash, serviceLink: `https://sub.example.test/sub/${service.hash}`, expiresAt, completedAt: new Date() });
    return { telegramId, username: service.username, purchaseId, service };
  }

  before(async () => {
    panel = await startFakeWizardPanel();
    process.env.WIZARD_API_URL = panel.url;
    ({ default: User } = await import("../../models/User.js"));
    ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
    ({ default: AdminAuditLog } = await import("../../models/AdminAuditLog.js"));
    vpns = await import("../../services/admin/vpns.js");
    wizardStatus = await import("../../services/wizardServiceStatus.js");
    wizardAccount = await import("../../services/wizardAccount.js");
    deleteCustomer = await import("../../services/manageServices/deleteCustomerService.js");
    ({ default: changeServiceLink } = await import("../../services/manageServices/changeServiceLink.js"));
    ({ default: deactivate } = await import("../../services/manageServices/deactiveServiceButton.js"));
    sentinelBundle = await import("../../services/sentinel/bundle.js");
    sentinelRules = await import("../../services/sentinel/rules.js");
    sentinelConstants = await import("../../services/sentinel/constants.js");
    ({ defaultSources } = await import("../../services/sentinel/readOnly.js"));
  });
  after(async () => { await panel?.close(); });
  beforeEach(() => {
    panel.calls.length = 0;
    panel.state.unlimitedPerDay = 3000;
    wizardStatus.resetWizardStatusCacheForTests();
    wizardAccount.resetProviderAccountForTests();
  });

  describe("what an admin sees", () => {
    test("usage, remainder and days come from the live service", async () => {
      const { username } = await owned({ gig: 20, usedGb: 5 });
      const detail = await vpns.getVpnDetail({ actorId: ADMIN, username });
      assert.equal(detail.trafficGb, 20);
      assert.equal(detail.trafficUsed, "5 GB");
      assert.equal(detail.trafficRemainingGb, 15);
      assert.equal(detail.wizardXray.status, "connected");
      assert.equal(detail.availableActions.increaseTraffic, true);
      assert.equal(detail.availableActions.enable, false);
    });

    test("an unlimited service is not shown as empty, and traffic cannot be added to it", async () => {
      const { username } = await owned({ unlimited: true, gig: 0, usedGb: 7 });
      const detail = await vpns.getVpnDetail({ actorId: ADMIN, username });
      assert.deepEqual([detail.unlimited, detail.trafficGb, detail.trafficRemainingGb], [true, 0, null]);
      assert.equal(detail.availableActions.increaseTraffic, false);
      assert.ok(detail.expiresAt, "it still expires");
    });

    test("a service with no stored volume is unknown, not unlimited", async () => {
      serial += 1;
      const telegramId = String(990_000_000 + serial);
      const service = panel.add({});
      await User.create({ telegramId, services: [{ username: service.username, purchaseId: `trial-${serial}` }] });
      const list = await vpns.listVpns({ actorId: ADMIN, query: { search: telegramId } });
      assert.equal(list.items[0].trafficGb, null);
      panel.services.delete(service.username);
      const detail = await vpns.getVpnDetail({ actorId: ADMIN, username: service.username });
      assert.deepEqual([detail.unlimited, detail.trafficGb], [false, null]);
    });

    test("the panel's stored copy is labelled, and reads only", async () => {
      const { username, service } = await owned();
      panel.fail("info", { status: 200, body: { ok: true, error: "", http_code: 200, result: { username, status: "active", source: "cache", unlimited: false, sub_link: "https://sub.example.test/sub/x", links: [], expire: service.expire, data_limit_gb: 20 } } });
      const detail = await vpns.getVpnDetail({ actorId: ADMIN, username });
      assert.equal(detail.wizardXray.status, "stale");
      assert.ok(detail.wizardXray.error);
      assert.deepEqual([detail.availableActions.changeLink, detail.availableActions.renew, detail.availableActions.revoke], [false, false, false]);
    });
  });

  describe("admin actions", () => {
    test("extending stores the provider's date, also on an expired service where adding to the old date would be wrong", async () => {
      const { username, telegramId } = await owned({ expire: Math.floor(Date.now() / 1000) - 10 * 86_400 });
      const result = await action({ username, action: "extend-time", days: 5 });
      assert.equal(result.verified, true);
      const stored = (await User.findOne({ telegramId })).services[0].expiresAt.getTime();
      assert.equal(stored, panel.services.get(username).expire * 1000);
      assert.ok(stored > Date.now() + 4 * 86_400_000, "counted from now");
    });

    test("adding traffic follows the provider's total", async () => {
      const { username, telegramId } = await owned({ gig: 20 });
      await action({ username, action: "increase-traffic", gig: 5 });
      assert.equal((await User.findOne({ telegramId })).services[0].trafficGb, 25);
    });

    test("adding under 1 GB is refused before it costs a provider call", async () => {
      const { username } = await owned();
      await assert.rejects(() => action({ username, action: "increase-traffic", gig: 0.5 }), (error) => error.code === "invalid_gig");
      assert.equal(panel.callsTo("upg_size").length, 0);
    });

    test("traffic cannot be added to an unlimited service", async () => {
      const { username } = await owned({ unlimited: true, gig: 0 });
      await assert.rejects(() => action({ username, action: "increase-traffic", gig: 5 }), (error) => error.code === "wizard_service_unlimited");
      assert.equal(panel.callsTo("upg_size").length, 0);
    });

    test("renewing to volume adds to what is left, and stores it", async () => {
      const { username, telegramId } = await owned({ gig: 20, usedGb: 5 });
      const result = await action({ username, action: "renew", gig: 10, days: 10 });
      assert.equal(result.verified, true);
      assert.deepEqual(panel.callsTo("renew")[0].params, { username, gig: "10", day: "10" });
      assert.equal((await User.findOne({ telegramId })).services[0].trafficGb, 25);
    });

    test("renewing to unlimited needs the explicit choice: a blank or zero volume never selects it", async () => {
      const { username, telegramId } = await owned({ gig: 20 });
      for (const gig of [0, "", null, undefined]) await assert.rejects(() => action({ username, action: "renew", gig, days: 10 }), (error) => error.code === "invalid_gig", String(gig));
      assert.equal(panel.callsTo("renew").length, 0);
      const result = await action({ username, action: "renew", unlimited: true, days: 10 });
      assert.equal(result.unlimited, true);
      assert.equal(panel.callsTo("renew")[0].params.gig, "0");
      assert.equal((await User.findOne({ telegramId })).services[0].trafficGb, 0);
    });

    test("renewing as unlimited while it is off changes nothing and says why", async () => {
      panel.state.unlimitedPerDay = 0;
      const { username, telegramId } = await owned({ gig: 20 });
      await assert.rejects(() => action({ username, action: "renew", unlimited: true, days: 10 }), (error) => error.code === "unlimited_disabled" && /switched off/.test(error.message));
      assert.equal((await User.findOne({ telegramId })).services[0].trafficGb, 20);
    });

    test("a short provider wallet is reported as that, and nothing was changed", async () => {
      const { username } = await owned({ gig: 20 });
      panel.fail("upg_time", panel.refused(402, "You don't have enough fund!", { price: 2500 }));
      await assert.rejects(() => action({ username, action: "extend-time", days: 5 }), (error) => error.code === "provider_insufficient_balance" && /short of funds/.test(error.message) && error.ambiguous === false);
    });

    test("a lost answer is reported as uncertain, with no local change and no second attempt", async () => {
      const { username, telegramId, service } = await owned({ gig: 20 });
      const before = (await User.findOne({ telegramId })).services[0].expiresAt.getTime();
      panel.fail("upg_time", "drop");
      await assert.rejects(() => action({ username, action: "extend-time", days: 5 }), (error) => error.ambiguous === true && error.status === 503);
      assert.equal(panel.callsTo("upg_time").length, 1);
      assert.equal((await User.findOne({ telegramId })).services[0].expiresAt.getTime(), before);
      assert.ok(service);
    });

    test("disable and enable name the state, so repeating either changes nothing", async () => {
      const { username } = await owned();
      await action({ username, action: "disable" });
      assert.equal(panel.callsTo("reverse_mode")[0].params.status, "disabled");
      assert.equal((await action({ username, action: "disable" })).alreadyDisabled, true);
      assert.equal(panel.callsTo("reverse_mode").length, 1);
      await action({ username, action: "enable" });
      assert.equal(panel.callsTo("reverse_mode")[1].params.status, "active");
      assert.equal(panel.services.get(username).status, "active");
    });

    test("a limited or expired service is not switched on by hand", async () => {
      const { username } = await owned({ status: "limited" });
      await assert.rejects(() => action({ username, action: "enable" }), (error) => error.code === "wizard_state_unknown");
    });

    test("a new link reaches every copy, so the order cannot rebuild the revoked one", async () => {
      const { username, telegramId, purchaseId } = await owned();
      await wizardStatus.getServiceLiveStatus(username);
      await action({ username, action: "change-link" });
      const link = `https://sub.example.test/sub/${panel.services.get(username).hash}`;
      assert.equal((await User.findOne({ telegramId })).services[0].sub_link, link);
      const order = await WalletPurchase.findOne({ purchaseId });
      assert.equal(order.serviceLink, link);
      assert.equal(order.serviceHash, panel.services.get(username).hash);
      assert.equal((await wizardStatus.getServiceLiveStatus(username)).data.smartLink, link, "the cached view does not show the old link");
    });

    test("revoking records the removal and the provider's refund, and Sentinel sees no debt", async () => {
      const { username, telegramId, purchaseId } = await owned();
      const result = await action({ username, action: "revoke" });
      assert.equal(result.returnPrice, 1250);
      const user = await User.findOne({ telegramId });
      assert.deepEqual([user.services.length, user.totalServices], [0, 0]);
      assert.ok((await WalletPurchase.findOne({ purchaseId })).revokedAt);
      const audit = await AdminAuditLog.findOne({ action: "VPN_REVOKED", targetId: username });
      assert.equal(audit.result.returnPrice, 1250);
      await assertNoServiceDebt(telegramId);
    });
  });

  async function assertNoServiceDebt(telegramId) {
    const config = sentinelConstants.readSentinelConfig({});
    const bundles = await sentinelBundle.loadBundles([telegramId], { sources: defaultSources(), config: { ...config, ledgerEpoch: new Date(0) } });
    const findings = sentinelRules.evaluateBundle(bundles.get(telegramId), { now: new Date(), config: { ...config, ledgerEpoch: new Date(0) } });
    assert.deepEqual(findings.filter((item) => item.code === "COMPLETED_NOT_COMMITTED").map((item) => item.observed), []);
  }

  describe("what a customer does", () => {
    test("a delete removes the service, marks the order, and raises no false debt", async () => {
      const { username, telegramId, purchaseId } = await owned();
      const bot = makeBot();
      await deleteCustomer.deleteCustomerService(bot, { chatId: 1, messageId: 2, userId: telegramId, username });
      assert.match(bot.edits[0].text, /با موفقیت حذف شد/);
      const user = await User.findOne({ telegramId });
      assert.deepEqual([user.services.length, user.totalServices], [0, 0]);
      const order = await WalletPurchase.findOne({ purchaseId });
      assert.deepEqual([Boolean(order.revokedAt), order.revokedBy, order.status], [true, telegramId, "completed"]);
      await assertNoServiceDebt(telegramId);
    });

    test("a refused delete keeps the service: the customer may be connected through it", async () => {
      const { username, telegramId } = await owned();
      panel.fail("delsv", panel.refused(500, "cant delete service"));
      const bot = makeBot();
      await deleteCustomer.deleteCustomerService(bot, { chatId: 1, messageId: 2, userId: telegramId, username });
      assert.equal((await User.findOne({ telegramId })).services.length, 1);
      assert.match(bot.edits[0].text, /انجام نشد/);
    });

    test("an unanswered delete keeps the service and does not claim either outcome", async () => {
      const { username, telegramId } = await owned();
      panel.fail("delsv", "drop");
      const bot = makeBot();
      await deleteCustomer.deleteCustomerService(bot, { chatId: 1, messageId: 2, userId: telegramId, username });
      assert.equal((await User.findOne({ telegramId })).services.length, 1);
      assert.match(bot.edits[0].text, /مشخص نشد/);
    });

    test("deleting what the panel no longer has still clears the customer's list", async () => {
      const { username, telegramId } = await owned();
      panel.services.delete(username);
      await deleteCustomer.deleteCustomerService(makeBot(), { chatId: 1, messageId: 2, userId: telegramId, username });
      assert.equal((await User.findOne({ telegramId })).services.length, 0);
    });

    test("removal counts from the array, so one service among several leaves the right total", async () => {
      const first = await owned();
      const second = panel.add({});
      await User.updateOne({ telegramId: first.telegramId }, { $push: { services: { username: second.username } }, $set: { totalServices: 2 } });
      await deleteCustomer.deleteCustomerService(makeBot(), { chatId: 1, messageId: 2, userId: first.telegramId, username: first.username });
      const user = await User.findOne({ telegramId: first.telegramId });
      assert.deepEqual([user.services.map((item) => item.username), user.totalServices], [[second.username], 1]);
    });

    test("the on/off button sends the state, so a double tap lands on the same place", async () => {
      const { username } = await owned();
      const bot = makeBot();
      await deactivate(bot, 1, 2, `deactivate_service_${username}`);
      assert.equal(panel.callsTo("reverse_mode")[0].params.status, "disabled");
      assert.equal(panel.services.get(username).status, "disabled");
      assert.equal((await wizardStatus.getServiceLiveStatus(username)).data.status, "disabled", "the next view is not the cached old state");
    });

    test("the button does nothing to a service that ran out", async () => {
      const { username } = await owned({ status: "limited" });
      const bot = makeBot();
      await deactivate(bot, 1, 2, `deactivate_service_${username}`);
      assert.equal(panel.callsTo("reverse_mode").length, 0);
      assert.equal(panel.services.get(username).status, "limited");
    });

    test("a link change updates the order too, and logs no link", async (t) => {
      const lines = [];
      t.mock.method(console, "error", (...args) => lines.push(args.join(" ")));
      const { username, telegramId, purchaseId } = await owned();
      const bot = makeBot();
      await changeServiceLink(bot, 1, 2, `change_link_${username}`, { from: { id: Number(telegramId) } });
      const link = `https://sub.example.test/sub/${panel.services.get(username).hash}`;
      assert.equal((await User.findOne({ telegramId })).services[0].sub_link, link);
      assert.equal((await WalletPurchase.findOne({ purchaseId })).serviceLink, link);
      panel.fail("change_link", "drop");
      await changeServiceLink(makeBot(), 1, 2, `change_link_${username}`, { from: { id: Number(telegramId) } });
      assert.equal(lines.some((line) => /sub\.example\.test|https?:/.test(line)), false, lines.join("\n"));
    });
  });

  describe("the provider's list", () => {
    test("reads the real list shape, pages it, and never returns a link", async () => {
      const mine = await owned();
      const orphan = panel.add({});
      const first = await vpns.listRemoteClients({ actorId: ADMIN, page: 1, pageSize: 1 });
      assert.equal(first.items.length, 1);
      assert.ok(first.total >= 2);
      const all = await vpns.listRemoteClients({ actorId: ADMIN, pageSize: 100 });
      assert.equal(all.items.find((row) => row.username === mine.username).knownLocally, true);
      assert.equal(all.items.find((row) => row.username === orphan.username).knownLocally, false);
      assert.equal(JSON.stringify(all).includes("sub.example.test"), false);
      assert.equal(/"(hash|uid|sub_link|links)"/.test(JSON.stringify(all)), false);
    });

    test("an account with no services is an empty page, not an error", async () => {
      const saved = new Map(panel.services);
      panel.services.clear();
      const page = await vpns.listRemoteClients({ actorId: ADMIN });
      assert.deepEqual([page.items, page.total], [[], 0]);
      for (const [key, value] of saved) panel.services.set(key, value);
    });

    test("for an unknown outcome it offers leads, and settles nothing", async () => {
      serial += 1;
      const purchaseId = `unknown-${serial}`;
      const startedAt = new Date();
      await WalletPurchase.create({ purchaseId, telegramId: "991000001", planId: "p1", gig: 33, days: 30, amount: 10_000, status: "manual_review", provisioningStartedAt: startedAt });
      const stray = panel.add({ gig: 33, day: 30 });
      panel.add({ gig: 34, day: 30 });
      panel.add({ gig: 33, day: 90 });
      const result = await vpns.findProviderCandidates({ actorId: ADMIN, purchaseId });
      assert.deepEqual(result.candidates.map((row) => row.username), [stray.username]);
      assert.equal((await WalletPurchase.findOne({ purchaseId })).status, "manual_review");
    });

    test("a service another order already owns is not a lead", async () => {
      serial += 1;
      const purchaseId = `unknown-${serial}`;
      await WalletPurchase.create({ purchaseId, telegramId: "991000002", planId: "p1", gig: 44, days: 30, amount: 10_000, status: "manual_review", provisioningStartedAt: new Date() });
      await owned({ gig: 44, day: 30 });
      assert.deepEqual((await vpns.findProviderCandidates({ actorId: ADMIN, purchaseId })).candidates, []);
    });
  });

  describe("the provider account", () => {
    test("reports prices, limits and locations, and never a node address", async () => {
      const overview = await vpns.getProviderOverview({ actorId: ADMIN });
      assert.equal(overview.account.prices.unlimitedPerDay, 3000);
      assert.deepEqual(overview.hosts, [{ inbound: "VLESS TCP REALITY", remark: "Germany", disabled: false }]);
      assert.equal(JSON.stringify(overview).includes("de.example.test"), false);
    });

    test("quotes through `price`, and unlimited only when asked for", async () => {
      assert.equal((await vpns.getProviderQuote({ actorId: ADMIN, gig: 20, days: 30 })).price, 45_000);
      assert.equal((await vpns.getProviderQuote({ actorId: ADMIN, unlimited: true, days: 10 })).price, 30_000);
      await assert.rejects(() => vpns.getProviderQuote({ actorId: ADMIN, gig: "", days: 10 }), (error) => error.code === "invalid_gig");
    });

    test("only admins may read any of it", async () => {
      for (const call of [vpns.getProviderOverview, vpns.getProviderQuote, vpns.findProviderCandidates]) await assert.rejects(() => call({ actorId: "5", gig: 1, days: 1, purchaseId: "x" }), { code: "forbidden" });
    });
  });
});
