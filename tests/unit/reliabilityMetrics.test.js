/** The numbers on the panel: windows, sample floors, coverage, and gaps that must stay gaps. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { coverage, edgeTraffic, histogramPercentile, historySeries, percentiles, rawPercentiles, sumSeries, windowMetrics } from "../../services/reliability/metrics.js";
import { LATENCY_BOUNDS_MS, bucketIndex } from "../../services/reliability/telemetry.js";
import { cohortStats, traceOrder } from "../../services/reliability/workflow.js";

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % 60_000);
const MINUTE = 60_000;

function series(fields = {}, samples = []) {
  const h = new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
  for (const ms of samples) h[bucketIndex(ms)] += 1;
  return { n: 0, ok: 0, err: 0, rej: 0, tmo: 0, sumMs: samples.reduce((a, b) => a + b, 0), timed: samples.length, h, ...fields };
}
const minuteAt = (ago, entries = {}, health = {}) => ({ t: NOW - ago * MINUTE, series: entries, health });
const span = (count) => Array.from({ length: count }, (_, index) => minuteAt(index + 1));

describe("percentiles", () => {
  test("too few samples give no percentile at all", () => {
    assert.deepEqual(percentiles(series({}, [100, 100, 100, 100])), { samples: 4, p50: null, p95: null, p99: null });
  });

  test("each percentile has its own floor", () => {
    const ten = percentiles(series({}, new Array(10).fill(100)));
    assert.ok(ten.p50);
    assert.equal(ten.p95, null);
    assert.equal(ten.p99, null);
    const fifty = percentiles(series({}, new Array(50).fill(100)));
    assert.ok(fifty.p95);
    assert.equal(fifty.p99, null);
    assert.ok(percentiles(series({}, new Array(100).fill(100))).p99);
  });

  test("a histogram value is the bucket's upper bound", () => {
    const stats = percentiles(series({}, [...new Array(95).fill(30), ...new Array(5).fill(900)]));
    assert.equal(stats.p50.valueMs, 50);
    assert.equal(stats.p95.valueMs, 50);
    assert.equal(stats.p99.valueMs, 1_000);
  });

  test("beyond the last bucket reports `over`, never an invented number", () => {
    const h = new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
    h[h.length - 1] = 10;
    assert.deepEqual(histogramPercentile(h, 10, 0.5), { valueMs: null, over: true });
  });

  test("raw durations are exact, with the same floors", () => {
    assert.equal(rawPercentiles([1, 2, 3, 4]).p50, null);
    assert.equal(rawPercentiles([10, 20, 30, 40, 50]).p50.valueMs, 30);
    assert.equal(rawPercentiles([null, NaN, -1, 5]).samples, 1);
  });
});

describe("windows", () => {
  test("a series adds up across minutes", () => {
    const total = sumSeries([minuteAt(1, { "http.admin": series({ n: 2, ok: 2 }) }), minuteAt(2, { "http.admin": series({ n: 3, err: 3 }), "http.panel": series({ n: 9, ok: 9 }) })], ["http.admin"]);
    assert.deepEqual([total.n, total.ok, total.err], [5, 2, 3]);
  });

  test("a window sees only its own minutes", () => {
    const minutes = [minuteAt(5, { "webhook.hooshpay": series({ n: 1, ok: 1 }) }), minuteAt(30, { "webhook.hooshpay": series({ n: 10, ok: 10 }) }), minuteAt(200, { "webhook.hooshpay": series({ n: 100, ok: 100 }) })];
    assert.equal(windowMetrics(minutes, "15m", { now: NOW, startedAt: NOW }).throughput.webhooks, 1);
    assert.equal(windowMetrics(minutes, "1h", { now: NOW, startedAt: NOW }).throughput.webhooks, 11);
    assert.equal(windowMetrics(minutes, "6h", { now: NOW, startedAt: NOW }).throughput.webhooks, 111);
  });

  test("a rate needs enough attempts, and is otherwise null", () => {
    const thin = windowMetrics([minuteAt(1, { "http.admin": series({ n: 4, ok: 3, err: 1 }) })], "15m", { now: NOW, startedAt: NOW });
    assert.equal(thin.errors.rate, null);
    assert.equal(thin.errors.count, 1);
    const enough = windowMetrics([minuteAt(1, { "http.admin": series({ n: 10, ok: 9, err: 1 }) })], "15m", { now: NOW, startedAt: NOW });
    assert.equal(enough.errors.rate, 0.1);
  });

  test("a rejected callback is not an error", () => {
    const metrics = windowMetrics([minuteAt(1, { "webhook.hooshpay": series({ n: 50, rej: 50 }) })], "15m", { now: NOW, startedAt: NOW });
    assert.equal(metrics.errors.count, 0);
    assert.equal(metrics.errors.rejectedCallbacks, 50);
  });

  test("a timeout counts in the error rate and the timeout rate", () => {
    const metrics = windowMetrics([minuteAt(1, { "provider.hooshpay": series({ n: 5, ok: 3, tmo: 2 }) })], "15m", { now: NOW, startedAt: NOW });
    assert.equal(metrics.timeouts.rate, 0.4);
    assert.equal(metrics.errors.count, 2);
  });
});

describe("coverage", () => {
  test("a full window says so", () => {
    assert.equal(coverage(span(60), 60 * MINUTE, NOW, NOW).ratio, 1);
  });

  test("a process that started ten minutes ago has observed ten minutes", () => {
    const result = coverage(span(10), 24 * 60 * MINUTE, NOW, NOW - 10 * MINUTE);
    assert.equal(result.observedMinutes, 10);
    assert.equal(result.expectedMinutes, 1440);
  });

  test("rates use observed minutes, so a young process is not diluted", () => {
    const minutes = span(10).map((minute) => ({ ...minute, series: { "http.admin": series({ n: 6, ok: 6 }) } }));
    assert.equal(windowMetrics(minutes, "24h", { now: NOW, startedAt: NOW }).throughput.perMinute, 6);
  });

  test("two processes in one minute count as one observed minute", () => {
    assert.equal(coverage([minuteAt(1), minuteAt(1)], 15 * MINUTE, NOW, NOW).observedMinutes, 1);
  });
});

describe("history", () => {
  test("a bucket nobody measured is null, not zero", () => {
    const points = historySeries([minuteAt(1, { "http.admin": series({ n: 5, ok: 5 }) })], "15m", { now: NOW });
    const measured = points.filter((point) => point.measured);
    const gaps = points.filter((point) => !point.measured);
    assert.equal(measured.length, 1);
    assert.equal(measured[0].requests, 5);
    assert.ok(gaps.length >= 14);
    assert.ok(gaps.every((point) => point.requests === null && point.errors === null && point.p95Ms === null));
  });

  test("a quiet measured minute is a real zero", () => {
    const points = historySeries([minuteAt(1)], "15m", { now: NOW });
    assert.equal(points.find((point) => point.measured).requests, 0);
  });

  test("a bucket keeps the worst state it saw", () => {
    const points = historySeries([minuteAt(2, {}, { redis: "healthy" }), minuteAt(1, {}, { redis: "failed" })], "1h", { now: NOW });
    assert.ok(points.some((point) => point.health.redis === "failed"));
    assert.ok(!points.some((point) => point.health.redis === "healthy"));
  });

  test("each window has a bounded number of points", () => {
    for (const name of ["15m", "1h", "6h", "24h"]) assert.ok(historySeries([], name, { now: NOW }).length <= 50, name);
  });
});

describe("topology traffic", () => {
  const edge = { kind: "flow", series: ["webhook.hooshpay"] };
  test("traffic comes from the series the edge names", () => {
    const result = edgeTraffic([minuteAt(1, { "webhook.hooshpay": series({ n: 30, ok: 30 }) })], edge, { now: NOW });
    assert.deepEqual(result, { measured: true, count: 30, perMinute: 2 });
  });

  test("a measured link with no traffic is a measured zero", () => {
    assert.deepEqual(edgeTraffic([], edge, { now: NOW }), { measured: true, count: 0, perMinute: 0 });
  });

  test("a dependency has no traffic to report", () => {
    assert.deepEqual(edgeTraffic([], { kind: "uses" }, { now: NOW }), { measured: false, count: null, perMinute: null });
  });

  test("a link counted from records is unmeasured when the records are out of reach", () => {
    assert.equal(edgeTraffic([], { kind: "flow", records: "ordersCreated" }, { now: NOW, records: {} }).measured, false);
    assert.equal(edgeTraffic([], { kind: "flow", records: "ordersCreated" }, { now: NOW, records: { ordersCreated: 3 } }).count, 3);
  });
});

const order = (overrides = {}) => ({ purchaseId: "p1", telegramId: "900100001", planName: "30 day plan", status: "completed", walletDebitStatus: "finalized", createdAt: new Date(NOW - 60_000), reservedAt: new Date(NOW - 59_000), provisioningStartedAt: new Date(NOW - 58_000), provisionedAt: new Date(NOW - 56_000), completedAt: new Date(NOW - 55_000), notifiedAt: new Date(NOW - 54_000), notificationPending: false, refundStatus: "none", recoveryStatus: "none", retryCount: 0, events: [], ...overrides });

describe("fulfilment cohort", () => {
  const rows = [
    ...Array.from({ length: 8 }, () => order()),
    order({ status: "refunded" }),
    order({ status: "provisioning", completedAt: null }),
    order({ status: "failed", reservedAt: null, errorCode: "INSUFFICIENT_BALANCE" }),
  ];

  test("a refused request is not a failed fulfilment, and a running order is neither", () => {
    const stats = cohortStats(rows, 3_600_000, NOW);
    assert.deepEqual([stats.created, stats.attempted, stats.delivered, stats.failed, stats.inFlight], [11, 10, 8, 1, 1]);
    assert.equal(stats.successRate, 8 / 9);
  });

  test("too few settled orders give counts, not a rate", () => {
    assert.equal(cohortStats([order(), order({ status: "refunded" })], 3_600_000, NOW).successRate, null);
  });

  test("only the window's orders count", () => {
    assert.equal(cohortStats([order({ createdAt: new Date(NOW - 7_200_000) })], 3_600_000, NOW).created, 0);
  });

  test("durations are exact, from stored timestamps", () => {
    assert.equal(cohortStats(rows, 3_600_000, NOW).fulfilment.p50.valueMs, 4_000);
  });
});

describe("order trace", () => {
  const stage = (trace, id) => trace.stages.find((item) => item.id === id);

  test("a delivered order has every stage, with durations", () => {
    const trace = traceOrder(order(), { now: NOW });
    assert.deepEqual(trace.stages.map((item) => item.id), ["funding", "created", "reservation", "provider", "fulfilment", "delivery"]);
    assert.equal(stage(trace, "provider").state, "done");
    assert.equal(stage(trace, "provider").durationMs, 2_000);
    assert.equal(stage(trace, "delivery").durationMs, 1_000);
  });

  test("payment is never claimed as linked to an order", () => {
    const funding = stage(traceOrder(order(), { now: NOW }), "funding");
    assert.equal(funding.state, "not_linked");
    assert.equal(funding.basis, "missing");
    assert.match(funding.note, /fungible/);
  });

  test("a stuck stage says it is past its limit", () => {
    const trace = traceOrder(order({ status: "provisioning", provisioningStartedAt: new Date(NOW - 30 * MINUTE), provisionedAt: null, completedAt: null, notifiedAt: null }), { now: NOW });
    const provider = stage(trace, "provider");
    assert.equal(provider.state, "pending");
    assert.equal(provider.durationMs, null);
    assert.equal(provider.waitingMs, 30 * MINUTE);
    assert.equal(provider.delayed.exceeded, true);
  });

  test("the provider's ambiguous answer is shown as such", () => {
    const trace = traceOrder(order({ status: "manual_review", provisionedAt: null, completedAt: null, notifiedAt: null, errorCode: "PANEL_RESULT_UNKNOWN" }), { now: NOW });
    assert.equal(stage(trace, "provider").state, "failed");
    assert.equal(stage(trace, "provider").error, "PANEL_RESULT_UNKNOWN");
    assert.match(stage(trace, "provider").note, /never replayed/);
  });

  test("waiting for provider funds is its own state", () => {
    assert.equal(stage(traceOrder(order({ status: "awaiting_provider", awaitingProviderSince: new Date(NOW - MINUTE), provisionedAt: null, completedAt: null, notifiedAt: null }), { now: NOW }), "provider").state, "waiting");
  });

  test("a refunded order takes the refund branch", () => {
    const trace = traceOrder(order({ status: "refunded", provisionedAt: null, completedAt: null, notifiedAt: null, refundStatus: "completed", refundRequestedAt: new Date(NOW - 5_000), refundedAt: new Date(NOW - 4_000), refundReason: "PROVIDER_REJECTED" }), { now: NOW });
    assert.equal(stage(trace, "refund").state, "done");
    assert.equal(stage(trace, "fulfilment"), undefined);
    assert.equal(stage(trace, "provider").state, "failed");
  });

  test("a request refused for balance stops at reservation", () => {
    const trace = traceOrder(order({ status: "failed", reservedAt: null, walletDebitedAt: null, errorCode: "INSUFFICIENT_BALANCE" }), { now: NOW });
    assert.equal(stage(trace, "reservation").state, "failed");
    assert.equal(stage(trace, "provider"), undefined);
  });

  test("delivery with no timestamp is unknown, not delivered", () => {
    const delivery = stage(traceOrder(order({ notifiedAt: null }), { now: NOW }), "delivery");
    assert.equal(delivery.state, "unknown");
    assert.equal(delivery.basis, "missing");
  });

  test("a missing timestamp is missing, not guessed", () => {
    const provider = stage(traceOrder(order({ provisioningStartedAt: null }), { now: NOW }), "provider");
    assert.equal(provider.basis, "missing");
    assert.equal(provider.startedAt, null);
    assert.equal(provider.durationMs, null);
  });

  test("the customer id is masked and service secrets cannot appear", () => {
    const trace = traceOrder(order({ serviceLink: "https://secret.example/sub", serviceHash: "abc", singleLink: "vless://secret" }), { now: NOW });
    const text = JSON.stringify(trace);
    assert.ok(!text.includes("900100001"));
    assert.ok(!text.includes("secret"));
  });
});
