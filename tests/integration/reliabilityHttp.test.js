/**
 * The Service Reliability API over REAL HTTP against the real Express app, session, CSRF and origin middleware, including a
 * real event stream read off the socket. Nothing here needs MongoDB: the snapshot and the stream are served from memory, and
 * these cases are about who gets through and what comes out.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";

const { setAdminSessionRedisForTests, createAdminSession, deleteAdminSession, ADMIN_SESSION_COOKIE } = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const { createCollector } = await import("../../services/reliability/collector.js");
const { createIncidentTracker } = await import("../../services/reliability/incidents.js");
const { createStreamHub } = await import("../../services/reliability/stream.js");
const { setReliabilityRuntimeForTests } = await import("../../services/reliability/queries.js");
const { createTelemetry } = await import("../../services/reliability/telemetry.js");
const fakeRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);
const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const base = `http://127.0.0.1:${server.address().port}`;

let admin;
const cookieFor = (session) => `${ADMIN_SESSION_COOKIE}=${session.token}`;
async function call(path, { session = admin, method = "GET", headers = {} } = {}) {
  const sent = { ...headers };
  if (session) sent.cookie = cookieFor(session);
  const response = await fetch(`${base}/api/admin${path}`, { method, headers: sent });
  return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
}

const telemetry = createTelemetry();
const healthy = async () => ({ status: "healthy", latencyMs: 2, error: null, details: { webhook: {} } });
function runtime(hubOptions = {}) {
  const hub = createStreamHub({ heartbeatMs: 40, revalidateMs: 40, revalidate: async (client) => Boolean(await (await import("../../services/admin/auth.js")).getAdminSession(client.token)), ...hubOptions });
  const collector = createCollector({
    env: {},
    config: { enabled: true, intervalMs: 30_000, probeIntervalMs: 60_000 },
    probes: { mongodb: healthy, redis: healthy, express: healthy, telegram: healthy, wizardxray: healthy, hooshpay: healthy, orders: healthy },
    telemetry,
    tracker: createIncidentTracker(),
    polling: () => ({ failing: false, stalled: false, lastSuccessAgeSec: 1 }),
    sentinel: async () => null,
    databaseReady: () => false,
    publish: (snapshot) => hub.publish("snapshot", snapshot),
    eventLoop: null,
  });
  setReliabilityRuntimeForTests({ collector, hub });
  return { hub, collector };
}

/** Reads SSE frames off a real response until `until` is satisfied or the stream ends. */
async function readStream(path, { session = admin, headers = {}, until, timeoutMs = 3_000 } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/admin${path}`, { headers: { ...(session ? { cookie: cookieFor(session) } : {}), ...headers }, signal: controller.signal });
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) return { response, frames: [] };
  const frames = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ended = false;
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = {};
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
          else if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("retry: ")) frame.retry = line.slice(7);
        }
        frames.push(frame);
      }
      if (until?.(frames)) break;
    }
    ended = !until?.(frames);
  } catch { ended = false; } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { response, frames, ended };
}

before(async () => { admin = await createAdminSession("424242"); });
beforeEach(() => resetAdminRateLimitsForTests());
after(async () => {
  setReliabilityRuntimeForTests({});
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  setAdminSessionRedisForTests(null);
});

const ROUTES = ["/reliability/snapshot", "/reliability/stream", "/reliability/history", "/reliability/events", "/reliability/incidents", "/reliability/incidents/00000000-0000-0000-0000-000000000000", "/reliability/orders", "/reliability/orders/abc"];

describe("access", () => {
  for (const path of ROUTES) {
    test(`GET ${path} needs a session`, async () => {
      const result = await call(path, { session: null });
      assert.equal(result.status, 401);
      assert.equal(result.data.error, "unauthorized");
    });
  }

  test("a forged session cookie is refused", async () => {
    const response = await fetch(`${base}/api/admin/reliability/snapshot`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${"a".repeat(43)}` } });
    assert.equal(response.status, 401);
  });

  test("a session whose admin was removed is refused, on the stream too", async () => {
    const former = await createAdminSession("424242");
    const previous = process.env.ADMINS;
    process.env.ADMINS = "999999";
    try {
      for (const path of ["/reliability/snapshot", "/reliability/stream"]) {
        const response = await fetch(`${base}/api/admin${path}`, { headers: { cookie: cookieFor(former) } });
        assert.ok([401, 403].includes(response.status), `${path} ${response.status}`);
      }
    } finally {
      process.env.ADMINS = previous;
    }
  });

  test("an unavailable session store fails closed", async () => {
    setAdminSessionRedisForTests({ isReady: true, get: async () => { throw new Error("redis down"); }, set: async () => {}, del: async () => {} });
    try {
      const response = await fetch(`${base}/api/admin/reliability/snapshot`, { headers: { cookie: cookieFor(admin) } });
      assert.equal(response.status, 503);
    } finally {
      setAdminSessionRedisForTests(fakeRedis);
    }
  });

  test("there is nothing to POST to", async () => {
    for (const path of ["/reliability/snapshot", "/reliability/incidents", "/reliability/orders/abc"]) {
      const response = await fetch(`${base}/api/admin${path}`, { method: "POST", headers: { cookie: cookieFor(admin), "x-csrf-token": admin.session.csrfToken, "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 404, path);
    }
  });

  test("responses are never cached", async () => {
    const result = await call("/reliability/snapshot");
    assert.equal(result.headers.get("cache-control"), "no-store");
  });

  test("polling is rate limited", async () => {
    let last;
    for (let index = 0; index < 65; index += 1) last = await call("/reliability/snapshot");
    assert.equal(last.status, 429);
  });
});

describe("input never reaches a query unchecked", () => {
  const INVALID = [
    ["/reliability/history?range=forever", "invalid_range"],
    ["/reliability/history?range=1h&range=6h", "invalid_range"],
    ["/reliability/events?range=30d", "invalid_range"],
    ["/reliability/events?severity=apocalyptic", "invalid_severity"],
    ["/reliability/events?component=everything", "invalid_component"],
    ["/reliability/events?type=$where", "invalid_event_type"],
    ["/reliability/events?type=secret.thing", "invalid_event_type"],
    ["/reliability/events?before=yesterday", "invalid_cursor"],
    ["/reliability/incidents?state=deleted", "invalid_state"],
    ["/reliability/incidents?severity=fatal", "invalid_severity"],
    ["/reliability/incidents?component=x", "invalid_component"],
    ["/reliability/incidents/not-an-id", "invalid_incident_id"],
    [`/reliability/orders/${encodeURIComponent("$ne")}`, "invalid_order_id"],
    ["/reliability/orders?userId=abc", "invalid_user_id"],
  ];
  for (const [path, code] of INVALID) {
    test(`${decodeURIComponent(path)} is refused`, async () => {
      const result = await call(path);
      assert.equal(result.status, 400);
      assert.equal(result.data.error, code);
    });
  }

  test("an object where a value belongs is refused", async () => {
    const { getReliabilityEvents, getReliabilityIncidents, getReliabilityOrders } = await import("../../services/admin/reliability.js");
    const actorId = "424242";
    await assert.rejects(getReliabilityEvents({ actorId, query: { component: { $ne: "x" } } }), (error) => error.status === 400);
    await assert.rejects(getReliabilityIncidents({ actorId, query: { severity: { $gt: "" } } }), (error) => error.status === 400);
    await assert.rejects(getReliabilityOrders({ actorId, query: { userId: ["1", "2"] } }), (error) => error.status === 400);
  });

  test("every service function checks the actor itself", async () => {
    const admin_ = await import("../../services/admin/reliability.js");
    assert.throws(() => admin_.getReliabilitySnapshot({ actorId: "1" }), (error) => error.status === 403);
    assert.throws(() => admin_.getReliabilityHistory({ actorId: "1" }), (error) => error.status === 403);
    assert.throws(() => admin_.openReliabilityStream({ actorId: "1" }), (error) => error.status === 403);
    await assert.rejects(admin_.getReliabilityEvents({ actorId: "1" }), (error) => error.status === 403);
    await assert.rejects(admin_.getReliabilityIncident({ actorId: "1", id: "x" }), (error) => error.status === 403);
    await assert.rejects(admin_.getReliabilityOrderTrace({ actorId: "1", orderId: "x" }), (error) => error.status === 403);
  });
});

describe("snapshot", () => {
  test("before the first check it says unknown, never healthy", async () => {
    setReliabilityRuntimeForTests({});
    const result = await call("/reliability/snapshot");
    assert.equal(result.status, 200);
    assert.equal(result.data.data.overall.state, "unknown");
    assert.ok(result.data.data.components.every((item) => item.state === "unknown"));
  });

  test("it works with no database at all, because it is served from memory", async () => {
    const { collector } = runtime();
    await collector.tick();
    const result = await call("/reliability/snapshot");
    assert.equal(result.status, 200);
    assert.equal(result.data.data.components.length, 12);
    assert.equal(result.data.data.monitoring.fresh, true);
  });

  test("events and incidents degrade to memory without a database, and say so", async () => {
    const { collector } = runtime();
    telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "memory only" });
    await collector.tick();
    const events = await call("/reliability/events?range=15m");
    assert.equal(events.status, 200);
    assert.ok(events.data.data.degraded.includes("stored events"));
    assert.ok(events.data.data.events.some((item) => item.message === "memory only"));
    const incidents = await call("/reliability/incidents");
    assert.equal(incidents.status, 200);
    assert.ok(incidents.data.data.degraded.includes("stored incidents"));
  });

  test("history answers from memory", async () => {
    runtime();
    const result = await call("/reliability/history?range=15m");
    assert.equal(result.status, 200);
    assert.ok(result.data.data.points.length >= 15);
  });

  test("a filter on memory events is applied", async () => {
    const { collector } = runtime();
    telemetry.emit({ type: "polling.error", severity: "warning", component: "polling", message: "poll" });
    await collector.tick();
    const result = await call("/reliability/events?range=15m&component=polling");
    assert.ok(result.data.data.events.every((item) => item.component === "polling"));
    assert.ok(result.data.data.events.length >= 1);
  });

  test("no internal bookkeeping leaves in an event", async () => {
    const { collector } = runtime();
    await collector.tick();
    const { data } = await call("/reliability/snapshot");
    for (const event of data.data.recentEvents) {
      assert.equal(event.dirty, undefined);
      assert.equal(event.seq, undefined);
    }
  });
});

describe("the event stream", () => {
  test("opens with the right headers and a snapshot straight away", async () => {
    const { collector } = runtime();
    await collector.tick();
    const { response, frames } = await readStream("/reliability/stream", { until: (seen) => seen.some((frame) => frame.event === "snapshot") });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const snapshot = frames.find((frame) => frame.event === "snapshot");
    assert.equal(snapshot.data.components.length, 12);
  });

  test("sends heartbeats", async () => {
    runtime();
    const { frames } = await readStream("/reliability/stream", { until: (seen) => seen.filter((frame) => frame.event === "ping").length >= 2 });
    const pings = frames.filter((frame) => frame.event === "ping");
    assert.equal(pings.length, 2);
    assert.ok(pings[0].data.serverTime);
  });

  test("delivers a new event, batched, with a resumable id", async () => {
    const { hub } = runtime({ batchMs: 5 });
    const sent = telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "live" });
    const reading = readStream("/reliability/stream", { until: (seen) => seen.some((frame) => frame.event === "events") });
    await new Promise((resolve) => setTimeout(resolve, 60));
    hub.queueEvent({ ...sent, dirty: undefined }, `${telemetry.instance}:${sent.seq}`);
    const { frames } = await reading;
    const batch = frames.find((frame) => frame.event === "events");
    assert.equal(batch.data[0].message, "live");
    assert.equal(batch.id, `${telemetry.instance}:${sent.seq}`);
  });

  test("a reconnect with its last id gets only what it missed", async () => {
    runtime();
    const seen = telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "seen before" });
    const missed = telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "missed while away" });
    const { frames } = await readStream("/reliability/stream", { headers: { "last-event-id": `${telemetry.instance}:${seen.seq}` }, until: (all) => all.some((frame) => frame.event === "events") });
    const messages = frames.filter((frame) => frame.event === "events").flatMap((frame) => frame.data).map((item) => item.message);
    assert.deepEqual(messages, ["missed while away"]);
    assert.ok(missed.seq > seen.seq);
  });

  test("the cursor also works in the URL, because a new EventSource sends no Last-Event-ID", async () => {
    runtime();
    const seen = telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "before the drop" });
    telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "during the drop" });
    const cursor = encodeURIComponent(`${telemetry.instance}:${seen.seq}`);
    const { frames } = await readStream(`/reliability/stream?cursor=${cursor}`, { until: (all) => all.some((frame) => frame.event === "events") });
    const batch = frames.find((frame) => frame.event === "events");
    assert.deepEqual(batch.data.map((item) => item.message), ["during the drop"]);
    assert.match(batch.id, new RegExp(`^${telemetry.instance}:\\d+$`), "the replay carries its own cursor");
  });

  test("an id from another process replays nothing, and a malformed one is ignored", async () => {
    runtime();
    telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "x" });
    for (const cursor of ["deadbeef:1", "'; DROP--", "a:b:c"]) {
      const { frames, response } = await readStream("/reliability/stream", { headers: { "last-event-id": cursor }, until: (all) => all.some((frame) => frame.event === "ping") });
      assert.equal(response.status, 200);
      assert.equal(frames.filter((frame) => frame.event === "events").length, 0, cursor);
    }
  });

  test("a session that ends closes the stream, and the viewer is told why", async () => {
    runtime();
    const session = await createAdminSession("424242");
    const reading = readStream("/reliability/stream", { session, until: (seen) => seen.some((frame) => frame.event === "closing") });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await deleteAdminSession(session.token);
    const { frames } = await reading;
    assert.equal(frames.find((frame) => frame.event === "closing").data.reason, "session_ended");
  });

  test("connections are capped per admin", async () => {
    const { hub } = runtime({ maxPerAdmin: 1 });
    const first = readStream("/reliability/stream", { until: (seen) => seen.filter((frame) => frame.event === "ping").length >= 3 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await call("/reliability/stream");
    assert.equal(second.status, 503);
    assert.equal(second.data.error, "stream_capacity");
    await first;
    hub.closeAll();
  });

  test("closeAll ends every stream, which is what lets a deploy finish", async () => {
    const { hub } = runtime();
    const reading = readStream("/reliability/stream", { until: (seen) => seen.some((frame) => frame.event === "closing") });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hub.size(), 1);
    hub.closeAll();
    assert.equal(hub.size(), 0);
    const { frames } = await reading;
    assert.equal(frames.find((frame) => frame.event === "closing").data.reason, "server_stopping");
  });

  test("a client that disconnects is forgotten", async () => {
    const { hub } = runtime();
    await readStream("/reliability/stream", { until: (seen) => seen.some((frame) => frame.event === "snapshot") });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hub.size(), 0);
  });

  test("the stream's own traffic is not counted as traffic", async () => {
    telemetry.reset();
    const { telemetry: shared } = await import("../../services/reliability/telemetry.js");
    shared.reset();
    runtime();
    await readStream("/reliability/stream", { until: (seen) => seen.some((frame) => frame.event === "snapshot") });
    await call("/reliability/snapshot");
    assert.equal(shared.minutes().filter((minute) => Object.keys(minute.series).length).length, 0);
  });
});

describe("the webhook routes are observed without changing them", () => {
  test("a forged callback is still refused, and is counted as a rejection", async () => {
    const { telemetry: shared } = await import("../../services/reliability/telemetry.js");
    shared.reset();
    const previous = process.env.HOOSHPAY_WEBHOOK_SECRET;
    process.env.HOOSHPAY_WEBHOOK_SECRET = "test-webhook-secret-value";
    try {
      const response = await fetch(`${base}/api/hooshpay/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hooshpay-signature": "forged" }, body: JSON.stringify({ event: "payment.success" }) });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, "invalid_signature");
      await new Promise((resolve) => setImmediate(resolve));
      const series = shared.minutes().at(-1).series["webhook.hooshpay"];
      assert.equal(series.rej, 1);
      assert.equal(series.ok, 0);
      assert.equal(shared.events().at(-1).type, "webhook.rejected");
    } finally {
      if (previous === undefined) delete process.env.HOOSHPAY_WEBHOOK_SECRET;
      else process.env.HOOSHPAY_WEBHOOK_SECRET = previous;
    }
  });

  test("an unconfigured webhook answers 503, and counts as an error", async () => {
    const { telemetry: shared } = await import("../../services/reliability/telemetry.js");
    shared.reset();
    const previous = process.env.NOWPAYMENTS_IPN_SECRET;
    delete process.env.NOWPAYMENTS_IPN_SECRET;
    try {
      const response = await fetch(`${base}/api/nowpayments/ipn`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 503);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(shared.minutes().at(-1).series["webhook.nowpayments"].err, 1);
    } finally {
      if (previous !== undefined) process.env.NOWPAYMENTS_IPN_SECRET = previous;
    }
  });
});
