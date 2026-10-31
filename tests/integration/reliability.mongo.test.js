/**
 * The Service Reliability Center against a real, disposable MongoDB, with orders moved by the REAL purchase code and only the
 * WizardXray call stubbed. It proves what a stub cannot: that monitoring leaves money collections byte-identical, that two
 * processes make one incident, that restarts resume, and that the read queries use their indexes.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";
// The purchase hook recomputes a spend counter on User after it returns, unawaited. It belongs to the purchase, not to the
// monitor, and left on it would change a User row in the middle of the byte comparison below.
process.env.USER_SPEND_HOOK = "off";

after(async () => { await disconnectTestDB(); });

const dbAvailable = await connectTestDB();
const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let mongoose, User, Hoosh, NowPayments, Crypto, Bank, WalletPurchase, Tombstone, Audit, ReliabilityEvent, ReliabilityIncident, ReliabilityRollup, Checkpoint;
let creditWalletOnce, reserveBalance, purchasePlan, seedDefaultProducts, listProducts;
let createCollector, createIncidentTracker, createTelemetry, stores, queries, workflow, defaultSources;

if (dbAvailable) {
  mongoose = (await import("mongoose")).default;
  ({ default: User } = await import("../../models/User.js"));
  ({ default: Hoosh } = await import("../../models/HooshPayInvoice.js"));
  ({ default: NowPayments } = await import("../../models/NowPaymentsInvoice.js"));
  ({ default: Crypto } = await import("../../models/CryptoInvoice.js"));
  ({ default: Bank } = await import("../../models/invoice.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: Tombstone } = await import("../../models/PaymentTombstone.js"));
  ({ default: Audit } = await import("../../models/AdminAuditLog.js"));
  ({ default: ReliabilityEvent } = await import("../../models/ReliabilityEvent.js"));
  ({ default: ReliabilityIncident } = await import("../../models/ReliabilityIncident.js"));
  ({ default: ReliabilityRollup } = await import("../../models/ReliabilityRollup.js"));
  ({ default: Checkpoint } = await import("../../models/JobCheckpoint.js"));
  ({ creditWalletOnce } = await import("../../services/walletCredit.js"));
  ({ reserveBalance } = await import("../../services/buyService/purchaseLedger.js"));
  ({ purchasePlan } = await import("../../services/buyService/purchaseService.js"));
  ({ seedDefaultProducts } = await import("../../services/plans.js"));
  ({ createCollector } = await import("../../services/reliability/collector.js"));
  ({ createIncidentTracker } = await import("../../services/reliability/incidents.js"));
  ({ createTelemetry } = await import("../../services/reliability/telemetry.js"));
  stores = await import("../../services/reliability/store.js");
  queries = await import("../../services/reliability/queries.js");
  workflow = await import("../../services/reliability/workflow.js");
  ({ defaultSources } = await import("../../services/sentinel/readOnly.js"));
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms);
const healthy = async () => ({ status: "healthy", latencyMs: 2, error: null, details: { webhook: {} } });
const down = async () => ({ status: "down", latencyMs: null, error: "connection refused" });
let serial = 0;
const nextUser = () => { serial += 1; return String(810_000_000 + serial); };

function collectorWith(overrides = {}) {
  const telemetry = overrides.telemetry || createTelemetry({ now: overrides.now });
  const { realOrders, ...rest } = overrides;
  return createCollector({
    env: {},
    config: { enabled: true, intervalMs: 30_000, probeIntervalMs: 60_000 },
    probes: { mongodb: healthy, redis: healthy, express: healthy, telegram: healthy, wizardxray: healthy, hooshpay: healthy, orders: realOrders ?? healthy },
    telemetry,
    tracker: createIncidentTracker(),
    polling: () => ({ failing: false, stalled: false, lastSuccessAgeSec: 1 }),
    sentinel: async () => null,
    eventLoop: null,
    ...rest,
  });
}

async function orderIn(status, fields = {}) {
  const purchaseId = randomUUID();
  const telegramId = nextUser();
  await WalletPurchase.collection.insertOne({
    purchaseId, telegramId, planId: "plan-30", planName: "30 day plan", gig: 50, days: 30, amount: 100_000, status, walletDebitStatus: "reserved", refundStatus: "none", recoveryStatus: "none",
    retryCount: 0, notificationPending: false, createdAt: ago(40 * MIN), reservedAt: ago(40 * MIN), events: [], ...fields,
  });
  return { purchaseId, telegramId };
}

async function fingerprintMoney() {
  const models = [User, Hoosh, NowPayments, Crypto, Bank, WalletPurchase, Tombstone, Audit];
  const parts = [];
  for (const model of models) {
    const rows = await model.collection.find({}).sort({ _id: 1 }).toArray();
    parts.push(`${model.modelName}:${rows.length}:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`);
  }
  return parts.join("\n");
}

describe("real orders", () => {
  let delivered, parked;

  before(async () => {
    if (!dbAvailable) return;
    await seedDefaultProducts();
    const plan = (await mongoose.model("AdminProduct").findOne({ enabled: true, archived: { $ne: true } }).lean());
    const planId = String(plan.productId ?? plan.planId ?? plan.id ?? plan._id);
    const telegramId = nextUser();
    await User.create({ telegramId, firstName: "Fixture", balance: 0 });
    await creditWalletOnce({ telegramId, amount: 50_000_000, creditKey: `hooshpay:rel-${telegramId}` });
    delivered = await purchasePlan(telegramId, planId, { createService: async () => ({ ok: true, result: { username: "fixture_user", hash: "fixturehash", sub_link: "https://example.test/sub" } }) });
    const shortage = Object.assign(new Error("short"), { code: "provider_insufficient_balance", ambiguous: false });
    parked = await purchasePlan(telegramId, planId, { createService: async () => { throw shortage; } });
  });

  dbTest("the fixtures really moved through the real purchase code", () => {
    assert.equal(delivered.status, "completed");
    assert.equal(parked.status, "awaiting_provider");
  });

  dbTest("a real order traces from reservation to the outbox", async () => {
    const trace = await queries.getOrderTrace({ orderId: delivered.purchaseId, running: collectorWith() });
    const stages = Object.fromEntries(trace.stages.map((stage) => [stage.id, stage]));
    assert.equal(stages.reservation.state, "done");
    assert.equal(stages.provider.state, "done");
    assert.ok(stages.provider.durationMs >= 0);
    assert.equal(stages.fulfilment.state, "done");
    assert.equal(stages.delivery.state, "pending", "no bot in this run, so the message is still in the outbox");
    assert.equal(stages.funding.state, "not_linked");
  });

  dbTest("a parked order says it is waiting on provider funds", async () => {
    const trace = await queries.getOrderTrace({ orderId: parked.purchaseId, running: collectorWith() });
    const provider = trace.stages.find((stage) => stage.id === "provider");
    assert.equal(provider.state, "waiting");
    assert.equal(provider.error, "PROVIDER_INSUFFICIENT_BALANCE");
    assert.ok(trace.transitions.some((item) => item.type === "provider_funds_short"));
  });

  dbTest("no trace field can carry a service link, a hash or a username", async () => {
    const trace = await queries.getOrderTrace({ orderId: delivered.purchaseId, running: collectorWith() });
    const text = JSON.stringify(trace);
    for (const secret of ["fixturehash", "fixture_user", "example.test", String(delivered.telegramId)]) assert.ok(!text.includes(secret), secret);
  });

  dbTest("an unknown order is null, not an error", async () => {
    assert.equal(await queries.getOrderTrace({ orderId: "no-such-order", running: collectorWith() }), null);
  });

  dbTest("the cohort counts the real orders", async () => {
    const windows = await workflow.loadCohorts({ sources: defaultSources(), now: Date.now() });
    assert.ok(windows["15m"].attempted >= 2);
    assert.ok(windows["15m"].delivered >= 1);
    assert.ok(windows["15m"].inFlight >= 1, "the parked order");
    assert.equal(windows["15m"].fulfilment.samples, windows["15m"].delivered);
  });

  dbTest("the provider call is linked to its order through the telemetry context", async () => {
    const { telemetry, observeProvider } = await import("../../services/reliability/telemetry.js");
    telemetry.reset();
    const plan = await mongoose.model("AdminProduct").findOne({ enabled: true, archived: { $ne: true } }).lean();
    const planId = String(plan.productId ?? plan.planId ?? plan.id ?? plan._id);
    const telegramId = nextUser();
    await User.create({ telegramId, firstName: "Fixture", balance: 0 });
    await creditWalletOnce({ telegramId, amount: 50_000_000, creditKey: `hooshpay:rel-${telegramId}` });
    const result = await purchasePlan(telegramId, planId, { createService: async () => {
      observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 7, mutation: true });
      return { ok: true, result: { username: "fixture_two", hash: "fixturehash2", sub_link: "https://example.test/sub2" } };
    } });
    assert.equal(telemetry.events().find((event) => event.type === "provider.succeeded").orderKey, `wallet:${result.purchaseId}`);
  });
});

describe("the no-mutation guarantee", () => {
  dbTest("ticks and every read view leave all money collections byte-identical", async () => {
    await orderIn("manual_review", { provisioningStartedAt: ago(40 * MIN), errorCode: "PANEL_RESULT_UNKNOWN" });
    await orderIn("provisioning", { provisioningStartedAt: ago(40 * MIN) });
    const { HEALTH_CHECKERS } = await import("../../services/admin/monitoring.js");
    const collector = collectorWith({ realOrders: HEALTH_CHECKERS.orders });
    queries.setReliabilityRuntimeForTests({ collector, hub: null });
    const before = await fingerprintMoney();
    await collector.tick();
    await collector.tick();
    const snapshot = queries.readSnapshot();
    await queries.listEvents({ range: "1h", running: collector });
    await queries.listIncidents({ running: collector });
    await queries.getOrderBacklog();
    const [incident] = snapshot.incidents.open;
    await queries.getIncident({ id: incident.id, running: collector });
    const row = await WalletPurchase.findOne({ status: "manual_review" }).lean();
    await queries.getOrderTrace({ orderId: row.purchaseId, running: collector });
    assert.equal(await fingerprintMoney(), before);
    queries.setReliabilityRuntimeForTests({});
  });

  dbTest("real stuck orders become incidents that name them", async () => {
    const { purchaseId } = await orderIn("manual_review", { provisioningStartedAt: ago(40 * MIN), errorCode: "PANEL_RESULT_UNKNOWN" });
    const { HEALTH_CHECKERS } = await import("../../services/admin/monitoring.js");
    const collector = collectorWith({ realOrders: HEALTH_CHECKERS.orders });
    await collector.tick();
    const incident = collector.tracker.open().find((item) => item.code === "ORDERS_NEED_REVIEW");
    assert.ok(incident);
    assert.ok(incident.affectedOrders >= 1);
    assert.ok(incident.orderKeys.includes(`wallet:${purchaseId}`));
    const detail = await queries.getIncident({ id: incident.incidentId, running: collector });
    assert.ok(detail.orders.some((row) => row.orderId === purchaseId));
    assert.ok(detail.orders.every((row) => !/\d{6,}/.test(row.user ?? "")), "customer ids are masked");
    assert.ok(detail.nextSteps.length >= 1);
    await WalletPurchase.collection.updateMany({ status: { $in: ["manual_review", "provisioning"] } }, { $set: { status: "failed" } });
  });
});

describe("incident persistence", () => {
  dbTest("two processes at once make one open incident", async () => {
    await ReliabilityIncident.deleteMany({});
    await Checkpoint.deleteMany({ name: "service-reliability" });
    const condition = { fingerprint: "DEPENDENCY_DOWN:redis", code: "DEPENDENCY_DOWN", group: "dependency:redis", component: "redis", severity: "high", rank: 1, title: "Redis is not responding", summary: "x", evidence: [], affectedOrders: null, orderKeys: [] };
    const first = createIncidentTracker();
    const second = createIncidentTracker();
    first.apply({ conditions: [condition], now: Date.now() });
    second.apply({ conditions: [condition], now: Date.now() });
    await Promise.all([stores.writeIncidents(first.dirty(), first), stores.writeIncidents(second.dirty(), second)]);
    assert.equal(await ReliabilityIncident.countDocuments({ fingerprint: condition.fingerprint, state: "open" }), 1);
    assert.equal(first.open()[0].incidentId, second.open()[0].incidentId, "the loser adopted the winner's id");
  });

  dbTest("a resolved incident leaves room for a new one with the same fingerprint", async () => {
    await ReliabilityIncident.deleteMany({});
    const condition = { fingerprint: "DEPENDENCY_DOWN:mongodb", code: "DEPENDENCY_DOWN", group: "dependency:mongodb", component: "mongodb", severity: "critical", rank: 0, title: "t", summary: "s", evidence: [], affectedOrders: null, orderKeys: [] };
    const tracker = createIncidentTracker({ clearTicks: 1, reopenMs: 0 });
    tracker.apply({ conditions: [condition], now: Date.now() - 10_000 });
    await stores.writeIncidents(tracker.dirty(), tracker);
    tracker.markWritten(tracker.dirty(), Date.now());
    tracker.apply({ conditions: [], now: Date.now() - 5_000 });
    await stores.writeIncidents(tracker.dirty(), tracker);
    tracker.markWritten(tracker.dirty(), Date.now());
    tracker.apply({ conditions: [condition], now: Date.now() });
    await stores.writeIncidents(tracker.dirty(), tracker);
    assert.equal(await ReliabilityIncident.countDocuments({ fingerprint: condition.fingerprint }), 2);
    assert.equal(await ReliabilityIncident.countDocuments({ fingerprint: condition.fingerprint, state: "open" }), 1);
  });

  dbTest("a restart resumes the open incident instead of opening a duplicate", async () => {
    await ReliabilityIncident.deleteMany({});
    await Checkpoint.deleteMany({ name: "service-reliability" });
    const first = collectorWith({ probes: { mongodb: healthy, redis: down, express: healthy, telegram: healthy, wizardxray: healthy, hooshpay: healthy, orders: healthy } });
    await first.tick();
    await first.tick();
    const [original] = first.tracker.open().filter((item) => item.component === "redis");
    assert.ok(original);
    const restarted = collectorWith({ probes: { mongodb: healthy, redis: down, express: healthy, telegram: healthy, wizardxray: healthy, hooshpay: healthy, orders: healthy } });
    await restarted.tick();
    await restarted.tick();
    assert.equal(restarted.tracker.open().find((item) => item.component === "redis").incidentId, original.incidentId);
    assert.equal(await ReliabilityIncident.countDocuments({ component: "redis", state: "open" }), 1);
  });

  dbTest("a process without the lease probes but does not write", async () => {
    await ReliabilityIncident.deleteMany({});
    await Checkpoint.deleteMany({ name: "service-reliability" });
    const { acquireLease, releaseLease } = await import("../../services/jobLease.js");
    const lease = await acquireLease(Checkpoint, "service-reliability", "someone-else", 60_000);
    const collector = collectorWith({ probes: { mongodb: healthy, redis: down, express: healthy, telegram: healthy, wizardxray: healthy, hooshpay: healthy, orders: healthy } });
    await collector.tick();
    await collector.tick();
    assert.equal(collector.snapshot().monitoring.persistence.state, "standby");
    assert.ok(collector.snapshot().incidents.openCount >= 1);
    assert.equal(await ReliabilityIncident.countDocuments({}), 0);
    await releaseLease(Checkpoint, lease);
    await collector.tick();
    assert.equal(await ReliabilityIncident.countDocuments({ component: "redis" }), 1);
  });
});

describe("telemetry persistence", () => {
  dbTest("flushing twice writes each event and each minute once", async () => {
    await ReliabilityEvent.deleteMany({});
    await ReliabilityRollup.deleteMany({});
    const telemetry = createTelemetry();
    telemetry.emit({ type: "webhook.accepted", component: "webhook", message: "one" });
    telemetry.observe("http.admin", { ms: 12 });
    const later = Date.now() + 2 * MIN;
    await stores.flushEvents(telemetry.dirtyEvents());
    await stores.flushEvents(telemetry.dirtyEvents());
    const minutes = telemetry.unflushedMinutes(later);
    await stores.flushRollups(minutes, telemetry.instance);
    await stores.flushRollups(minutes, telemetry.instance);
    assert.equal(await ReliabilityEvent.countDocuments({}), 1);
    assert.equal(await ReliabilityRollup.countDocuments({}), 1);
  });

  dbTest("a coalesced event updates its stored row", async () => {
    await ReliabilityEvent.deleteMany({});
    const telemetry = createTelemetry();
    telemetry.emit({ type: "webhook.rejected", component: "webhook", message: "m", coalesceKey: "k" });
    await stores.flushEvents(telemetry.dirtyEvents());
    telemetry.markEventsFlushed(telemetry.dirtyEvents());
    for (let index = 0; index < 4; index += 1) telemetry.emit({ type: "webhook.rejected", component: "webhook", message: "m", coalesceKey: "k" });
    await stores.flushEvents(telemetry.dirtyEvents());
    const rows = await ReliabilityEvent.find({}).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 5);
  });

  dbTest("minutes from two processes in one deploy add up, and history survives a restart", async () => {
    await ReliabilityRollup.deleteMany({});
    const at = Date.now() - 5 * MIN;
    const clock = () => at;
    const one = createTelemetry({ now: clock });
    const two = createTelemetry({ now: clock });
    one.observe("http.admin", { ms: 10 });
    two.observe("http.admin", { ms: 10 });
    two.observe("http.admin", { outcome: "error", ms: 10 });
    await stores.flushRollups(one.unflushedMinutes(Date.now()), one.instance);
    await stores.flushRollups(two.unflushedMinutes(Date.now()), two.instance);
    const rows = await stores.loadRollups(Date.now());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].series["http.admin"].n, 3);
    const restarted = createTelemetry();
    restarted.hydrate(rows);
    assert.equal(restarted.minutes()[0].series["http.admin"].err, 1);
    assert.equal(restarted.unflushedMinutes(Date.now()).length, 0, "restored minutes are not written back");
  });

  dbTest("the event list merges stored rows, memory and order records without a duplicate, and pages", async () => {
    await ReliabilityEvent.deleteMany({});
    const telemetry = createTelemetry();
    const running = collectorWith({ telemetry });
    for (let index = 0; index < 8; index += 1) telemetry.emit({ type: "webhook.accepted", component: "webhook", message: `n${index}`, at: Date.now() - index * 1_000 });
    await stores.flushEvents(telemetry.dirtyEvents());
    telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "unflushed" });
    const page = await queries.listEvents({ range: "1h", component: "webhook", limit: 5, running });
    const ids = page.events.map((event) => event.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(page.events.length, 5);
    assert.ok(page.events.some((event) => event.message === "unflushed"));
    assert.ok(page.nextBefore);
    const next = await queries.listEvents({ range: "1h", component: "webhook", limit: 5, before: new Date(page.nextBefore), running });
    assert.ok(next.events.every((event) => !ids.includes(event.id)));
  });

  dbTest("order stages come from the records, through Sentinel's feed", async () => {
    const page = await queries.listEvents({ range: "1h", type: "order", running: collectorWith() });
    assert.ok(page.events.length >= 1);
    assert.ok(page.events.every((event) => event.type.startsWith("order.")));
    assert.ok(page.events.every((event) => event.source === "records"));
  });

  dbTest("a severity filter is a floor, in the database too", async () => {
    await ReliabilityEvent.deleteMany({});
    const telemetry = createTelemetry();
    telemetry.emit({ type: "webhook.accepted", component: "webhook", message: "info" });
    telemetry.emit({ type: "webhook.rejected", severity: "warning", component: "webhook", message: "warn" });
    telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "err" });
    await stores.flushEvents(telemetry.dirtyEvents());
    const page = await queries.listEvents({ range: "1h", severity: "warning", component: "webhook", running: collectorWith() });
    assert.deepEqual(page.events.map((event) => event.message).sort(), ["err", "warn"]);
  });
});

describe("bounded queries", () => {
  const stage = (plan) => JSON.stringify(plan);

  dbTest("the backlog is served by the recovery index", async () => {
    const plan = await WalletPurchase.find({ status: { $in: workflow.UNRESOLVED_STATUSES } }).sort({ createdAt: 1 }).limit(50).explain("queryPlanner");
    assert.ok(!stage(plan.queryPlanner.winningPlan).includes("COLLSCAN"), stage(plan.queryPlanner.winningPlan).slice(0, 300));
  });

  dbTest("undelivered services are found without walking every completed order", async () => {
    await WalletPurchase.collection.insertMany(Array.from({ length: 300 }, (_, index) => ({ purchaseId: `bulk-${index}`, telegramId: "1", planId: "p", gig: 1, days: 1, amount: 1, status: "completed", notificationPending: false, createdAt: ago(MIN), completedAt: ago(MIN) })));
    await orderIn("completed", { completedAt: ago(30 * MIN), notificationPending: true });
    const before = new Date(Date.now() - 2 * MIN);
    const backlog = await WalletPurchase.find({ notificationPending: true }).sort({ completedAt: 1 }).limit(50).explain("executionStats");
    assert.ok(backlog.executionStats.totalDocsExamined <= 10, `backlog examined ${backlog.executionStats.totalDocsExamined}`);
    assert.ok(stage(backlog.queryPlanner.winningPlan).includes("idx_reliability_delivery_pending"));
    // The System Health count, exactly as services/admin/monitoring.js builds it.
    const count = await WalletPurchase.collection.find({ status: "completed", notificationPending: true, $or: [{ completedAt: { $lt: before } }, { completedAt: null, createdAt: { $lt: before } }] }).explain("executionStats");
    assert.ok(count.executionStats.totalDocsExamined <= 10, `count examined ${count.executionStats.totalDocsExamined}`);
    await WalletPurchase.collection.deleteMany({ purchaseId: /^bulk-/ });
  });

  dbTest("event listing uses an index", async () => {
    const plan = await ReliabilityEvent.find({ at: { $gte: ago(60 * MIN) }, component: "webhook", severity: { $ne: "debug" } }).sort({ at: -1 }).limit(51).explain("queryPlanner");
    assert.ok(!stage(plan.queryPlanner.winningPlan).includes("COLLSCAN"));
  });

  dbTest("a page of incidents uses an index", async () => {
    const plan = await ReliabilityIncident.find({ state: "open" }).sort({ state: 1, rank: 1, lastDetectedAt: -1 }).limit(25).explain("queryPlanner");
    assert.ok(!stage(plan.queryPlanner.winningPlan).includes("COLLSCAN"));
  });

  dbTest("telemetry expires by itself", async () => {
    const ttl = async (model, name) => (await model.collection.indexes()).find((index) => index.name === name)?.expireAfterSeconds;
    assert.equal(await ttl(ReliabilityEvent, "ttl_reliability_event"), 7 * 24 * 60 * 60);
    assert.equal(await ttl(ReliabilityRollup, "ttl_reliability_rollup"), 2 * 24 * 60 * 60);
    assert.equal(await ttl(ReliabilityIncident, "ttl_reliability_incident"), 90 * 24 * 60 * 60);
  });

  dbTest("an open incident has no expiry: the TTL is limited to resolved rows", async () => {
    const index = (await ReliabilityIncident.collection.indexes()).find((item) => item.name === "ttl_reliability_incident");
    assert.deepEqual(index.partialFilterExpression, { state: "resolved" });
  });
});
