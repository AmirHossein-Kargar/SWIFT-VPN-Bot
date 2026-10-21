import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242";

const { normalizeListing, runBlockedReason, isGenuinePass, runDurationMs, formatDuration } = await import("../../admin-panel/lib/mockTests.ts");
const { listMockRuns } = await import("../../services/mockTests/runner.js");

const run = (overrides = {}) => ({
  runId: "mock_abc",
  trigger: "web",
  requestedScenarios: ["purchase"],
  startedAt: "2026-10-20T10:00:00.000Z",
  completedAt: "2026-10-20T10:00:02.500Z",
  summary: { overall: "PASS", PASS: 1, FAIL: 0, BLOCKED: 0, "NOT RUN": 0, assertions: 5, assertionsFailed: 0 },
  scenarios: [{ id: "purchase", title: "Purchase", titleFa: "خرید", status: "PASS", counts: { total: 5, passed: 5, failed: 0, skipped: 0 }, explanation: null }],
  ...overrides,
});

describe("Mock Tests page data handling (regression: page crashed on load)", () => {
  test("contract: a REAL runner report and listing normalize without loss (no hand-written fixtures)", async () => {
    const { runMockTests, getMockRun } = await import("../../services/mockTests/runner.js");
    const { createMemoryModel } = await import("../../services/mockTests/memoryStore.js");
    const runModel = createMemoryModel("runs", { unique: [["runId"]] });
    const auditModel = createMemoryModel("audit", { unique: [["operationId"]] });
    const saved = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    let report;
    try {
      report = await runMockTests({ actorId: "424242", trigger: "web", scenarios: "all", env: { MOCK_TESTS_ENABLED: "true" }, runModel, auditModel });
    } finally { [console.log, console.warn, console.error] = saved; }

    const listing = await listMockRuns({ actorId: "424242", limit: 5, runModel });
    assert.equal(Array.isArray(listing), false, "the server returns an object, which the old page mistook for an array");
    const normalized = normalizeListing(listing);
    assert.equal(normalized.enabled, listing.enabled);
    assert.ok(normalized.scenarios.length >= 4, "scenario catalogue drives the per-scenario Run buttons");
    assert.equal(normalized.items.length, 1);
    const item = normalized.items[0];
    assert.equal(item.runId, report.runId);
    assert.equal(item.summary.overall, report.summary.overall, "overall status survives normalization");
    for (const scenario of report.scenarios) {
      const shown = item.scenarios.find((entry) => entry.id === scenario.id);
      assert.ok(shown, `${scenario.id} present in the list view`);
      assert.equal(shown.status, scenario.status, `${scenario.id} status is shown exactly as the server reported it`);
    }
    assert.equal(isGenuinePass(item), report.summary.overall === "PASS" && report.summary.PASS > 0);

    const detail = await getMockRun({ actorId: "424242", runId: report.runId, runModel });
    for (const scenario of detail.scenarios) {
      assert.ok("error" in scenario || scenario.status !== "FAIL", "failed scenarios carry `error`, the field the old UI mis-named errorDetail");
      assert.equal(Array.isArray(scenario.assertions), true, "details sheet needs per-check data");
    }
  });

  test("a disabled server yields NOT RUN everywhere and the UI never reports success", async () => {
    const { runMockTests } = await import("../../services/mockTests/runner.js");
    const { createMemoryModel } = await import("../../services/mockTests/memoryStore.js");
    const report = await runMockTests({ actorId: "424242", trigger: "web", scenarios: "all", env: {}, runModel: createMemoryModel("runs"), auditModel: createMemoryModel("audit") });
    assert.equal(report.enabled, false);
    assert.ok(report.scenarios.every((scenario) => scenario.status === "NOT RUN"));
    assert.equal(isGenuinePass(report), false);
  });

  test("malformed, null and legacy-array responses render as empty instead of crashing", () => {
    for (const raw of [null, undefined, "x", 42, {}, { items: "nope" }, { items: [null, { noRunId: true }] }]) {
      const listing = normalizeListing(raw);
      assert.deepEqual(listing.items, []);
      assert.equal(listing.enabled, false);
    }
    assert.equal(normalizeListing([run()]).items.length, 1);
  });

  test("unknown statuses are never upgraded to a pass", () => {
    const listing = normalizeListing({ enabled: true, items: [run({ summary: { overall: "GREEN" }, scenarios: [{ id: "x", status: "OK" }] })] });
    assert.equal(listing.items[0].summary.overall, "NOT RUN");
    assert.equal(listing.items[0].scenarios[0].status, "NOT RUN");
    assert.equal(isGenuinePass(listing.items[0]), false);
  });

  test("a run counts as passed only if scenarios actually executed and none failed or were blocked", () => {
    assert.equal(isGenuinePass(run()), true);
    assert.equal(isGenuinePass(run({ summary: { ...run().summary, PASS: 0 } })), false, "nothing executed");
    assert.equal(isGenuinePass(run({ summary: { ...run().summary, overall: "PARTIAL", BLOCKED: 1 } })), false);
  });

  test("run buttons explain why they are disabled", () => {
    assert.match(runBlockedReason({ enabled: false, running: false }, false), /disabled/);
    assert.match(runBlockedReason({ enabled: true, running: true }, false), /still in progress/);
    assert.equal(runBlockedReason({ enabled: true, running: false }, false), null);
  });

  test("durations", () => {
    assert.equal(formatDuration(runDurationMs(run())), "2.5 s");
    assert.equal(formatDuration(runDurationMs(run({ completedAt: "garbage" }))), "—");
  });
});
