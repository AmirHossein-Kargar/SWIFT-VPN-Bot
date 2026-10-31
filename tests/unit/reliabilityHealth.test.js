/**
 * The rule behind the whole feature: healthy needs positive evidence. Each case gives the derivation a situation where a
 * careless monitor would say healthy, and checks that it does not.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyFreshness, deriveComponents, deriveOverall, jobStates, probeState, worstState } from "../../services/reliability/health.js";
import { COMPONENT_IDS, JOBS, blastRadius, readReliabilityConfig } from "../../services/reliability/constants.js";

const NOW = 1_800_000_000_000;
const config = { enabled: true, intervalMs: 30_000, probeIntervalMs: 60_000 };
const ok = (latencyMs = 20, extra = {}) => ({ status: "healthy", latencyMs, error: null, details: null, at: NOW - 1_000, lastSuccessAt: NOW - 1_000, lastFailureAt: null, failures: 0, ...extra });
const down = (error = "connection refused", extra = {}) => ({ status: "down", latencyMs: null, error, details: null, at: NOW - 1_000, lastSuccessAt: NOW - 600_000, lastFailureAt: NOW - 1_000, failures: 2, ...extra });
const orderProbe = (details = {}, extra = {}) => ok(30, { details: { needsReview: 0, stalledProvisioning: 0, ledgerStalled: 0, awaitingProvider: 0, refundPending: 0, deliveryPending: 0, alertPending: 0, ...details }, ...extra });
const minute = (series, t = NOW - 120_000) => ({ t, series, health: {} });
const count = (fields) => ({ n: 0, ok: 0, err: 0, rej: 0, tmo: 0, sumMs: 0, timed: 0, h: new Array(12).fill(0), ...fields });
const providers = (overrides = {}) => [
  { id: "hooshpay", label: "HooshPay", configured: true, secretConfigured: true, lastRequestOkAt: null, lastWebhookOkAt: null, ...overrides.hooshpay },
  { id: "nowpayments", label: "NOWPayments", configured: true, secretConfigured: true, lastRequestOkAt: null, lastWebhookOkAt: null, ...overrides.nowpayments },
];
const polling = { failing: false, stalled: false, lastErrorAgeSec: null, lastErrorStatus: null, lastSuccessAgeSec: 4 };
const healthyJobs = JOBS.filter((job) => job.enabled({})).map((job) => ({ name: job.name, label: job.label, state: "healthy", reason: "Ran on schedule." }));

function derive(overrides = {}) {
  return deriveComponents({
    now: NOW,
    config,
    probes: { mongodb: ok(), redis: ok(), express: ok(5), telegram: ok(120, { details: { webhook: { registered: false, pendingUpdates: 0 } } }), wizardxray: ok(300), orders: orderProbe(), ...overrides.probes },
    minutes: overrides.minutes ?? [],
    polling: overrides.polling === undefined ? polling : overrides.polling,
    jobs: overrides.jobs ?? healthyJobs,
    eventLoop: overrides.eventLoop ?? { p50Ms: 1, p99Ms: 12, maxMs: 40 },
    providers: overrides.providers ?? providers(),
    lastDeliveryOkAt: overrides.lastDeliveryOkAt ?? null,
  });
}
const byId = (components) => Object.fromEntries(components.map((item) => [item.id, item]));

describe("probe age", () => {
  test("no check yet is unknown, never healthy", () => assert.equal(probeState(null, 30_000, NOW).state, "unknown"));
  test("a fresh success is healthy", () => assert.equal(probeState(ok(), 30_000, NOW).state, "healthy"));
  test("an old success is stale, whatever it said", () => assert.equal(probeState(ok(5, { at: NOW - 120_000 }), 30_000, NOW).state, "stale"));
  test("a failure is failed, and carries its reason", () => {
    const result = probeState(down("timed out"), 30_000, NOW);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "timed out");
  });
  test("an unrecognized status is unknown", () => assert.equal(probeState(ok(5, { status: "maybe" }), 30_000, NOW).state, "unknown"));
});

describe("no errors is not evidence", () => {
  test("a provider with no traffic is unknown, though nothing went wrong", () => {
    const { hooshpay, nowpayments } = byId(derive());
    assert.equal(hooshpay.state, "unknown");
    assert.equal(nowpayments.state, "unknown");
    assert.match(hooshpay.reason, /nothing has proven/i);
  });

  test("the provider row says plainly that reachability is not checked", () => {
    const { hooshpay } = byId(derive());
    assert.ok(hooshpay.details.some((row) => /only configuration/i.test(row.value)));
  });

  test("a provider becomes healthy only through a real success", () => {
    const { hooshpay } = byId(derive({ minutes: [minute({ "webhook.hooshpay": count({ n: 1, ok: 1 }) })], providers: providers({ hooshpay: { lastWebhookOkAt: NOW - 60_000 } }) }));
    assert.equal(hooshpay.state, "healthy");
    assert.ok(hooshpay.lastSuccessAt);
  });

  test("an unconfigured provider is unknown and says why", () => {
    const { nowpayments } = byId(derive({ providers: providers({ nowpayments: { configured: false } }) }));
    assert.equal(nowpayments.state, "unknown");
    assert.match(nowpayments.reason, /not configured/);
  });

  test("a webhook path nobody has called is unknown", () => {
    assert.equal(byId(derive()).webhook.state, "unknown");
  });

  test("delivery with an empty outbox and nothing sent is unknown", () => {
    assert.equal(byId(derive()).delivery.state, "unknown");
  });

  test("polling that has not completed once is unknown", () => {
    assert.equal(byId(derive({ polling: { ...polling, lastSuccessAgeSec: null } })).polling.state, "unknown");
    assert.equal(byId(derive({ polling: null })).polling.state, "unknown");
  });

  test("a job that has not reported yet is unknown", () => {
    const jobs = jobStates([], { now: NOW, startedAt: NOW - 1_000, env: {} });
    assert.ok(jobs.every((job) => job.state === "unknown"));
  });
});

describe("failed and degraded", () => {
  test("a down database is failed", () => assert.equal(byId(derive({ probes: { mongodb: down() } })).mongodb.state, "failed"));

  test("orders that cannot be read are unknown, not failed and not healthy", () => {
    const { orders, delivery } = byId(derive({ probes: { mongodb: down(), orders: { ...down("not connected"), details: null } } }));
    assert.equal(orders.state, "unknown");
    assert.equal(delivery.state, "unknown");
  });

  test("waiting orders degrade the workflow", () => {
    assert.equal(byId(derive({ probes: { orders: orderProbe({ needsReview: 2 }, { status: "degraded", error: "2 order(s) need manual reconciliation" }) } })).orders.state, "degraded");
  });

  test("polling, conflict and stall states match System Health", () => {
    assert.equal(byId(derive({ polling: { ...polling, failing: true, lastErrorStatus: 409 } })).polling.state, "failed");
    assert.equal(byId(derive({ polling: { ...polling, failing: true, lastErrorStatus: 502 } })).polling.state, "degraded");
    assert.equal(byId(derive({ polling: { ...polling, stalled: true } })).polling.state, "degraded");
  });

  test("a missing webhook secret fails closed", () => {
    const { webhook } = byId(derive({ providers: providers({ hooshpay: { secretConfigured: false } }) }));
    assert.equal(webhook.state, "failed");
    assert.match(webhook.reason, /secret is missing/);
  });

  test("failing callbacks fail the path, and rejected ones do not", () => {
    assert.equal(byId(derive({ minutes: [minute({ "webhook.hooshpay": count({ n: 3, err: 3 }) })] })).webhook.state, "failed");
    assert.equal(byId(derive({ minutes: [minute({ "webhook.hooshpay": count({ n: 40, rej: 40 }) })] })).webhook.state, "unknown");
  });

  test("timeouts on a provider degrade or fail it", () => {
    assert.equal(byId(derive({ minutes: [minute({ "provider.hooshpay": count({ n: 4, tmo: 4 }) })] })).hooshpay.state, "failed");
    assert.equal(byId(derive({ minutes: [minute({ "provider.hooshpay": count({ n: 5, ok: 4, err: 1 }) })] })).hooshpay.state, "degraded");
  });

  test("WizardXray answering /status while creates fail is degraded", () => {
    assert.equal(byId(derive({ minutes: [minute({ "provider.wizardxray.create": count({ n: 4, err: 4 }) })] })).wizardxray.state, "degraded");
  });

  test("a registered webhook or a backlog degrades Telegram, and a missing getMe fails it", () => {
    assert.equal(byId(derive({ probes: { telegram: ok(100, { details: { webhook: { registered: true } } }) } })).telegram.state, "degraded");
    assert.equal(byId(derive({ probes: { telegram: ok(100, { details: { webhook: { pendingUpdates: 500 } } }) } })).telegram.state, "degraded");
    assert.equal(byId(derive({ probes: { telegram: down("Error") } })).telegram.state, "failed");
  });

  test("a blocked event loop degrades the server", () => {
    assert.equal(byId(derive({ eventLoop: { p50Ms: 1, p99Ms: 4_000, maxMs: 6_000 } })).express.state, "degraded");
  });

  test("a job failing twice is failed, and an overdue one is degraded", () => {
    const [failing] = jobStates([{ name: "nowpayments-recovery", lastRunAt: NOW - 1_000, lastOkAt: null, consecutiveFailures: 2, runs: 2 }], { now: NOW, startedAt: NOW - 3_600_000, env: {} }).filter((job) => job.name === "nowpayments-recovery");
    assert.equal(failing.state, "failed");
    const [overdue] = jobStates([{ name: "nowpayments-recovery", lastRunAt: NOW - 3_600_000, lastOkAt: NOW - 3_600_000, consecutiveFailures: 0, runs: 3 }], { now: NOW, startedAt: NOW - 7_200_000, env: {} }).filter((job) => job.name === "nowpayments-recovery");
    assert.equal(overdue.state, "degraded");
  });

  test("a job that should have reported long ago and never did is failed", () => {
    const jobs = jobStates([], { now: NOW, startedAt: NOW - 3_600_000, env: {} });
    assert.equal(jobs.find((job) => job.name === "nowpayments-recovery").state, "failed");
  });

  test("a switched-off job is not expected", () => {
    const names = jobStates([], { now: NOW, startedAt: NOW, env: { SENTINEL_ENABLED: "off", USER_SPEND_SWEEPER: "off" } }).map((job) => job.name);
    assert.ok(!names.includes("money-flow-sentinel"));
    assert.ok(!names.includes("user-spend-sweeper"));
  });

  test("the TRX scanner is expected only with a wallet", () => {
    assert.ok(!jobStates([], { now: NOW, startedAt: NOW, env: {} }).some((job) => job.name === "trx-scanner"));
    assert.ok(jobStates([], { now: NOW, startedAt: NOW, env: { TRX_WALLET: "x" } }).some((job) => job.name === "trx-scanner"));
  });
});

describe("overall", () => {
  test("every critical component with evidence is healthy, and blind spots elsewhere are listed", () => {
    const overall = deriveOverall(derive());
    assert.equal(overall.state, "healthy");
    assert.deepEqual(overall.unverified.sort(), ["delivery", "hooshpay", "nowpayments", "webhook"]);
  });

  test("a failed critical component is overall failure", () => {
    assert.equal(deriveOverall(derive({ probes: { redis: down() } })).state, "failed");
  });

  test("a failed optional component is degradation", () => {
    const components = derive({ minutes: [minute({ "provider.hooshpay": count({ n: 4, err: 4 }) })] });
    assert.equal(deriveOverall(components).state, "degraded");
  });

  test("blindness on a critical component beats healthy", () => {
    const overall = deriveOverall(derive({ polling: null }));
    assert.equal(overall.state, "unknown");
    assert.match(overall.reason, /Polling loop/);
  });

  test("a stale critical component reads stale", () => {
    assert.equal(deriveOverall(derive({ probes: { redis: ok(5, { at: NOW - 600_000 }) } })).state, "stale");
  });

  test("the worst state wins", () => {
    assert.equal(worstState(["healthy", "unknown", "degraded"]), "degraded");
    assert.equal(worstState(["healthy", "failed", "degraded"]), "failed");
    assert.equal(worstState(["healthy"]), "healthy");
  });

  test("there are twelve components, in a fixed order", () => {
    assert.deepEqual(derive().map((item) => item.id), COMPONENT_IDS);
  });
});

describe("a dead monitor cannot look healthy", () => {
  const healthy = (lastTickAt) => {
    const components = derive();
    return { monitoring: { lastTickAt: new Date(lastTickAt).toISOString() }, overall: deriveOverall(components), components, edges: [{ id: "a", measured: true, count: 9, perMinute: 1 }] };
  };

  test("a recent snapshot stands", () => {
    const result = applyFreshness(healthy(NOW - 10_000), { now: NOW, config });
    assert.equal(result.overall.state, "healthy");
    assert.equal(result.monitoring.fresh, true);
  });

  test("an old one goes stale, overall and per component, and its traffic disappears", () => {
    const result = applyFreshness(healthy(NOW - 300_000), { now: NOW, config });
    assert.equal(result.overall.state, "stale");
    assert.ok(result.components.every((item) => item.state === "stale"));
    assert.equal(result.monitoring.fresh, false);
    assert.equal(result.edges[0].measured, false);
    assert.equal(result.edges[0].perMinute, null);
  });

  test("the reason keeps the last known state", () => {
    const result = applyFreshness(healthy(NOW - 300_000), { now: NOW, config });
    assert.match(result.components[0].reason, /Last known: healthy/);
  });

  test("switched-off monitoring reads unknown, never healthy", () => {
    const result = applyFreshness(healthy(NOW), { now: NOW, config: { ...config, enabled: false } });
    assert.equal(result.overall.state, "unknown");
    assert.ok(result.components.every((item) => item.state === "unknown"));
  });
});

describe("configuration and dependencies", () => {
  test("defaults, and an out-of-range value falls back", () => {
    assert.deepEqual(readReliabilityConfig({}), { enabled: true, intervalMs: 30_000, probeIntervalMs: 60_000 });
    assert.equal(readReliabilityConfig({ RELIABILITY_INTERVAL_SECONDS: "1" }).intervalMs, 30_000);
    assert.equal(readReliabilityConfig({ RELIABILITY_PROBE_SECONDS: "abc" }).probeIntervalMs, 60_000);
    assert.equal(readReliabilityConfig({ RELIABILITY_ENABLED: "OFF" }).enabled, false);
  });

  test("the blast radius follows real dependencies", () => {
    const mongo = blastRadius("mongodb");
    assert.ok(["webhook", "orders", "jobs", "delivery"].every((id) => mongo.includes(id)));
    assert.ok(!mongo.includes("telegram"));
    assert.deepEqual(blastRadius("delivery"), ["delivery"]);
  });
});
