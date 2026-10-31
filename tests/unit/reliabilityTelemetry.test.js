/**
 * The recorder is called from money paths, so what matters most here is what it cannot do: throw, grow without bound, or let
 * a request name a series. The sanitizer is checked with values built at runtime, as in checkSensitive.test.js.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EVENT_RING_SIZE, MAX_MINUTES, SERIES, bucketIndex, createTelemetry, httpSeries, observeDelivery, observeJob, observePollingError, observeProvider, observeTelegramUpdate, observeWebhook, telemetry, withTelemetryContext } from "../../services/reliability/telemetry.js";
import { sanitizeCode, sanitizeText } from "../../services/reliability/sanitize.js";

describe("bounds", () => {
  test("a key outside the list is dropped, so a request cannot grow the series space", () => {
    const recorder = createTelemetry();
    for (let index = 0; index < 500; index += 1) recorder.observe(`http.${index}`);
    recorder.observe("http.admin");
    assert.deepEqual(Object.keys(recorder.minutes()[0].series), ["http.admin"]);
  });

  test("minutes are capped however long the process runs", () => {
    let clock = 0;
    const recorder = createTelemetry({ now: () => clock, maxMinutes: 10 });
    for (let index = 0; index < 100; index += 1) { clock = index * 60_000; recorder.observe("http.admin"); }
    assert.equal(recorder.minutes().length, 10);
    assert.equal(MAX_MINUTES, 24 * 60 + 5);
  });

  test("the event ring is capped and counts what it lost unsaved", () => {
    const recorder = createTelemetry({ ringSize: 5 });
    for (let index = 0; index < 12; index += 1) recorder.emit({ type: "webhook.accepted", component: "webhook", message: `n${index}` });
    assert.equal(recorder.events().length, 5);
    assert.equal(recorder.droppedEvents(), 7);
    assert.ok(EVENT_RING_SIZE <= 2_000);
  });

  test("a burst with a coalescing key is one row with a count, and cannot push out real events", () => {
    const recorder = createTelemetry({ ringSize: 4 });
    recorder.emit({ type: "order.reserved", component: "orders", message: "real" });
    for (let index = 0; index < 10_000; index += 1) recorder.emit({ type: "webhook.rejected", component: "webhook", message: "forged", coalesceKey: "w" });
    const events = recorder.events();
    assert.equal(events.length, 2);
    assert.equal(events.find((event) => event.type === "webhook.rejected").count, 10_000);
    assert.equal(events[0].message, "real");
  });

  test("a coalesced row starts a new one when its window ends", () => {
    let clock = 0;
    const recorder = createTelemetry({ now: () => clock });
    recorder.emit({ type: "webhook.rejected", component: "webhook", message: "a", coalesceKey: "w", coalesceMs: 1_000 });
    clock = 5_000;
    recorder.emit({ type: "webhook.rejected", component: "webhook", message: "b", coalesceKey: "w", coalesceMs: 1_000 });
    assert.equal(recorder.events().length, 2);
  });
});

describe("observers never reach the caller", () => {
  test("a subscriber that throws changes nothing for the caller", () => {
    const recorder = createTelemetry();
    recorder.subscribe(() => { throw new Error("boom"); });
    assert.doesNotThrow(() => recorder.emit({ type: "job.failed", component: "jobs", message: "x" }));
  });

  test("hostile arguments do not throw", () => {
    assert.doesNotThrow(() => observeProvider("provider.hooshpay", null));
    assert.doesNotThrow(() => observeProvider("not.a.series", { error: Symbol("x"), ms: "soon" }));
    assert.doesNotThrow(() => observeDelivery({ ok: false, code: { toString() { throw new Error("no"); } } }));
    assert.doesNotThrow(() => observeJob(undefined, undefined));
    assert.doesNotThrow(() => observePollingError(undefined));
    assert.doesNotThrow(() => observeTelegramUpdate());
  });

  test("the observers are synchronous", () => {
    assert.equal(observeProvider("provider.hooshpay", { operation: "x", ms: 1 }), undefined);
    assert.equal(observeTelegramUpdate(), undefined);
  });
});

describe("classification", () => {
  test("a timeout, a failure and a proven refusal are three different things", () => {
    telemetry.reset();
    observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 15_000, error: { code: "ECONNABORTED" } });
    observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 90, error: { code: "invalid_response" } });
    observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 90, error: { code: "provider_insufficient_balance" }, rejected: true });
    observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 90 });
    const series = telemetry.minutes()[0].series["provider.wizardxray.create"];
    assert.deepEqual([series.tmo, series.err, series.rej, series.ok, series.n], [1, 1, 1, 1, 4]);
    assert.deepEqual(telemetry.events().map((event) => event.type), ["provider.timeout", "provider.failed", "provider.rejected"]);
  });

  test("a provider call names its order through the context, without a changed signature", async () => {
    telemetry.reset();
    await withTelemetryContext({ orderKey: "wallet:order-1" }, async () => {
      await Promise.resolve();
      observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 5, mutation: true });
    });
    assert.equal(telemetry.events()[0].orderKey, "wallet:order-1");
  });

  test("the panel's own traffic and health probes are not traffic", () => {
    for (const path of ["/api/admin/reliability/snapshot", "/api/admin/reliability/stream", "/panel/reliability", "/panel/reliability/history", "/panel/_next/static/x.js", "/health", "/livez", "/ready", "/api/hooshpay/webhook"]) {
      assert.equal(httpSeries(path), null, path);
    }
  });

  test("every other path lands in a fixed group, whatever it says", () => {
    assert.equal(httpSeries("/api/admin/users"), "http.admin");
    assert.equal(httpSeries("/api/store/plans"), "http.store");
    assert.equal(httpSeries("/panel/users"), "http.panel");
    assert.equal(httpSeries("/$where/../../etc"), "http.other");
    assert.ok(SERIES.includes(httpSeries("/anything")));
  });

  test("latency lands in the right bucket", () => {
    assert.equal(bucketIndex(0), 0);
    assert.equal(bucketIndex(25), 0);
    assert.equal(bucketIndex(26), 1);
    assert.equal(bucketIndex(999_999), 11);
  });
});

function fakeExchange(status, body) {
  const req = { method: "POST" };
  const res = new EventEmitter();
  res.statusCode = status;
  res.json = () => res;
  return { req, res, finish() { res.json(body); res.emit("finish"); } };
}

describe("webhook observer", () => {
  const run = (status, body, provider = "hooshpay") => {
    telemetry.reset();
    const { req, res, finish } = fakeExchange(status, body);
    let called = false;
    observeWebhook(provider)(req, res, () => { called = true; });
    assert.ok(called, "the handler always runs");
    finish();
    return { series: telemetry.minutes()[0].series[`webhook.${provider}`], event: telemetry.events()[0] };
  };

  test("an accepted callback carries the handler's request id", () => {
    const { series, event } = run(200, { ok: true, request_id: "abc-123" });
    assert.equal(series.ok, 1);
    assert.equal(event.type, "webhook.accepted");
    assert.equal(event.correlationId, "abc-123");
  });

  test("a bad signature is a rejection, not an outage", () => {
    const { series, event } = run(401, { ok: false, error: "invalid_signature" });
    assert.equal(series.rej, 1);
    assert.equal(series.err, 0);
    assert.equal(event.type, "webhook.rejected");
    assert.match(event.message, /invalid signature/);
  });

  test("a 5xx is an error", () => {
    const { series, event } = run(503, { ok: false, error: "temporarily_unavailable" }, "nowpayments");
    assert.equal(series.err, 1);
    assert.equal(event.type, "webhook.failed");
  });

  test("only POST is counted", () => {
    telemetry.reset();
    const { res } = fakeExchange(404, {});
    observeWebhook("hooshpay")({ method: "GET" }, res, () => {});
    res.emit("finish");
    assert.equal(telemetry.minutes().length, 0);
  });

  test("the response body is passed through untouched", () => {
    const { req, res } = fakeExchange(200, {});
    let seen = null;
    res.json = (body) => { seen = body; return res; };
    observeWebhook("hooshpay")(req, res, () => {});
    const body = { ok: true, request_id: "x" };
    res.json(body);
    assert.equal(seen, body);
  });
});

describe("sanitizing", () => {
  const digits = ["6037", "9912", "3456", "7890"].join("");
  const token = `${"123456"}:${"A".repeat(30)}`;
  const samples = {
    "a bot token": `failed at ${token} here`,
    "a connection string": ["mongodb", "://user:pass@db.internal:27017/app"].join(""),
    "a URL": "see https://api.example.test/v1?key=abc",
    "a bearer credential": ["Bearer", "abcdefghijklmnop.qrst"].join(" "),
    "a labelled secret": ["api_key", "=", "sk-live-abcdef"].join(""),
    "a card number": `card ${digits}`,
    "a spaced card number": `card ${digits.match(/.{4}/g).join(" ")}`,
    "a Telegram id": "user 7123456789 failed",
    "an email": ["someone", "@", "example.test"].join(""),
    "a JWT": `eyJ${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`,
    "a TRON address": `T${"Q".repeat(33)}`,
  };

  for (const [name, value] of Object.entries(samples)) {
    test(`${name} does not survive`, () => {
      const clean = sanitizeText(value);
      for (const fragment of [digits, token, "pass@", "abc", "sk-live", "7123456789", "someone", "eyJ", "QQQQ"]) {
        if (value.includes(fragment)) assert.ok(!clean.includes(fragment), `${clean} still holds ${fragment}`);
      }
    });
  }

  test("plain operational text survives, and length is bounded", () => {
    assert.equal(sanitizeText("Long poll failed (HTTP 502)"), "Long poll failed (HTTP 502)");
    assert.equal(sanitizeText("x".repeat(500)).length, 200);
  });

  test("control characters cannot forge a log line or an SSE frame", () => {
    assert.ok(!sanitizeText("a\nevent: fake\n\ndata: {}").includes("\n"));
    assert.equal(sanitizeCode("wallet:abc\ndata: x"), "wallet:abc_data:_x");
  });

  test("every emitted event passes through the sanitizer", () => {
    const recorder = createTelemetry();
    const event = recorder.emit({ type: "provider.failed", component: "wizardxray", message: `boom ${token} ${digits}`, correlationId: "a b<script>", orderKey: "wallet:x\ny" });
    assert.ok(!event.message.includes(token));
    assert.ok(!event.message.includes(digits));
    assert.ok(!/[<\s]/.test(event.correlationId));
    assert.ok(!/\s/.test(event.orderKey));
  });
});
