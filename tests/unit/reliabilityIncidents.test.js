/** Detection rules and the incident lifecycle: creation, deduplication, escalation, recovery, and what must not count as one. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createIncidentTracker, nextSteps } from "../../services/reliability/incidents.js";
import { evaluateRules } from "../../services/reliability/rules.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const condition = (overrides = {}) => ({ fingerprint: "DEPENDENCY_DOWN:redis", code: "DEPENDENCY_DOWN", group: "dependency:redis", component: "redis", severity: "high", rank: 1, title: "Redis is not responding", summary: "x", evidence: [{ label: "a", value: "b" }], affectedOrders: null, orderKeys: [], ...overrides });
let ids = 0;
const tracker = (options = {}) => createIncidentTracker({ newId: () => `incident-${(ids += 1)}`, ...options });

describe("lifecycle", () => {
  test("a condition opens one incident", () => {
    const incidents = tracker();
    const transitions = incidents.apply({ conditions: [condition()], now: NOW });
    assert.deepEqual(transitions.map((item) => item.kind), ["opened"]);
    assert.equal(incidents.open().length, 1);
    assert.equal(incidents.open()[0].timeline[0].kind, "opened");
  });

  test("a continuing problem stays one incident and counts its detections", () => {
    const incidents = tracker();
    for (let index = 0; index < 20; index += 1) incidents.apply({ conditions: [condition()], now: NOW + index * 30_000 });
    assert.equal(incidents.open().length, 1);
    assert.equal(incidents.open()[0].detections, 20);
    assert.equal(new Date(incidents.open()[0].firstDetectedAt).getTime(), NOW);
  });

  test("a continuing incident is not rewritten every tick", () => {
    const incidents = tracker();
    incidents.apply({ conditions: [condition()], now: NOW });
    incidents.markWritten(incidents.dirty(), NOW);
    incidents.apply({ conditions: [condition()], now: NOW + 30_000 });
    assert.equal(incidents.dirty().length, 0);
    incidents.apply({ conditions: [condition()], now: NOW + 6 * MINUTE });
    assert.equal(incidents.dirty().length, 1);
  });

  test("a rising severity escalates the same incident", () => {
    const incidents = tracker();
    incidents.apply({ conditions: [condition({ severity: "medium", rank: 2 })], now: NOW });
    const transitions = incidents.apply({ conditions: [condition({ severity: "critical", rank: 0 })], now: NOW + MINUTE });
    assert.deepEqual(transitions.map((item) => item.kind), ["escalated"]);
    const [open] = incidents.open();
    assert.equal(open.severity, "critical");
    assert.ok(open.escalatedAt);
  });

  test("a falling severity does not de-escalate", () => {
    const incidents = tracker();
    incidents.apply({ conditions: [condition({ severity: "critical", rank: 0 })], now: NOW });
    assert.deepEqual(incidents.apply({ conditions: [condition({ severity: "low", rank: 3 })], now: NOW + MINUTE }), []);
    assert.equal(incidents.open()[0].severity, "critical");
  });

  test("recovery needs several clean checks, so one good probe closes nothing", () => {
    const incidents = tracker({ clearTicks: 3 });
    incidents.apply({ conditions: [condition()], now: NOW });
    assert.deepEqual(incidents.apply({ conditions: [], now: NOW + 30_000 }), []);
    assert.deepEqual(incidents.apply({ conditions: [], now: NOW + 60_000 }), []);
    const transitions = incidents.apply({ conditions: [], now: NOW + 90_000 });
    assert.deepEqual(transitions.map((item) => item.kind), ["resolved"]);
    assert.equal(incidents.open().length, 0);
    assert.ok(transitions[0].incident.resolvedAt);
  });

  test("a flapping dependency stays one incident", () => {
    const incidents = tracker({ clearTicks: 3 });
    for (let index = 0; index < 12; index += 1) {
      const up = index % 2 === 0;
      const result = incidents.apply({ conditions: up ? [] : [condition()], now: NOW + index * 30_000 });
      if (index > 1) assert.deepEqual(result, []);
    }
    assert.equal(incidents.open().length, 1);
  });

  test("a problem back soon reopens its incident", () => {
    const incidents = tracker({ clearTicks: 1, reopenMs: 15 * MINUTE });
    incidents.apply({ conditions: [condition()], now: NOW });
    const [{ incident }] = incidents.apply({ conditions: [], now: NOW + MINUTE });
    const reopened = incidents.apply({ conditions: [condition()], now: NOW + 2 * MINUTE });
    assert.deepEqual(reopened.map((item) => item.kind), ["reopened"]);
    assert.equal(reopened[0].incident.incidentId, incident.incidentId);
    assert.equal(reopened[0].incident.reopenCount, 1);
    assert.equal(reopened[0].incident.resolvedAt, null);
  });

  test("a problem back much later is a new incident", () => {
    const incidents = tracker({ clearTicks: 1, reopenMs: 15 * MINUTE });
    incidents.apply({ conditions: [condition()], now: NOW });
    const [{ incident }] = incidents.apply({ conditions: [], now: NOW + MINUTE });
    const later = incidents.apply({ conditions: [condition()], now: NOW + 60 * MINUTE });
    assert.deepEqual(later.map((item) => item.kind), ["opened"]);
    assert.notEqual(later[0].incident.incidentId, incident.incidentId);
  });

  test("missing telemetry never resolves anything", () => {
    const incidents = tracker({ clearTicks: 2 });
    incidents.apply({ conditions: [condition({ group: "orders", fingerprint: "ORDERS_NEED_REVIEW:all" })], now: NOW });
    for (let index = 1; index < 50; index += 1) {
      assert.deepEqual(incidents.apply({ conditions: [], unevaluated: ["orders"], now: NOW + index * 30_000 }), []);
    }
    assert.equal(incidents.open().length, 1);
    assert.equal(incidents.open()[0].state, "open");
  });

  test("a restart continues the same incidents", () => {
    const first = tracker();
    first.apply({ conditions: [condition()], now: NOW });
    const row = { ...first.open()[0] };
    const second = tracker();
    second.hydrate([row]);
    assert.deepEqual(second.apply({ conditions: [condition()], now: NOW + MINUTE }), []);
    assert.equal(second.open()[0].incidentId, row.incidentId);
    assert.equal(second.open()[0].detections, 2);
  });

  test("the timeline is bounded", () => {
    const incidents = tracker({ clearTicks: 1, reopenMs: 100 * 60 * MINUTE });
    for (let index = 0; index < 100; index += 1) {
      incidents.apply({ conditions: [condition()], now: NOW + index * 2 * MINUTE });
      incidents.apply({ conditions: [], now: NOW + index * 2 * MINUTE + MINUTE });
    }
    assert.ok(incidents.all()[0].timeline.length <= 30);
  });

  test("two conditions are two incidents", () => {
    const incidents = tracker();
    incidents.apply({ conditions: [condition(), condition({ fingerprint: "DEPENDENCY_DOWN:mongodb", component: "mongodb" })], now: NOW });
    assert.equal(incidents.open().length, 2);
  });
});

const count = (fields) => ({ n: 0, ok: 0, err: 0, rej: 0, tmo: 0, sumMs: 0, timed: 0, h: new Array(12).fill(0), ...fields });
const healthyProbe = { status: "healthy", latencyMs: 5, failures: 0, lastSuccessAt: NOW };
const component = (id, state = "healthy") => ({ id, state, reason: `${id} ${state}` });
const COMPONENTS = ["mongodb", "redis", "telegram", "wizardxray", "express"];

function rules(overrides = {}) {
  const orders = { status: "healthy", details: { needsReview: 0, stalledProvisioning: 0, ledgerStalled: 0, awaitingProvider: 0, refundPending: 0, deliveryPending: 0, alertPending: 0 } };
  return evaluateRules({
    now: NOW,
    minutes: [],
    components: COMPONENTS.map((id) => component(id)),
    probes: { mongodb: healthyProbe, redis: healthyProbe, telegram: healthyProbe, wizardxray: healthyProbe, express: healthyProbe, orders },
    polling: { failing: false, stalled: false },
    providers: [{ id: "hooshpay", label: "HooshPay", configured: true, secretConfigured: true }],
    jobs: [],
    workflow: { backlog: [] },
    sentinel: { health: "healthy" },
    persistence: { failures: 0 },
    ...overrides,
  });
}
const codes = (result) => result.conditions.map((item) => item.code).sort();

describe("rules", () => {
  test("a healthy system raises nothing", () => {
    const result = rules();
    assert.deepEqual(result.conditions, []);
    assert.deepEqual(result.unevaluated.filter((group) => !/^(webhook|provider):/.test(group)), [], "with no traffic, only the traffic rules have nothing to read");
  });

  test("one failed probe of a data store is a blip; two in a row is an incident", () => {
    const failed = (failures) => rules({ components: COMPONENTS.map((id) => component(id, id === "mongodb" ? "failed" : "healthy")), probes: { ...rules.base, mongodb: { status: "down", failures }, redis: healthyProbe, telegram: healthyProbe, wizardxray: healthyProbe, express: healthyProbe, orders: { status: "healthy", details: {} } } });
    assert.deepEqual(codes(failed(1)), []);
    assert.deepEqual(codes(failed(2)), ["DEPENDENCY_DOWN"]);
    assert.equal(failed(2).conditions[0].severity, "critical");
  });

  test("a dependency we have no reading for is unevaluated, and raises nothing", () => {
    const result = rules({ components: COMPONENTS.map((id) => component(id, id === "redis" ? "stale" : "healthy")) });
    assert.deepEqual(result.conditions, []);
    assert.ok(result.unevaluated.includes("dependency:redis"));
  });

  test("unreadable orders are unevaluated, not zero", () => {
    const result = rules({ probes: { mongodb: healthyProbe, redis: healthyProbe, telegram: healthyProbe, wizardxray: healthyProbe, express: healthyProbe, orders: { status: "down" } } });
    assert.ok(result.unevaluated.includes("orders"));
    assert.deepEqual(result.conditions, []);
  });

  test("a polling conflict is critical and a failing poll is high", () => {
    assert.equal(rules({ polling: { failing: true, lastErrorStatus: 409 } }).conditions[0].severity, "critical");
    assert.equal(rules({ polling: { failing: true, lastErrorStatus: 502 } }).conditions[0].code, "POLLING_FAILING");
    assert.equal(rules({ polling: { stalled: true } }).conditions[0].code, "POLLING_STALLED");
  });

  test("order counts become incidents that name their orders", () => {
    const orders = { status: "degraded", details: { needsReview: 2, stalledProvisioning: 1, ledgerStalled: 0, awaitingProvider: 3, refundPending: 0, deliveryPending: 1, alertPending: 0 } };
    const backlog = [{ key: "wallet:a", status: "manual_review" }, { key: "wallet:b", status: "provisioning" }, { key: "wallet:c", status: "completed" }];
    const result = rules({ probes: { mongodb: healthyProbe, redis: healthyProbe, telegram: healthyProbe, wizardxray: healthyProbe, express: healthyProbe, orders }, workflow: { backlog } });
    assert.deepEqual(codes(result), ["DELIVERY_PENDING", "ORDERS_AWAITING_PROVIDER", "ORDERS_NEED_REVIEW", "ORDERS_STUCK_PROVISIONING"]);
    const review = result.conditions.find((item) => item.code === "ORDERS_NEED_REVIEW");
    assert.equal(review.affectedOrders, 2);
    assert.deepEqual(review.orderKeys, ["wallet:a"]);
    assert.equal(result.conditions.find((item) => item.code === "DELIVERY_PENDING").component, "delivery");
  });

  test("a burst of rejected callbacks is noticed, and is not called an outage", () => {
    const result = rules({ minutes: [{ t: NOW - MINUTE, series: { "webhook.hooshpay": count({ n: 12, rej: 12 }) } }] });
    assert.deepEqual(codes(result), ["WEBHOOK_REJECTED_BURST"]);
    assert.equal(result.conditions[0].severity, "medium");
  });

  test("failing callbacks and a missing secret are separate problems", () => {
    const result = rules({ minutes: [{ t: NOW - MINUTE, series: { "webhook.hooshpay": count({ n: 3, err: 3 }) } }], providers: [{ id: "hooshpay", label: "HooshPay", configured: true, secretConfigured: false }] });
    assert.deepEqual(codes(result), ["WEBHOOK_FAILURES", "WEBHOOK_SECRET_MISSING"]);
  });

  test("traffic older than the window does not count", () => {
    assert.deepEqual(codes(rules({ minutes: [{ t: NOW - 60 * MINUTE, series: { "webhook.hooshpay": count({ n: 30, err: 30 }) } }] })), []);
  });

  test("provider timeouts and errors", () => {
    assert.deepEqual(codes(rules({ minutes: [{ t: NOW - MINUTE, series: { "provider.wizardxray.create": count({ n: 3, tmo: 3 }) } }] })), ["PROVIDER_TIMEOUTS"]);
    assert.deepEqual(codes(rules({ minutes: [{ t: NOW - MINUTE, series: { "provider.hooshpay": count({ n: 4, err: 3, ok: 1 }) } }] })), ["PROVIDER_ERRORS"]);
    assert.deepEqual(codes(rules({ minutes: [{ t: NOW - MINUTE, series: { "provider.hooshpay": count({ n: 40, err: 3, ok: 37 }) } }] })), []);
  });

  test("jobs, Sentinel and our own persistence", () => {
    const jobs = [{ name: "x", label: "X", state: "failed", consecutiveFailures: 3, reason: "r", lastRunAt: null, everyMs: 60_000 }, { name: "y", label: "Y", state: "degraded", consecutiveFailures: 0, reason: "r", lastRunAt: null, everyMs: 60_000 }];
    assert.deepEqual(codes(rules({ jobs })), ["JOB_FAILING", "JOB_OVERDUE"]);
    assert.deepEqual(codes(rules({ sentinel: { health: "stale" } })), ["SENTINEL_BEHIND"]);
    assert.deepEqual(codes(rules({ persistence: { failures: 3 } })), ["TELEMETRY_NOT_PERSISTED"]);
    assert.ok(rules({ sentinel: null }).unevaluated.includes("sentinel"));
  });

  test("no traffic is not recovery: a provider or webhook rule with nothing to read holds its incident", () => {
    const quiet = rules({ minutes: [] });
    for (const group of ["provider:wizardxray", "provider:hooshpay", "provider:nowpayments", "webhook:hooshpay", "webhook:nowpayments"]) assert.ok(quiet.unevaluated.includes(group), group);
    const incidents = tracker({ clearTicks: 2 });
    const failing = rules({ minutes: [{ t: NOW - MINUTE, series: { "provider.hooshpay": count({ n: 4, err: 4 }) } }] });
    incidents.apply({ ...failing, now: NOW });
    for (let index = 1; index < 20; index += 1) assert.deepEqual(incidents.apply({ ...rules({ minutes: [] }), now: NOW + index * MINUTE }), []);
    assert.equal(incidents.open().length, 1);
  });

  test("a real success clears a provider incident", () => {
    const incidents = tracker({ clearTicks: 2 });
    incidents.apply({ ...rules({ minutes: [{ t: NOW - MINUTE, series: { "provider.hooshpay": count({ n: 4, err: 4 }) } }] }), now: NOW });
    const healthyTraffic = rules({ minutes: [{ t: NOW - MINUTE, series: { "provider.hooshpay": count({ n: 40, ok: 39, err: 1 }) } }] });
    incidents.apply({ ...healthyTraffic, now: NOW + MINUTE });
    assert.deepEqual(incidents.apply({ ...healthyTraffic, now: NOW + 2 * MINUTE }).map((item) => item.kind), ["resolved"]);
  });

  test("a rejected burst does clear with time: it is an event, not a broken state", () => {
    const incidents = tracker({ clearTicks: 2 });
    incidents.apply({ ...rules({ minutes: [{ t: NOW - MINUTE, series: { "webhook.hooshpay": count({ n: 12, rej: 12 }) } }] }), now: NOW });
    incidents.apply({ ...rules({ minutes: [] }), now: NOW + MINUTE });
    assert.deepEqual(incidents.apply({ ...rules({ minutes: [] }), now: NOW + 2 * MINUTE }).map((item) => item.kind), ["resolved"]);
  });

  test("a restart does not resolve a job incident: unknown is not fixed", () => {
    const failing = { name: "x", label: "X", state: "failed", consecutiveFailures: 3, reason: "r", lastRunAt: null, everyMs: 60_000 };
    const incidents = tracker({ clearTicks: 2 });
    incidents.apply({ ...rules({ jobs: [failing] }), now: NOW });
    const afterRestart = rules({ jobs: [{ ...failing, state: "unknown", consecutiveFailures: 0 }] });
    assert.ok(afterRestart.unevaluated.includes("job:x"));
    for (let index = 1; index < 10; index += 1) assert.deepEqual(incidents.apply({ ...afterRestart, now: NOW + index * MINUTE }), []);
    const running = rules({ jobs: [{ ...failing, state: "healthy", consecutiveFailures: 0 }] });
    incidents.apply({ ...running, now: NOW + 11 * MINUTE });
    assert.deepEqual(incidents.apply({ ...running, now: NOW + 12 * MINUTE }).map((item) => item.kind), ["resolved"]);
  });

  test("evidence is bounded, and a fingerprint is deterministic", () => {
    const first = rules({ polling: { failing: true, lastErrorStatus: 409 } }).conditions[0];
    const second = rules({ polling: { failing: true, lastErrorStatus: 409 } }).conditions[0];
    assert.equal(first.fingerprint, second.fingerprint);
    assert.ok(first.evidence.length <= 8);
  });

  test("every code a rule can raise has its own next steps, and none of them acts", () => {
    const source = ["DEPENDENCY_DOWN", "DEPENDENCY_DEGRADED", "POLLING_CONFLICT", "POLLING_FAILING", "POLLING_STALLED", "WEBHOOK_SECRET_MISSING", "WEBHOOK_FAILURES", "WEBHOOK_REJECTED_BURST", "PROVIDER_TIMEOUTS", "PROVIDER_ERRORS", "ORDERS_NEED_REVIEW", "ORDERS_STUCK_PROVISIONING", "ORDERS_INTERRUPTED", "REFUNDS_PENDING", "ORDERS_AWAITING_PROVIDER", "DELIVERY_PENDING", "ADMIN_ALERTS_PENDING", "JOB_FAILING", "JOB_OVERDUE", "SENTINEL_BEHIND", "TELEMETRY_NOT_PERSISTED", "HTTP_ERRORS"];
    const generic = nextSteps("NOT_A_CODE");
    for (const code of source) {
      const steps = nextSteps(code);
      assert.notDeepEqual(steps, generic, code);
      assert.ok(steps.length >= 1, code);
      for (const step of steps) {
        if (step.href) assert.match(step.href, /^\/[a-z-]+/, code);
        assert.ok(!Object.keys(step).some((key) => /action|method|run|execute/i.test(key)), code);
      }
    }
  });
});
