/**
 * The panel's own Sentinel logic (admin-panel/lib/sentinel.ts): merging a polled feed, backing off, stating freshness,
 * drawing the graph. TypeScript is transpiled in memory, as in healthStatus.test.js, because Node 20 cannot import it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function load(relative) {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

const { FEED_INTERVAL_MS, FEED_OVERLAP_MS, buildFlowGraph, feedDelayMs, feedHealth, findingReport, formatAge, formatSpan, mergeFeedEvents, overlapCursor, particleCount } = load("../../admin-panel/lib/sentinel.ts");

const event = (id, at) => ({ id, key: "k", kind: "payment", provider: "hooshpay", stage: "credited", at, amount: 1, currency: "Toman", user: null, status: "paid", source: "x", basis: "recorded" });

describe("feed merging", () => {
  test("a repeated event stays one row", () => {
    const merged = mergeFeedEvents([event("a", "2026-11-01T10:00:00Z")], [event("a", "2026-11-01T10:00:00Z")]);
    assert.equal(merged.length, 1);
  });

  test("a late event lands in time order, not arrival order", () => {
    const merged = mergeFeedEvents([event("new", "2026-11-01T10:05:00Z"), event("old", "2026-11-01T10:00:00Z")], [event("late", "2026-11-01T10:02:00Z")]);
    assert.deepEqual(merged.map((item) => item.id), ["new", "late", "old"]);
  });

  test("the list is bounded and keeps the newest", () => {
    const many = Array.from({ length: 200 }, (_, index) => event(`e${index}`, new Date(1_000_000 + index * 1000).toISOString()));
    const merged = mergeFeedEvents([], many, 150);
    assert.equal(merged.length, 150);
    assert.equal(merged[0].id, "e199");
  });

  test("merging is deterministic whichever order the polls arrive in", () => {
    const a = event("a", "2026-11-01T10:00:00Z");
    const b = event("b", "2026-11-01T10:00:00Z");
    assert.deepEqual(mergeFeedEvents([a], [b]).map((item) => item.id), mergeFeedEvents([b], [a]).map((item) => item.id));
  });

  test("the cursor reaches back so nothing written just behind a poll is lost", () => {
    assert.equal(new Date("2026-11-01T10:00:00Z") - new Date(overlapCursor("2026-11-01T10:00:00Z")), FEED_OVERLAP_MS);
  });
});

describe("reconnection and freshness", () => {
  test("failures back off and stop at a ceiling", () => {
    assert.equal(feedDelayMs(0), FEED_INTERVAL_MS);
    assert.ok(feedDelayMs(1) > feedDelayMs(0));
    assert.ok(feedDelayMs(2) > feedDelayMs(1));
    assert.equal(feedDelayMs(30), 60_000);
  });

  test("live is earned by a recent success, and old data never looks live", () => {
    const now = 1_000_000;
    assert.equal(feedHealth({ lastSyncAt: null, paused: false, now }), "connecting");
    assert.equal(feedHealth({ lastSyncAt: now - 5_000, paused: false, now }), "live");
    assert.equal(feedHealth({ lastSyncAt: now - 30_000, paused: false, now }), "delayed");
    assert.equal(feedHealth({ lastSyncAt: now - 300_000, paused: false, now }), "stale");
    assert.equal(feedHealth({ lastSyncAt: now - 5_000, paused: true, now }), "paused");
  });

  test("ages and spans read naturally", () => {
    assert.equal(formatAge(1_000), "just now");
    assert.equal(formatAge(42_000), "42s ago");
    assert.equal(formatAge(3 * 3_600_000), "3h ago");
    assert.equal(formatSpan(null), "—");
    assert.equal(formatSpan(1_500), "1.5 s");
  });
});

describe("flow graph", () => {
  const cohort = (provider, initiated, confirmed, credited) => ({ provider, label: provider, initiated: { count: initiated, amount: initiated * 100 }, confirmed: { count: confirmed, amount: confirmed * 100 }, credited: { count: credited, amount: credited * 100 } });
  const amounted = (count) => ({ count, amount: count * 10 });
  const flow = {
    generatedAt: "", range: "24h", provider: "all", from: "",
    payments: [cohort("hooshpay", 10, 8, 7), cohort("nowpayments", 2, 2, 2), cohort("bank", 0, 0, 0), cohort("trx", 0, 0, 0)],
    orders: { reserved: amounted(5), held: amounted(1), fulfilled: amounted(3), refunded: amounted(1), failed: amounted(0) },
    admin: { added: amounted(1), removed: amounted(0) },
    anomalies: { payment: { count: 1, rank: 2 }, order: { count: 2, rank: 1 }, stuck: { count: 1, rank: 0 } },
    degraded: [],
  };

  test("each stage shows its own total, from the server's numbers", () => {
    const { nodes } = buildFlowGraph(flow);
    const count = (id) => nodes.find((node) => node.id === id).count;
    assert.equal(count("hooshpay"), 10);
    assert.equal(count("confirmed"), 10);
    assert.equal(count("wallet"), 9);
    assert.equal(count("reserved"), 5);
    assert.equal(count("fulfilled"), 3);
    assert.equal(count("admin"), 1);
  });

  test("the worst severity of a stage's categories marks it; a clean stage has no mark", () => {
    const { nodes } = buildFlowGraph(flow);
    assert.equal(nodes.find((node) => node.id === "reserved").alert, "critical");
    assert.equal(nodes.find((node) => node.id === "confirmed").alert, "medium");
    assert.equal(nodes.find((node) => node.id === "wallet").alert, null);
  });

  test("an edge with no records has no particles, and a busy edge is capped", () => {
    assert.equal(particleCount(0), 0);
    assert.ok(particleCount(1) >= 1);
    assert.equal(particleCount(10_000_000), 5);
    const { edges } = buildFlowGraph(flow);
    assert.equal(edges.find((edge) => edge.id === "bank-confirmed").particles, 0);
    assert.ok(edges.reduce((sum, edge) => sum + edge.particles, 0) <= 50);
  });

  test("missing sections draw an empty graph instead of crashing", () => {
    const { nodes, edges } = buildFlowGraph({ ...flow, payments: null, orders: null, admin: null, anomalies: {} });
    assert.equal(nodes.length, 10);
    assert.ok(edges.every((edge) => edge.particles === 0));
  });
});

test("the copied report carries the masked customer, never the full id", () => {
  const report = findingReport({
    title: "T", severity: "high", classification: "confirmed", review: "new", user: "12••••90", userId: "1234567890", subject: "user:1234567890", firstDetectedAt: "x", expected: "e", observed: "o", amountToman: 5, direction: "none",
    revalidation: { checkedAt: "y", stillReproduces: true }, explanation: { why: "w", likelyCause: "c", options: [] }, timeline: [],
  });
  assert.ok(!report.includes("1234567890"));
  assert.match(report, /still reproduces/);
  assert.match(report, /not proven/);
});
