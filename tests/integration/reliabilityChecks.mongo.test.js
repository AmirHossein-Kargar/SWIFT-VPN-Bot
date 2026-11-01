/**
 * All twelve Service Reliability Center checks, with evidence, and each one failing when its dependency does.
 *
 * Real here: every checker in services/admin/monitoring.js, the collector and its health rules, the Express app from server.js on a
 * real port, the webhook handlers, and a disposable MongoDB. Stand-ins: a local HTTP server plays WizardXray and HooshPay, a local
 * transport plays NOWPayments, and a stub plays the Telegram bot, because none of them can be run here. Redis is the real client
 * when REDIS_URL names a disposable server and a stub otherwise.
 *
 * So this proves the checks are real and that they can fail. It does not prove the live providers answer this way.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

const SECRET = "unit-webhook-secret-not-real";
const IPN_SECRET = "unit-ipn-secret-not-real";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "-100777";
process.env.HOOSHPAY_API_KEY = "unit-hoosh-key-not-real";
process.env.HOOSHPAY_WEBHOOK_SECRET = SECRET;
process.env.NOWPAYMENTS_API_KEY = "unit-now-key-not-real";
process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
process.env.WEBHOOK_BASE_URL = "https://bot.example.test";
process.env.VPN_API_KEY = "unit-wizard-key-not-real";
process.env.NODE_ENV = "test";
delete process.env.TRX_WALLET;

after(async () => { await disconnectTestDB(); });

const dbAvailable = await connectTestDB();
const options = { skip: dbAvailable ? false : "MongoDB not reachable" };

const CHECK_IDS = ["telegram", "hooshpay", "nowpayments", "wizardxray", "polling", "express", "webhook", "orders", "delivery", "jobs", "mongodb", "redis"];

describe("the twelve checks", options, () => {
  let mongoose, app, HooshPayInvoice, NowPaymentsInvoice, PaymentTombstone, WalletPurchase;
  let defaultProbes, createCollector, createTelemetry, createIncidentTracker, HEALTH_CHECKERS, resetHealthCacheForTests, setBotInstance, resetProviderAccountForTests;
  let appServer, port, provider;
  let wizard;
  let nowpayments;
  let bot;

  /** What a healthy WizardXray and HooshPay answer. Each test breaks one thing and leaves the rest alone. */
  const healthyWizard = () => ({
    status: { per_gb: 1500, per_day: 500, count_services: 3, count_active_services: 2, system: "connected", ping: 0.01, balance: 900_000 },
    me: { balance: 900_000, prices: { per_gb: 1500, per_day: 500, unlimited_per_day: 0 }, limits: { unlimited_enabled: false }, services: { total: 3, active: 2 } },
    hosts: { "VLESS TCP REALITY": [{ id: 1, remark: "Germany", address: "de.example.com", port: 443, is_disabled: false }] },
    price: 2000,
    hooshStatus: 200,
    hooshBody: { success: true, data: { balance: 1 } },
  });

  const ok = (res, result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, error: "", result, http_code: 200 })); };

  before(async () => {
    mongoose = (await import("mongoose")).default;
    ({ default: app } = await import("../../server.js"));
    ({ default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js"));
    ({ default: NowPaymentsInvoice } = await import("../../models/NowPaymentsInvoice.js"));
    ({ default: PaymentTombstone } = await import("../../models/PaymentTombstone.js"));
    ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
    ({ createCollector, defaultProbes } = await import("../../services/reliability/collector.js"));
    ({ createTelemetry } = await import("../../services/reliability/telemetry.js"));
    ({ createIncidentTracker } = await import("../../services/reliability/incidents.js"));
    ({ HEALTH_CHECKERS, resetHealthCacheForTests } = await import("../../services/admin/monitoring.js"));
    ({ setBotInstance } = await import("../../config/botInstance.js"));
    ({ resetProviderAccountForTests } = await import("../../services/wizardAccount.js"));

    appServer = http.createServer(app);
    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    port = appServer.address().port;
    process.env.PORT = String(port);

    provider = http.createServer((req, res) => {
      const path = req.url.split("?")[0];
      if (path === "/hoosh/balance") { res.writeHead(wizard.hooshStatus, { "Content-Type": "application/json" }); return res.end(JSON.stringify(wizard.hooshBody)); }
      if (path === "/status") return ok(res, wizard.status);
      if (path === "/me") return ok(res, wizard.me);
      if (path === "/get_hosts") return ok(res, wizard.hosts);
      if (path === "/price") return ok(res, { gig: 1, day: 1, unlimited: false, price: wizard.price, balance: 900_000, enough: true });
      res.writeHead(404).end();
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    process.env.WIZARD_API_URL = `http://127.0.0.1:${provider.address().port}/`;
    process.env.HOOSHPAY_API_BASE_URL = `http://127.0.0.1:${provider.address().port}/hoosh`;
  });

  after(async () => {
    setBotInstance?.(null);
    await new Promise((resolve) => appServer?.close(resolve));
    await new Promise((resolve) => provider?.close(resolve));
  });

  beforeEach(async () => {
    wizard = healthyWizard();
    nowpayments = (request) => (request.url.endsWith("/status") ? { status: 200, data: { message: "OK" } } : { status: 200, data: { selectedCurrencies: ["TRX"] } });
    bot = {
      _polling: { _lastUpdate: Date.now() },
      isPolling: () => true,
      getMe: async () => ({ id: 1 }),
      getWebHookInfo: async () => ({ url: "", pending_update_count: 0 }),
      sendChatAction: async () => true,
    };
    setBotInstance(bot);
    resetHealthCacheForTests();
    resetProviderAccountForTests();
    process.env.HOOSHPAY_WEBHOOK_SECRET = SECRET;
    await WalletPurchase.deleteMany({});
  });

  const JOB_NAMES = ["hooshpay-recovery-cron", "nowpayments-recovery", "invoice-cleanup", "user-spend-sweeper", "money-flow-sentinel"];

  /** Every real checker, except the two parts of the outside world that cannot be run here. */
  function collector({ jobs = true, redis = null } = {}) {
    const telemetry = createTelemetry();
    if (jobs) for (const name of JOB_NAMES) telemetry.recordJob(name, { ok: true });
    const real = defaultProbes();
    return createCollector({
      env: process.env,
      config: { enabled: true, intervalMs: 30_000, probeIntervalMs: 60_000 },
      probes: {
        ...real,
        nowpayments: () => HEALTH_CHECKERS.nowpayments({ transport: async (request) => nowpayments(request) }),
        redis: redis ?? (process.env.REDIS_URL ? real.redis : async () => ({ status: "healthy", latencyMs: 1, error: null })),
      },
      telemetry,
      tracker: createIncidentTracker(),
      sentinel: async () => ({ health: "healthy" }),
      stores: { flushEvents: async () => 0, flushRollups: async () => 0, writeIncidents: async () => [], loadRollups: async () => [], loadIncidentsForResume: async () => ({ open: [], resolved: [] }) },
    });
  }

  async function run(overrides) {
    const running = collector(overrides);
    const result = await running.tick();
    assert.equal(result.ok, true);
    const snapshot = running.snapshot();
    return { snapshot, states: Object.fromEntries(snapshot.components.map((item) => [item.id, item.state])), reasons: Object.fromEntries(snapshot.components.map((item) => [item.id, item.reason])), running };
  }

  test("all twelve pass, with evidence, on a quiet system with no traffic at all", async () => {
    const { snapshot, states } = await run();
    assert.deepEqual(Object.keys(states).sort(), [...CHECK_IDS].sort());
    assert.equal(snapshot.components.length, 12);
    assert.deepEqual(Object.entries(states).filter(([, state]) => state !== "healthy"), [], "every check is green");
    assert.equal(snapshot.overall.state, "healthy");
    assert.deepEqual(snapshot.overall.unverified, [], "nothing is green by omission");
    for (const component of snapshot.components) assert.notEqual(component.evidence, "none", component.id);
  });

  test("the check that passes names what it proved", async () => {
    const { reasons } = await run();
    assert.match(reasons.webhook, /signed test callback/i);
    assert.match(reasons.hooshpay, /API key/);
    assert.match(reasons.nowpayments, /API key/);
    assert.match(reasons.delivery, /admin group/);
    assert.match(reasons.wizardxray, /price and locate/);
  });

  describe("each check fails when its dependency does", () => {
    test("telegram: getMe fails", async () => {
      bot.getMe = async () => { throw new Error("no"); };
      assert.equal((await run()).states.telegram, "failed");
    });

    test("polling: another process holds the long poll", async () => {
      const { recordPollingError } = await import("../../services/admin/monitoring.js");
      recordPollingError({ status: 409 });
      const { states, reasons } = await run();
      assert.equal(states.polling, "failed");
      assert.match(reasons.polling, /409/);
    });

    test("wizardxray: the API key is rejected", async () => {
      const refused = http.createServer((_req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "apikey is invalid or not found!", result: [], http_code: 404 })); });
      await new Promise((resolve) => refused.listen(0, "127.0.0.1", resolve));
      const saved = process.env.WIZARD_API_URL;
      process.env.WIZARD_API_URL = `http://127.0.0.1:${refused.address().port}/`;
      try {
        const { states, reasons } = await run();
        assert.equal(states.wizardxray, "failed");
        assert.match(reasons.wizardxray, /rejected the API key/);
      } finally {
        process.env.WIZARD_API_URL = saved;
        await new Promise((resolve) => refused.close(resolve));
      }
    });

    test("wizardxray: the bot lost its service panel, though the API still answers", async () => {
      wizard.status.system = "disconnected";
      const { states, reasons } = await run();
      assert.equal(states.wizardxray, "failed");
      assert.match(reasons.wizardxray, /service server/);
    });

    test("wizardxray: reachable, but an order could not be fulfilled", async () => {
      wizard.hosts = {};
      assert.equal((await run()).states.wizardxray, "degraded");
      resetHealthCacheForTests();
      wizard = healthyWizard();
      wizard.me.balance = 10;
      const { states, reasons } = await run();
      assert.equal(states.wizardxray, "degraded");
      assert.match(reasons.wizardxray, /cannot fund/);
    });

    test("wizardxray: `me` failing alone leaves the panel up, so it is a problem and not an outage", async () => {
      wizard.me = { balance: 1 };
      const { states, reasons } = await run();
      assert.equal(states.wizardxray, "degraded");
      assert.match(reasons.wizardxray, /account details/);
    });

    test("hooshpay: a path it does not know is something to look at, not an outage", async () => {
      wizard.hooshStatus = 404;
      wizard.hooshBody = { message: "not found" };
      const { states, reasons } = await run();
      assert.equal(states.hooshpay, "degraded");
      assert.match(reasons.hooshpay, /recognizable/);
    });

    test("wizardxray: the quote disagrees with the price list", async () => {
      wizard.price = 1;
      const { states, reasons } = await run();
      assert.equal(states.wizardxray, "degraded");
      assert.match(reasons.wizardxray, /disagrees/);
    });

    test("hooshpay: the key is refused. Having one configured used to read as healthy", async () => {
      wizard.hooshStatus = 401;
      wizard.hooshBody = { success: false };
      const { states, reasons } = await run();
      assert.equal(states.hooshpay, "degraded", "one failed check is a blip; two in a row is a failure");
      assert.match(reasons.hooshpay, /rejected the API key/);
    });

    test("nowpayments: its status endpoint is down", async () => {
      nowpayments = () => ({ status: 503, data: {} });
      assert.equal((await run()).states.nowpayments, "degraded");
    });

    test("nowpayments: the key is refused", async () => {
      nowpayments = (request) => (request.url.endsWith("/status") ? { status: 200, data: { message: "OK" } } : { status: 403, data: {} });
      const { reasons } = await run();
      assert.match(reasons.nowpayments, /rejected the API key/);
    });

    test("webhook: the configured secret is not the one the route verifies with", async () => {
      // A signature made with another secret is what a mismatch between the two ends looks like from the route.
      const result = await HEALTH_CHECKERS.webhook({ port, env: { ...process.env, HOOSHPAY_WEBHOOK_SECRET: "another-secret", NOWPAYMENTS_IPN_SECRET: "" } });
      assert.equal(result.status, "down");
      assert.match(result.error, /HooshPay answered 401/);
    });

    test("webhook: the database behind the invoice lookup is what a passing check stands on", async () => {
      assert.equal((await HEALTH_CHECKERS.webhook({ port })).status, "healthy");
    });

    test("orders: an order waits for a decision", async () => {
      await WalletPurchase.collection.insertOne({ purchaseId: "stuck-1", telegramId: "1", planId: "p", gig: 1, days: 1, amount: 1, status: "manual_review", createdAt: new Date() });
      assert.equal((await run()).states.orders, "degraded");
    });

    test("delivery: Telegram refuses a send", async () => {
      bot.sendChatAction = async () => { throw new Error("Forbidden"); };
      const { states, reasons } = await run();
      assert.equal(states.delivery, "degraded");
      assert.match(reasons.delivery, /refused a send/);
    });

    test("delivery: a service waiting in the outbox outranks any test send", async () => {
      await WalletPurchase.collection.insertOne({ purchaseId: "undelivered-1", telegramId: "1", planId: "p", gig: 1, days: 1, amount: 1, status: "completed", notificationPending: true, completedAt: new Date(Date.now() - 10 * 60_000), createdAt: new Date() });
      assert.equal((await run()).states.delivery, "degraded");
    });

    test("jobs: nothing has reported yet, which is unknown and not healthy", async () => {
      assert.equal((await run({ jobs: false })).states.jobs, "unknown");
    });

    test("redis: a failed ping", async () => {
      assert.equal((await run({ redis: async () => ({ status: "down", latencyMs: null, error: "not connected" }) })).states.redis, "failed");
    });

    test("mongodb and express answer for real here; their failure paths are in reliabilityCollector.test.js", async () => {
      const { states } = await run();
      assert.deepEqual([states.mongodb, states.express], ["healthy", "healthy"]);
    });
  });

  describe("the signed test callback cannot touch money", () => {
    test("it writes nothing, for either provider, however many times it runs", async () => {
      const count = async () => [await HooshPayInvoice.countDocuments({}), await NowPaymentsInvoice.countDocuments({}), await PaymentTombstone.countDocuments({})];
      const before = await count();
      for (let index = 0; index < 5; index += 1) assert.equal((await HEALTH_CHECKERS.webhook({ port })).status, "healthy");
      assert.deepEqual(await count(), before);
    });

    test("it does not count as a rejected callback", async () => {
      const { telemetry } = await import("../../services/reliability/telemetry.js");
      const rejected = () => telemetry.minutes().reduce((sum, minute) => sum + (minute.series["webhook.hooshpay"]?.rej ?? 0), 0);
      const before = rejected();
      await HEALTH_CHECKERS.webhook({ port });
      assert.equal(rejected(), before);
    });

    test("a forged header does not hide a forged callback", async () => {
      const { telemetry } = await import("../../services/reliability/telemetry.js");
      const rejected = () => telemetry.minutes().reduce((sum, minute) => sum + (minute.series["webhook.hooshpay"]?.rej ?? 0), 0);
      const before = rejected();
      const response = await fetch(`http://127.0.0.1:${port}/api/hooshpay/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-reliability-probe": "guessed" }, body: JSON.stringify({ invoice: "x", status: "paid" }) });
      assert.equal(response.status, 401);
      assert.equal(rejected(), before + 1);
    });

    test("with no webhook secret at all there is nothing to check, which is not a pass", async () => {
      const result = await HEALTH_CHECKERS.webhook({ port, env: {} });
      assert.equal(result.status, "unknown");
    });
  });

  test("mongoose stayed connected throughout", () => {
    assert.equal(mongoose.connection.readyState, 1);
  });
});
