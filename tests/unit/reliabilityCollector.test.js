/**
 * The collector with everything injected: probes that fail, a database that disappears, a store that throws. No MongoDB is
 * needed, because the point is what happens without one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCollector } from "../../services/reliability/collector.js";
import { createIncidentTracker } from "../../services/reliability/incidents.js";
import { applyFreshness } from "../../services/reliability/health.js";
import { createTelemetry } from "../../services/reliability/telemetry.js";

const MINUTE = 60_000;
const healthy = (latencyMs = 5, details) => async () => ({ status: "healthy", latencyMs, error: null, details });
const refused = async () => ({ status: "down", latencyMs: null, error: "connection refused" });
const orders = (details = {}) => async () => ({ status: "healthy", latencyMs: 4, error: null, details: { needsReview: 0, stalledProvisioning: 0, ledgerStalled: 0, awaitingProvider: 0, refundPending: 0, deliveryPending: 0, alertPending: 0, ...details } });

function memoryStores() {
  const stores = {
    incidents: new Map(),
    events: new Map(),
    rollups: new Map(),
    fail: false,
    async writeIncidents(list) {
      if (stores.fail) throw new Error("write failed");
      for (const item of list) stores.incidents.set(item.incidentId, JSON.parse(JSON.stringify(item)));
      return list;
    },
    async flushEvents(list) {
      if (stores.fail) throw new Error("write failed");
      for (const item of list) stores.events.set(item.id, item);
      return list;
    },
    async flushRollups(list) {
      if (stores.fail) throw new Error("write failed");
      for (const item of list) stores.rollups.set(item.t, JSON.parse(JSON.stringify(item)));
      return list;
    },
    async loadRollups() { return [...stores.rollups.values()]; },
    async loadIncidentsForResume() { return { open: [...stores.incidents.values()].filter((item) => item.state === "open"), resolved: [] }; },
  };
  return stores;
}

function checkpointStub() {
  const row = { name: "service-reliability", leaseOwner: null, leaseUntil: null, state: {} };
  return { collection: { updateOne: async () => ({ matchedCount: 1 }), findOneAndUpdate: async () => row, findOne: async () => row } };
}

function setup(overrides = {}) {
  let clock = overrides.start ?? 1_800_000_000_000;
  const database = { ready: overrides.databaseReady ?? true };
  const stores = overrides.stores || memoryStores();
  const telemetry = overrides.telemetry || createTelemetry({ now: () => clock });
  const published = [];
  const probes = { mongodb: healthy(), redis: healthy(), express: healthy(), telegram: healthy(100, { webhook: { registered: false, pendingUpdates: 0 } }), wizardxray: healthy(200), hooshpay: healthy(), orders: orders(), ...overrides.probes };
  const collector = createCollector({
    env: {},
    config: { enabled: true, intervalMs: 30_000, probeIntervalMs: 60_000 },
    probes,
    telemetry,
    tracker: overrides.tracker || createIncidentTracker(),
    now: () => clock,
    sources: overrides.sources ?? { purchases: { find: () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS: async () => [] }) } },
    polling: () => overrides.polling ?? ({ failing: false, stalled: false, lastErrorAgeSec: null, lastErrorStatus: null, lastSuccessAgeSec: 3 }),
    sentinel: async () => ({ health: "healthy" }),
    databaseReady: () => database.ready,
    checkpointModel: checkpointStub(),
    stores,
    publish: (snapshot) => published.push(snapshot),
    eventLoop: { p50Ms: 1, p99Ms: 10, maxMs: 20 },
  });
  return { collector, stores, database, telemetry, published, probes, advance(ms) { clock += ms; }, now: () => clock };
}

const state = (snapshot, id) => snapshot.components.find((item) => item.id === id).state;

describe("a healthy tick", () => {
  test("publishes a snapshot with an overall state", async () => {
    const { collector, published } = setup();
    assert.equal((await collector.tick()).ok, true);
    assert.equal(published.length, 1);
    assert.equal(published[0].overall.state, "healthy");
    assert.equal(published[0].components.length, 12);
    assert.equal(published[0].edges.length, 14);
  });

  test("reports what it could not verify rather than calling it healthy", async () => {
    const { collector } = setup();
    await collector.tick();
    const snapshot = collector.snapshot();
    assert.equal(state(snapshot, "hooshpay"), "unknown");
    assert.ok(snapshot.overall.unverified.includes("hooshpay"));
  });

  test("slow probes run on their own cadence", async () => {
    const calls = { wizard: 0, mongo: 0 };
    const { collector, advance } = setup({ probes: { wizardxray: async () => { calls.wizard += 1; return { status: "healthy", latencyMs: 1 }; }, mongodb: async () => { calls.mongo += 1; return { status: "healthy", latencyMs: 1 }; } } });
    await collector.tick();
    advance(30_000);
    await collector.tick();
    advance(30_000);
    await collector.tick();
    assert.equal(calls.mongo, 3);
    assert.equal(calls.wizard, 2);
  });

  test("ticks cannot overlap", async () => {
    let release;
    const { collector } = setup({ probes: { mongodb: () => new Promise((resolve) => { release = () => resolve({ status: "healthy", latencyMs: 1 }); }) } });
    const first = collector.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await collector.tick(), { skipped: "already_running" });
    release();
    await first;
  });

  test("traffic on an edge is real traffic", async () => {
    const { collector, telemetry } = setup();
    await collector.tick();
    assert.equal(collector.snapshot().edges.find((edge) => edge.id === "telegram-polling").count, 0);
    telemetry.observe("telegram.update");
    telemetry.observe("telegram.update");
    await collector.tick();
    assert.equal(collector.snapshot().edges.find((edge) => edge.id === "telegram-polling").count, 2);
    assert.equal(collector.snapshot().edges.find((edge) => edge.id === "orders-redis").measured, false);
  });
});

describe("failures are contained", () => {
  test("a probe that throws is a failed check, not a failed tick", async () => {
    const { collector } = setup({ probes: { redis: async () => { throw new Error("boom"); } } });
    assert.equal((await collector.tick()).ok, true);
    assert.equal(state(collector.snapshot(), "redis"), "failed");
  });

  test("a probe's error text is sanitized before it goes anywhere", async () => {
    const token = `${"123456"}:${"B".repeat(30)}`;
    const { collector } = setup({ probes: { telegram: async () => ({ status: "down", latencyMs: null, error: `failed for ${token}` }) } });
    await collector.tick();
    assert.ok(!JSON.stringify(collector.snapshot()).includes(token));
  });

  test("Persian probe wording reaches the English panel in English", async () => {
    const { collector } = setup({ probes: { wizardxray: async () => ({ status: "down", latencyMs: null, error: "مهلت درخواست پایان یافت" }) } });
    await collector.tick();
    assert.match(collector.snapshot().components.find((item) => item.id === "wizardxray").reason, /timed out/);
  });

  test("a Redis failure is reported and everything else keeps working", async () => {
    const { collector, advance } = setup({ probes: { redis: refused } });
    await collector.tick();
    advance(30_000);
    await collector.tick();
    const snapshot = collector.snapshot();
    assert.equal(snapshot.overall.state, "failed");
    assert.equal(state(snapshot, "mongodb"), "healthy");
    assert.ok(snapshot.incidents.open.some((item) => item.code === "DEPENDENCY_DOWN" && item.component === "redis"));
  });

  test("a state change is an event, once", async () => {
    let failing = false;
    const { collector, telemetry, advance } = setup({ probes: { redis: async () => (failing ? { status: "down", latencyMs: null, error: "x" } : { status: "healthy", latencyMs: 1 }) } });
    await collector.tick();
    failing = true;
    advance(30_000);
    await collector.tick();
    advance(30_000);
    await collector.tick();
    assert.equal(telemetry.events().filter((event) => event.type === "dependency.changed" && event.component === "redis").length, 1);
  });

  test("a tick that blows up leaves the last tick time alone, so the panel goes stale by itself", async () => {
    const telemetry = createTelemetry();
    let broken = false;
    const original = telemetry.stampHealth;
    telemetry.stampHealth = (...args) => { if (broken) throw new Error("bug"); return original(...args); };
    const { collector, advance, now } = setup({ telemetry });
    await collector.tick();
    const before = collector.snapshot().monitoring.lastTickAt;
    broken = true;
    advance(600_000);
    assert.equal((await collector.tick()).ok, false);
    assert.equal(collector.snapshot().monitoring.lastTickAt, before);
    const shown = applyFreshness(collector.snapshot(), { now: now(), config: collector.config });
    assert.equal(shown.overall.state, "stale");
  });
});

describe("a MongoDB outage", () => {
  test("the outage itself is recorded, and written when the database returns", async () => {
    const { collector, stores, database, advance } = setup({ probes: { mongodb: refused } });
    database.ready = false;
    await collector.tick();
    advance(30_000);
    await collector.tick();
    const snapshot = collector.snapshot();
    const incident = snapshot.incidents.open.find((item) => item.component === "mongodb");
    assert.ok(incident, "known in memory while the database is down");
    assert.equal(stores.incidents.size, 0);
    assert.equal(snapshot.monitoring.persistence.state, "waiting");

    database.ready = true;
    advance(30_000);
    await collector.tick();
    assert.equal(stores.incidents.size, 1, "written after the fact");
    assert.equal(new Date([...stores.incidents.values()][0].firstDetectedAt).getTime(), new Date(incident.firstDetectedAt).getTime());
  });

  test("order figures read as unavailable, never as zero", async () => {
    const { collector, database } = setup({ probes: { orders: refused } });
    database.ready = false;
    await collector.tick();
    const snapshot = collector.snapshot();
    assert.equal(snapshot.orders.available, false);
    assert.equal(snapshot.orders.overdueCount, null);
    assert.equal(snapshot.metrics["15m"].orders, null);
    assert.equal(state(snapshot, "orders"), "unknown");
  });

  test("the telemetry is not lost: it flushes when the database returns", async () => {
    const { collector, stores, database, telemetry, advance } = setup({ databaseReady: false });
    telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "x" });
    telemetry.observe("http.admin");
    await collector.tick();
    assert.equal(stores.events.size, 0);
    database.ready = true;
    advance(2 * MINUTE);
    await collector.tick();
    assert.ok(stores.events.size >= 1);
    assert.ok(stores.rollups.size >= 1);
  });

  test("an open incident survives the outage when its rule cannot be evaluated", async () => {
    let details = { needsReview: 2 };
    const { collector, database, advance } = setup({ probes: { orders: async () => (details ? { status: "degraded", latencyMs: 1, error: "x", details: { needsReview: 2, stalledProvisioning: 0, ledgerStalled: 0, awaitingProvider: 0, refundPending: 0, deliveryPending: 0, alertPending: 0 } } : { status: "down", latencyMs: null, error: "not connected" }) } });
    await collector.tick();
    assert.equal(collector.snapshot().incidents.openCount, 1);
    details = null;
    database.ready = false;
    for (let index = 0; index < 10; index += 1) { advance(MINUTE); await collector.tick(); }
    assert.equal(collector.snapshot().incidents.open.filter((item) => item.code === "ORDERS_NEED_REVIEW").length, 1);
  });
});

describe("persistence", () => {
  test("a failing write is counted, and raises its own incident after three", async () => {
    const stores = memoryStores();
    stores.fail = true;
    const { collector, advance } = setup({ stores });
    for (let index = 0; index < 5; index += 1) { await collector.tick(); advance(30_000); }
    const snapshot = collector.snapshot();
    assert.equal(snapshot.monitoring.persistence.state, "failing");
    assert.ok(snapshot.monitoring.persistence.failures >= 3);
    assert.ok(snapshot.incidents.open.some((item) => item.code === "TELEMETRY_NOT_PERSISTED"));
  });

  test("a restart restores history and continues the same incidents", async () => {
    const stores = memoryStores();
    const first = setup({ stores, probes: { redis: refused } });
    await first.collector.tick();
    first.advance(30_000);
    first.telemetry.observe("http.admin");
    first.advance(2 * MINUTE);
    await first.collector.tick();
    const [incident] = [...stores.incidents.values()];
    assert.ok(incident);

    const second = setup({ stores, start: first.now(), probes: { redis: refused } });
    await second.collector.tick();
    assert.equal(second.collector.snapshot().incidents.open[0].id, incident.incidentId);
    assert.ok(second.telemetry.minutes().some((minute) => minute.series["http.admin"]), "history restored");
  });
});

describe("timers", () => {
  test("start is idempotent, and stop clears everything", async () => {
    const { collector } = setup();
    assert.equal(collector.start(), true);
    assert.equal(collector.start(), false);
    await collector.stop();
    assert.equal(collector.start(), true);
    await collector.stop();
  });

  test("monitoring switched off starts nothing", () => {
    const collector = createCollector({ env: {}, config: { enabled: false, intervalMs: 30_000, probeIntervalMs: 60_000 }, probes: {}, telemetry: createTelemetry(), tracker: createIncidentTracker() });
    assert.equal(collector.start(), false);
  });
});
