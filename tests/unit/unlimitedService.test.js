/**
 * Unlimited service end to end, with in-memory models and a local panel.
 *
 * The three rules under test: selling it needs a positive answer from `me`, a price comes from the catalog and never from the
 * client, and "unlimited" must never read as "zero". Unlimited traffic also still expires. Whether the provider's own unlimited
 * works for this account is not something a test here can show.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

process.env.ADMINS = "9001";

const { purchasePlan } = await import("../../services/buyService/purchaseService.js");
const { approveReservedOrder } = await import("../../services/buyService/reservedFulfillment.js");
const { getSellablePlanById, getSellablePlans, setProductModelForTests } = await import("../../services/plans.js");
const wizard = await import("../../api/wizardApi.js");
const account = await import("../../services/wizardAccount.js");
const { validateProductInput, presentProduct } = await import("../../services/admin/products.js");
const { formatPlanButtonText } = await import("../../keyboards/generatePlanButtons.js");
const { default: confirmOrder } = await import("../../services/buyService/confirmOrder.js");
const { isUnlimitedTraffic, trafficTextFa, volumeNumber } = await import("../../utils/serviceTerms.js");
const { normalizeServiceResult, fallbackFromDbRecord } = await import("../../services/wizardServiceStatus.js");

const accountWith = (unlimitedEnabled, perDay = 3000) => ({
  balance: 1_000_000,
  currency: "toman",
  prices: { perGb: 1500, perDay: 500, unlimitedPerDay: unlimitedEnabled ? perDay : 0, test: 1500, custom: false },
  limits: { minGig: 0.5, maxGig: 10000, minDay: 1, maxDay: 3650, minAddGig: 1, minAddDay: 1, unlimitedEnabled, testEnabled: true },
  services: { total: 0, active: 0 },
});

const PRODUCT = { productId: "unl30", name: "Unlimited 30", durationDays: 30, trafficGb: 0, priceToman: 200_000, costToman: 90_000, enabled: true, published: true, displayOrder: 1, revision: 0 };
const VOLUME = { ...PRODUCT, productId: "vol30", name: "50 GB 30", trafficGb: 50 };
const created = (over = {}) => ({
  ok: true,
  result: { username: "F3O1KH6ZP", hash: "459149a4", sub_link: "https://sub.example.com/sub/459149a4", tak_links: ["vless://x@de.example.com:443#Germany"], gig: 0, gig_byte: 0, day: 30, expiryTime: 1793804266, unlimited: true, ...over },
});

function catalog(rows = [PRODUCT, VOLUME]) {
  setProductModelForTests({
    find: (query) => ({ sort: () => ({ lean: async () => rows.filter((row) => (query.durationDays?.$in ?? [query.durationDays]).includes(row.durationDays)) }) }),
    findOne: ({ productId }) => ({ lean: async () => rows.find((row) => row.productId === productId) ?? null }),
    countDocuments: async () => rows.length,
  });
}

beforeEach(() => catalog());
afterEach(() => { setProductModelForTests(null); account.resetProviderAccountForTests(); });

describe("the provider decides whether it is on sale", () => {
  test("offered when `me` says it is enabled", async () => {
    account.setProviderAccountForTests(accountWith(true));
    assert.deepEqual((await getSellablePlans()).map((plan) => plan.id).sort(), ["unl30", "vol30"]);
    assert.equal((await getSellablePlanById("unl30")).gig, 0);
  });

  test("hidden when `me` says it is disabled, and the admin's product row is left alone", async () => {
    account.setProviderAccountForTests(accountWith(false));
    assert.deepEqual((await getSellablePlans()).map((plan) => plan.id), ["vol30"]);
    assert.equal(await getSellablePlanById("unl30"), null);
  });

  test("hidden when the provider cannot be asked: not knowing is not a yes", async () => {
    account.setProviderAccountForTests(null);
    assert.deepEqual((await getSellablePlans()).map((plan) => plan.id), ["vol30"]);
    assert.equal(await getSellablePlanById("unl30"), null);
  });

  test("the volume plans never depend on that answer", async () => {
    account.setProviderAccountForTests(null);
    assert.equal((await getSellablePlanById("vol30")).gig, 50);
  });
});

describe("buying one", () => {
  const buy = (models, options = {}) => purchasePlan("7001", "unl30", { userModel: models.userModel, purchaseModel: models.purchaseModel, purchaseId: "unlimited-1", ...options });
  const wallet = (balance = 500_000) => makeFakeWalletModels([{ telegramId: "7001", balance }]);

  beforeEach(() => account.setProviderAccountForTests(accountWith(true)));

  test("asks the provider for gig 0, charges the catalog price and records a real expiry", async () => {
    const models = wallet();
    const calls = [];
    const result = await buy(models, { createService: async (...args) => { calls.push(args); return created(); } });
    assert.deepEqual(calls, [[0, 30, 0]], "gig 0 is the provider's way of saying unlimited");
    assert.equal(result.status, "completed");
    assert.equal(models.users.get("7001").balance, 300_000, "the catalog price, not day × unlimited_per_day");
    const order = models.purchases.get("unlimited-1");
    assert.equal(order.gig, 0);
    assert.equal(models.users.get("7001").services[0].trafficGb, 0);
    assert.equal(order.expiresAt.getTime(), 1793804266_000, "unlimited traffic still ends, on the provider's date");
    assert.equal(result.service.subscriptionUrl, "https://sub.example.com/sub/459149a4");
  });

  test("short of funds: nothing reaches the provider", async () => {
    const models = wallet(100);
    let called = false;
    const result = await buy(models, { createService: async () => { called = true; return created(); } });
    assert.equal(called, false);
    assert.equal(result.failure, "insufficient_balance");
    assert.equal(models.users.get("7001").balance, 100);
  });

  test("not on sale right now: refused before anything is debited", async () => {
    account.setProviderAccountForTests(accountWith(false));
    const models = wallet();
    await assert.rejects(() => buy(models, { createService: async () => created() }), (error) => error.code === "INVALID_PLAN");
    assert.equal(models.users.get("7001").balance, 500_000);
    assert.equal(models.purchases.size, 0);
  });

  test("the provider switched it off after the check: refunded once, never kept", async () => {
    const models = wallet();
    const refused = new wizard.WizardApiError("service creation", { status: 403, code: "panel_rejected_request", reason: "unlimited_disabled" });
    const result = await buy(models, { createService: async () => { throw refused; } });
    assert.equal(result.status, "refunded");
    assert.equal(models.users.get("7001").balance, 500_000);
    assert.deepEqual(models.users.get("7001").refundedPurchaseIds, ["unlimited-1"]);
  });

  test("the documented `cant create service` is settled: the provider returned its charge, so the customer is refunded", async () => {
    const models = wallet();
    const failed = new wizard.WizardApiError("service creation", { status: 500, code: "panel_operation_failed", reason: "create_failed", outage: true });
    const result = await buy(models, { createService: async () => { throw failed; } });
    assert.equal(result.status, "refunded");
    assert.equal(models.users.get("7001").balance, 500_000);
  });

  test("a timeout proves nothing: the debit is held for review, not refunded and not retried", async () => {
    const models = wallet();
    let calls = 0;
    const timedOut = new wizard.WizardApiError("service creation", { code: "ECONNABORTED", ambiguous: true });
    const result = await buy(models, { createService: async () => { calls += 1; throw timedOut; } });
    assert.equal(result.status, "manual_review");
    assert.equal(models.users.get("7001").balance, 300_000);
    await buy(models, { createService: async () => { calls += 1; return created(); } });
    assert.equal(calls, 1, "the same order never reaches the provider twice");
  });

  test("short provider wallet: parked with the debit kept, and fulfilled later as unlimited", async () => {
    const models = wallet();
    const short = new wizard.WizardApiError("service creation", { status: 402, code: "provider_insufficient_balance", reason: "provider_insufficient_balance" });
    const first = await buy(models, { createService: async () => { throw short; } });
    assert.equal(first.status, "awaiting_provider");
    const order = models.purchases.get("unlimited-1");
    const calls = [];
    const outcome = await approveReservedOrder({
      orderRef: "a".repeat(24),
      adminId: 9001,
      createService: async (...args) => { calls.push(args); return created(); },
      deliver: async () => true,
      purchaseModel: { ...models.purchaseModel, findOne: () => ({ lean: async () => ({ ...order, _id: "a".repeat(24) }) }), findOneAndUpdate: async () => ({ ...order, status: "provisioning", toObject: () => order }), updateOne: async () => ({}) },
      userModel: models.userModel,
    }).catch((error) => ({ thrown: error }));
    assert.ok(!outcome.thrown);
    assert.deepEqual(calls, [[0, 30, 0]], "the terms come from the stored order");
  });
});

describe("what people see", () => {
  test("the shop button and the confirmation say unlimited, never 0 GB", () => {
    const plan = { id: "unl30", name: "Unlimited 30", days: 30, gig: 0, price: 200_000 };
    assert.match(formatPlanButtonText(plan), /نامحدود/);
    assert.doesNotMatch(formatPlanButtonText(plan), /0 GB/);
    const { message } = confirmOrder(plan);
    assert.match(message, /نامحدود ♾/);
    assert.doesNotMatch(message, /0 گیگ/);
    assert.match(message, /30 روز/, "the duration stays visible: it is not unlimited time");
  });

  test("a volume plan reads as before", () => {
    assert.match(formatPlanButtonText({ gig: 50, price: 1000 }), /50 GB/);
    assert.match(confirmOrder({ id: "x", gig: 50, days: 30, price: 1000 }).message, /50 گیگ/);
  });

  test("only a real zero is unlimited", () => {
    for (const value of [0, "0"]) assert.equal(isUnlimitedTraffic(value), true, String(value));
    for (const value of [null, undefined, "", false, 1, 0.5]) assert.equal(isUnlimitedTraffic(value), false, String(value));
    assert.equal(trafficTextFa(null), "نامشخص");
  });

  test("an absent volume never converts to zero", () => {
    for (const value of [null, undefined, "", " ", false, true, [], {}, "x"]) assert.ok(Number.isNaN(volumeNumber(value)), JSON.stringify(value));
    assert.deepEqual([volumeNumber(0), volumeNumber("0"), volumeNumber(50), volumeNumber("12.5")], [0, 0, 50, 12.5]);
  });

  test("a crypto quote with no volume cannot resolve to the unlimited plan", async () => {
    // Number(null) is 0, so this selection used to find the unlimited product of that duration.
    account.setProviderAccountForTests(accountWith(true));
    const { quoteCryptoPayment } = await import("../../services/pricing/tronQuote.js");
    for (const gig of [null, "", false]) {
      await assert.rejects(() => quoteCryptoPayment({ planSelection: { durationDays: 30, gig }, currency: "trx", catalog: {} }), (error) => error.code === "invalid_plan", JSON.stringify(gig));
    }
  });

  test("the service view has no remainder to read as exhausted", () => {
    const view = normalizeServiceResult({ username: "F3O1KH6ZP", status: "active", source: "panel", unlimited: true, sub_link: "https://sub.example.com/s", data_limit: 0, used_traffic: 0, remaining_traffic: null, data_limit_gb: 0, used_traffic_gb: 0, remaining_traffic_gb: 0, expire: 1793804266, expire_jalali: "1405/8/13 18:27", days_left: 10 });
    assert.deepEqual([view.unlimited, view.totalGbText, view.remainingGbText, view.usagePercent], [true, null, null, null]);
    assert.equal(fallbackFromDbRecord({ username: "u", trafficGb: 0 }).remainingGbText, null);
  });
});

describe("catalog validation", () => {
  const base = { name: "Unlimited", durationDays: 30, priceToman: 1000, costToman: 500, enabled: false, published: false, displayOrder: 0 };

  test("zero is a choice", () => {
    assert.equal(validateProductInput({ ...base, trafficGb: 0 }).trafficGb, 0);
    assert.equal(presentProduct({ productId: "p", ...base, trafficGb: 0 }).unlimited, true);
    assert.equal(presentProduct({ productId: "p", ...base, trafficGb: 10 }).unlimited, false);
  });

  test("blank is not: a cleared field must never create an unlimited product", () => {
    for (const trafficGb of ["", "  ", null, undefined]) assert.throws(() => validateProductInput({ ...base, trafficGb }), (error) => error.code === "invalid_traffic_gb", JSON.stringify(trafficGb));
  });

  test("the limit is the provider's", () => {
    assert.throws(() => validateProductInput({ ...base, trafficGb: 10_001 }));
    assert.throws(() => validateProductInput({ ...base, trafficGb: -1 }));
  });
});

describe("the provider's cost", () => {
  test("follows the document's two formulas", () => {
    const enabled = accountWith(true);
    assert.equal(account.providerCost(enabled, { gig: 20, days: 30 }), 45_000);
    assert.equal(account.providerCost(enabled, { gig: 0, days: 10 }), 30_000);
  });

  test("has no answer for unlimited while it is off, rather than a free one", () => {
    assert.equal(account.providerCost(accountWith(false), { gig: 0, days: 10 }), null);
    assert.equal(account.providerCost(null, { gig: 20, days: 30 }), null);
  });
});

describe("the account cache", () => {
  let server;
  let requests = 0;
  let answer;
  const saved = {};

  before(async () => {
    for (const key of ["NODE_ENV", "WIZARD_API_URL", "VPN_API_KEY"]) saved[key] = process.env[key];
    process.env.NODE_ENV = "test";
    server = http.createServer((_req, res) => {
      requests += 1;
      const { status = 200, body } = answer();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.VPN_API_KEY = "unit-key-not-real";
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  beforeEach(() => {
    requests = 0;
    account.resetProviderAccountForTests();
    answer = () => ({ body: { ok: true, error: "", http_code: 200, result: { balance: 5, prices: { per_gb: 1, per_day: 1, unlimited_per_day: 3000 }, limits: { unlimited_enabled: true }, services: {} } } });
  });

  test("many readers share one provider call", async () => {
    await Promise.all(Array.from({ length: 5 }, () => account.getProviderAccount()));
    await account.getProviderAccount();
    assert.equal(requests, 1);
  });

  test("an outage is remembered briefly, so a menu does not wait on every render", async () => {
    answer = () => ({ status: 503, body: {} });
    assert.equal(await account.getProviderAccount(), null);
    assert.equal(await account.getProviderAccount(), null);
    assert.equal(requests, 1);
  });

  test("a change forgets the stored answer", async () => {
    await account.getProviderAccount();
    account.invalidateProviderAccount();
    await account.getProviderAccount();
    assert.equal(requests, 2);
  });
});
