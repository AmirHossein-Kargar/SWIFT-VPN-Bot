/**
 * The panel's own logic (admin-panel/lib/reliability.ts): what may be called Live, how events merge, what a selection lights
 * up. TypeScript is transpiled in memory, as in sentinelPanel.test.js, because Node 20 cannot import it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { EDGES } from "../../services/reliability/constants.js";

function load(relative) {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

const { CONNECTION_LABEL, NODE_POSITION, RECONNECT_MAX_MS, STREAM_SILENCE_MS, CONNECTION_LOST_MS, connectionState, edgePath, edgeWidth, formatCoverage, formatDuration, formatPercent, formatPercentile, formatRate, highlightSet, matchesFilters, mergeEvents, reconnectDelayMs, snapshotIsFresh, staleView, trafficDots } = load("../../admin-panel/lib/reliability.ts");

const NOW = 1_800_000_000_000;
const event = (id, at, extra = {}) => ({ id, at: new Date(at).toISOString(), lastAt: null, type: "webhook.accepted", severity: "info", component: "webhook", message: "x", correlationId: null, orderKey: null, incidentId: null, count: 1, ...extra });
const facts = (overrides = {}) => ({ transport: "stream", lastMessageAt: NOW - 1_000, failures: 0, paused: false, signedOut: false, snapshotFresh: true, now: NOW, ...overrides });

describe("event merging", () => {
  test("a repeated event stays one row", () => {
    assert.equal(mergeEvents([event("a", NOW)], [event("a", NOW)]).length, 1);
  });

  test("a coalesced update replaces its row", () => {
    const merged = mergeEvents([event("a", NOW)], [event("a", NOW, { count: 9 })]);
    assert.equal(merged[0].count, 9);
  });

  test("a late event lands in time order", () => {
    const merged = mergeEvents([event("new", NOW), event("old", NOW - 10_000)], [event("late", NOW - 5_000)]);
    assert.deepEqual(merged.map((item) => item.id), ["new", "late", "old"]);
  });

  test("a reconnect that replays everything changes nothing", () => {
    const first = mergeEvents([], [event("a", NOW), event("b", NOW - 1)]);
    assert.deepEqual(mergeEvents(first, first), first);
  });

  test("the list is capped", () => {
    const many = Array.from({ length: 500 }, (_, index) => event(String(index), NOW - index));
    assert.equal(mergeEvents([], many).length, 200);
    assert.equal(mergeEvents([], many)[0].id, "0");
  });
});

describe("live filtering", () => {
  test("severity is a floor", () => {
    assert.equal(matchesFilters(event("a", NOW, { severity: "error" }), { severity: "warning" }), true);
    assert.equal(matchesFilters(event("a", NOW, { severity: "info" }), { severity: "warning" }), false);
  });

  test("a type filter matches its family", () => {
    assert.equal(matchesFilters(event("a", NOW), { type: "webhook" }), true);
    assert.equal(matchesFilters(event("a", NOW), { type: "webhook.accepted" }), true);
    assert.equal(matchesFilters(event("a", NOW), { type: "web" }), false);
  });

  test("component and time", () => {
    assert.equal(matchesFilters(event("a", NOW), { component: "orders" }), false);
    assert.equal(matchesFilters(event("a", NOW - 10), { since: NOW }), false);
  });
});

describe("what may be called live", () => {
  test("a recent stream message and a fresh monitor are live", () => {
    assert.equal(connectionState(facts()), "live");
  });

  test("a connected stream with a dead monitor is stale, not live", () => {
    assert.equal(connectionState(facts({ snapshotFresh: false })), "stale");
  });

  test("a stream gone quiet is not live", () => {
    assert.equal(connectionState(facts({ lastMessageAt: NOW - STREAM_SILENCE_MS - 1 })), "reconnecting");
  });

  test("long silence is disconnected, whatever the transport says", () => {
    assert.equal(connectionState(facts({ lastMessageAt: NOW - CONNECTION_LOST_MS - 1 })), "disconnected");
  });

  test("polling says polling", () => {
    assert.equal(connectionState(facts({ transport: "polling" })), "polling");
  });

  test("before any data: connecting, then disconnected once an attempt failed", () => {
    assert.equal(connectionState(facts({ lastMessageAt: null })), "connecting");
    assert.equal(connectionState(facts({ lastMessageAt: null, failures: 1 })), "disconnected");
  });

  test("a hidden tab is paused and a lapsed session is signed out, whatever else is true", () => {
    assert.equal(connectionState(facts({ paused: true })), "paused");
    assert.equal(connectionState(facts({ signedOut: true, paused: true })), "signed_out");
  });

  test("only one state has the ok tone", () => {
    assert.deepEqual(Object.entries(CONNECTION_LABEL).filter(([, view]) => view.tone === "ok").map(([name]) => name), ["live"]);
  });

  test("the server's own word on freshness wins", () => {
    const snapshot = (fresh, lastTickAt = NOW) => ({ monitoring: { lastTickAt: new Date(lastTickAt).toISOString(), intervalSeconds: 30, fresh } });
    assert.equal(snapshotIsFresh(snapshot(true), NOW), true);
    assert.equal(snapshotIsFresh(snapshot(false), NOW), false);
    assert.equal(snapshotIsFresh(snapshot(true, NOW - 600_000), NOW), false, "a client clock can only make it worse");
    assert.equal(snapshotIsFresh(null, NOW), false);
    assert.equal(snapshotIsFresh({ monitoring: { lastTickAt: null } }, NOW), false);
  });

  test("reconnecting backs off, up to a ceiling", () => {
    assert.equal(reconnectDelayMs(0), 2_000);
    assert.equal(reconnectDelayMs(1), 4_000);
    assert.equal(reconnectDelayMs(3), 16_000);
    assert.equal(reconnectDelayMs(50), RECONNECT_MAX_MS);
  });
});

describe("a dead monitor on a live connection", () => {
  const snapshot = { overall: { state: "healthy", reason: "fine", affected: [], unverified: [] }, components: [{ id: "redis", state: "healthy", reason: "The last check succeeded." }], edges: [{ id: "a", measured: true, count: 40, perMinute: 2 }] };

  test("the last healthy does not stay on screen", () => {
    for (const connection of ["stale", "disconnected"]) {
      const shown = staleView(snapshot, connection);
      assert.equal(shown.overall.state, "stale", connection);
      assert.equal(shown.components[0].state, "stale", connection);
      assert.match(shown.components[0].reason, /Last known: healthy/);
    }
  });

  test("traffic disappears with it, so no dot moves on old data", () => {
    assert.equal(trafficDots({ kind: "flow", ...staleView(snapshot, "stale").edges[0] }), 0);
  });

  test("a live, polling or briefly reconnecting page keeps what it has", () => {
    for (const connection of ["live", "polling", "reconnecting", "connecting", "paused"]) assert.equal(staleView(snapshot, connection), snapshot, connection);
  });
});

describe("topology", () => {
  const edges = EDGES.map((edge) => ({ ...edge, tone: edge.tone ?? "normal", measured: edge.kind === "flow", count: 0, perMinute: 0 }));

  test("every server edge can be drawn, between real nodes", () => {
    for (const edge of edges) {
      assert.ok(NODE_POSITION[edge.from], edge.from);
      assert.ok(NODE_POSITION[edge.to], edge.to);
      assert.match(edgePath(edge), /^M /);
    }
  });

  test("silence draws no dots, and an unmeasured link never does", () => {
    assert.equal(trafficDots({ kind: "flow", measured: true, count: 0 }), 0);
    assert.equal(trafficDots({ kind: "flow", measured: false, count: 500 }), 0);
    assert.equal(trafficDots({ kind: "uses", measured: true, count: 500 }), 0);
    assert.equal(trafficDots({ kind: "flow", measured: true, count: null }), 0);
  });

  test("more traffic means more dots, up to a small limit", () => {
    assert.equal(trafficDots({ kind: "flow", measured: true, count: 1 }), 1);
    assert.ok(trafficDots({ kind: "flow", measured: true, count: 1_000 }) > trafficDots({ kind: "flow", measured: true, count: 10 }));
    assert.equal(trafficDots({ kind: "flow", measured: true, count: 10_000_000 }), 4);
  });

  test("the widest link stays a thin mark", () => {
    assert.ok(edgeWidth({ measured: true, count: 1e9 }) <= 4.5);
  });

  test("selecting a node lights what touches it, in both directions", () => {
    const highlight = highlightSet(edges, { node: "orders" });
    assert.ok(highlight.nodes.has("polling"), "upstream");
    assert.ok(highlight.nodes.has("wizardxray"), "downstream");
    assert.ok(highlight.nodes.has("mongodb"));
    assert.ok(!highlight.nodes.has("hooshpay"));
    assert.ok(highlight.edges.has("orders-wizardxray"));
    assert.ok(!highlight.edges.has("hooshpay-webhook"));
  });

  test("selecting an incident lights its path", () => {
    const highlight = highlightSet(edges, { path: ["mongodb", "webhook", "orders"] });
    assert.deepEqual([...highlight.nodes].sort(), ["mongodb", "orders", "webhook"]);
    assert.ok(highlight.edges.has("orders-mongodb"));
    assert.ok(!highlight.edges.has("telegram-polling"));
  });

  test("nothing selected lights nothing", () => {
    assert.equal(highlightSet(edges, { node: null, path: null }), null);
  });
});

describe("formats", () => {
  test("a percentile reads as an upper bound, and an exact value does not", () => {
    assert.equal(formatPercentile({ valueMs: 250, over: false }), "≤250 ms");
    assert.equal(formatPercentile({ valueMs: 2_500, over: false }), "≤2.5 s");
    assert.equal(formatPercentile({ valueMs: 2_500, over: false }, { exact: true }), "2.5 s");
    assert.equal(formatPercentile({ valueMs: null, over: true }), ">60 s");
    assert.equal(formatPercentile(null), "—");
  });

  test("rates", () => {
    assert.equal(formatPercent(null), "—");
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(1), "100%");
    assert.equal(formatPercent(0.0001), "<0.1%");
    assert.equal(formatRate(0), "0");
    assert.equal(formatRate(0.5), "0.50");
    assert.equal(formatRate(42.4), "42");
  });

  test("durations", () => {
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(900), "900 ms");
    assert.equal(formatDuration(90_000), "2 min");
    assert.equal(formatDuration(7_200_000), "2.0 h");
  });

  test("coverage says what was observed", () => {
    assert.equal(formatCoverage({ ratio: 1, observedMinutes: 60, expectedMinutes: 60 }), "Full window observed");
    assert.equal(formatCoverage({ ratio: 0, observedMinutes: 0, expectedMinutes: 60 }), "No telemetry in this window");
    assert.match(formatCoverage({ ratio: 0.1, observedMinutes: 6, expectedMinutes: 60 }), /of .* observed/);
  });
});
