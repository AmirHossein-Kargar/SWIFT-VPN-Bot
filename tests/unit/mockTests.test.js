/**
 * Mock-test harness: in-memory store semantics, runtime isolation from the real
 * models/network, the server-side gate, the run lock, and report shaping.
 * The full scenario suite runs here against the REAL production services with
 * guards installed on the real Mongoose models (no MongoDB is needed: any
 * fall-through to a real model would be reported as an isolation violation).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "-1001234567890";

const { createMemoryModel, matchesFilter } = await import("../../services/mockTests/memoryStore.js");
const { installIsolationGuards, runIsolated, MockIsolationError } = await import("../../services/mockTests/isolation.js");
const { createScenarioRecorder, finalizeScenario, summarize, redact, STATUS, BlockedError } = await import("../../services/mockTests/report.js");
const runner = await import("../../services/mockTests/runner.js");
const { isMockUserId, mockUserId } = await import("../../services/mockTests/fakes.js");
const { default: User } = await import("../../models/User.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");

const ADMIN = "424242";
const quiet = async (fn) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { [console.log, console.warn, console.error] = saved; }
};
const memoryDeps = () => ({
  runModel: createMemoryModel("runs", { unique: [["runId"]] }),
  auditModel: createMemoryModel("audit", { unique: [["operationId"]] }),
});

describe("memory store", () => {
  test("evaluates the query operators the money paths use", () => {
    const doc = { telegramId: "1", balance: 50, keys: ["a", "b"], status: "pending", services: [{ purchaseId: "p1" }], at: new Date(1000) };
    assert.ok(matchesFilter(doc, { balance: { $gte: 50 }, keys: { $ne: "c" }, status: { $in: ["pending", "paid"] } }));
    assert.ok(!matchesFilter(doc, { keys: { $ne: "a" } }), "$ne on an array means no element equals");
    assert.ok(matchesFilter(doc, { keys: "b", "services.purchaseId": "p1" }));
    assert.ok(matchesFilter(doc, { missing: null, $or: [{ status: "x" }, { at: { $lt: new Date(2000) } }] }));
    assert.ok(!matchesFilter(doc, { status: { $nin: ["pending"] } }));
  });

  test("findOneAndUpdate is atomic per document and unique indexes raise E11000", async () => {
    const users = createMemoryModel("users", { unique: [["telegramId"]], defaults: () => ({ balance: 0, keys: [] }) });
    await users.create({ telegramId: "1", balance: 100 });
    await assert.rejects(() => users.create({ telegramId: "1" }), (error) => error.code === 11000);
    const debits = await Promise.all(Array.from({ length: 5 }, () => users.findOneAndUpdate(
      { telegramId: "1", balance: { $gte: 30 } }, { $inc: { balance: -30 }, $addToSet: { keys: "k" } }, { new: true })));
    assert.equal(debits.filter(Boolean).length, 3, "only three 30-Toman debits fit in 100");
    assert.equal(users.peek({ telegramId: "1" }).balance, 10);
    assert.deepEqual(users.peek({ telegramId: "1" }).keys, ["k"]);
  });

  test("documents support save()/toObject() like Mongoose documents", async () => {
    const audit = createMemoryModel("audit", { unique: [["operationId"]] });
    const doc = await audit.create({ operationId: "op1", status: "started" });
    doc.status = "succeeded";
    await doc.save();
    assert.equal(audit.peek({ operationId: "op1" }).status, "succeeded");
    assert.equal(typeof doc.toObject().save, "undefined");
  });
});

describe("isolation guards", () => {
  test("real models and network calls throw inside a mock context, even when the error is swallowed", async () => {
    await installIsolationGuards();
    const { violations } = await runIsolated({ scenario: "probe" }, async () => {
      try { await User.findOne({ telegramId: "1" }); } catch { /* swallowed, as some production paths do */ }
      await assert.rejects(async () => WalletPurchase.updateOne({}, {}), MockIsolationError);
      assert.throws(() => https.request("https://example.invalid/"), MockIsolationError);
    });
    assert.ok(violations.includes("User.findOne"));
    assert.ok(violations.includes("WalletPurchase.updateOne"));
    assert.ok(violations.includes("https.request"));
  });

  test("outside a mock context the guarded models behave normally", async () => {
    await installIsolationGuards();
    // Not connected to MongoDB: a normal Mongoose query object is returned, not a MockIsolationError.
    const query = User.findOne({ telegramId: "1" });
    assert.equal(typeof query.exec, "function");
  });

  test("mock users live in a reserved ID range", () => {
    assert.ok(isMockUserId(mockUserId(1)));
    assert.ok(!isMockUserId("123456789"));
  });
});

describe("report shaping", () => {
  test("PASS requires executed assertions that all passed", () => {
    const now = new Date();
    const empty = finalizeScenario(createScenarioRecorder({ id: "x", title: "x", titleFa: "x" }), { startedAt: now, completedAt: now });
    assert.equal(empty.status, STATUS.BLOCKED, "nothing verified is never PASS");
    const t = createScenarioRecorder({ id: "x", title: "x", titleFa: "x" });
    t.check("ok", true);
    t.equal("bad", 1, 2);
    const failed = finalizeScenario(t, { startedAt: now, completedAt: now });
    assert.equal(failed.status, STATUS.FAIL);
    assert.match(failed.explanation, /bad/);
    const blocked = finalizeScenario(createScenarioRecorder({ id: "y", title: "y", titleFa: "y" }), { startedAt: now, completedAt: now, error: new BlockedError("needs config") });
    assert.equal(blocked.status, STATUS.BLOCKED);
    const t2 = createScenarioRecorder({ id: "z", title: "z", titleFa: "z" });
    t2.check("ok", true);
    assert.equal(finalizeScenario(t2, { startedAt: now, completedAt: now, violations: ["User.findOne"] }).status, STATUS.FAIL);
    assert.equal(summarize([failed, blocked]).overall, STATUS.FAIL);
  });

  test("error details are redacted", () => {
    const text = redact("failed at https://x.example/sub?hash=abc token=supersecretvalue " + "A".repeat(48));
    assert.ok(!text.includes("https://"));
    assert.ok(!text.includes("supersecretvalue"));
    assert.ok(!text.includes("A".repeat(48)));
  });
});

describe("runner", () => {
  beforeEach(() => runner.resetMockRunnerForTests());

  test("only allowlisted admins can run", async () => {
    await assert.rejects(() => runner.runMockTests({ actorId: "1", trigger: "test", env: { MOCK_TESTS_ENABLED: "true" }, ...memoryDeps() }),
      (error) => error.status === 403);
  });

  test("disabled by default: nothing executes and every scenario is NOT RUN", async () => {
    const deps = memoryDeps();
    const report = await runner.runMockTests({ actorId: ADMIN, trigger: "test", env: {}, ...deps });
    assert.equal(report.enabled, false);
    assert.ok(report.scenarios.every((scenario) => scenario.status === STATUS.NOT_RUN && scenario.assertions.length === 0));
    assert.equal(deps.runModel.rows.length + deps.auditModel.rows.length, 0);
  });

  test("a client cannot pick unknown scenarios", async () => {
    await assert.rejects(() => runner.runMockTests({ actorId: ADMIN, trigger: "test", scenarios: ["purchase", "drop_db"], env: { MOCK_TESTS_ENABLED: "true" }, ...memoryDeps() }),
      (error) => error.code === "invalid_mock_scenario");
  });

  test("all four scenarios PASS against the real services with zero isolation violations", async () => {
    const deps = memoryDeps();
    const report = await quiet(() => runner.runMockTests({ actorId: ADMIN, trigger: "test", env: { MOCK_TESTS_ENABLED: "true" }, ...deps }));
    for (const scenario of report.scenarios) {
      assert.equal(scenario.status, STATUS.PASS, `${scenario.id}: ${scenario.explanation} ${scenario.error || ""}`);
      assert.deepEqual(scenario.isolationViolations, []);
      assert.ok(scenario.counts.passed >= 25, `${scenario.id} executed ${scenario.counts.passed} assertions`);
      assert.ok(scenario.startedAt && scenario.completedAt);
    }
    assert.equal(report.summary.overall, STATUS.PASS);
    assert.match(report.runId, /^MT-\d{14}-[0-9a-f]{8}$/);
    assert.equal(report.persisted, true);
    assert.equal(deps.runModel.rows.length, 1, "only the report is persisted");
    const audit = deps.auditModel.rows;
    assert.equal(audit.length, 1, "scenario audit rows stay inside the mock dataset");
    assert.equal(audit[0].action, "MOCK_TEST_RUN");
    assert.equal(audit[0].status, "succeeded");

    const telegram = runner.formatReportForTelegram(report);
    assert.ok(telegram.length < 4096);
    assert.match(telegram, /PASS/);

    const listed = await runner.listMockRuns({ actorId: ADMIN, runModel: deps.runModel });
    assert.equal(listed.items[0].runId, report.runId);
    const detail = await runner.getMockRun({ actorId: ADMIN, runId: report.runId, runModel: deps.runModel });
    assert.ok(detail.scenarios[0].assertions.length > 0);
  });

  test("one run at a time, with a short cool-down between runs", async () => {
    const deps = memoryDeps();
    const env = { MOCK_TESTS_ENABLED: "true" };
    const first = quiet(() => runner.runMockTests({ actorId: ADMIN, trigger: "test", scenarios: ["trial"], env, ...deps }));
    await assert.rejects(() => runner.runMockTests({ actorId: ADMIN, trigger: "test", scenarios: ["trial"], env, ...deps }),
      (error) => error.code === "mock_run_in_progress");
    const report = await first;
    assert.equal(report.scenarios.find((scenario) => scenario.id === "trial").status, STATUS.PASS);
    assert.equal(report.scenarios.find((scenario) => scenario.id === "purchase").status, STATUS.NOT_RUN);
    await assert.rejects(() => runner.runMockTests({ actorId: ADMIN, trigger: "test", env, ...deps }),
      (error) => error.code === "mock_run_rate_limited");
  });

  test("a missing report store degrades to in-memory history", async () => {
    const broken = { create: async () => { throw new Error("db down"); }, find: () => { throw new Error("db down"); }, findOne: () => { throw new Error("db down"); } };
    const report = await quiet(() => runner.runMockTests({ actorId: ADMIN, trigger: "test", scenarios: ["trial"], env: { MOCK_TESTS_ENABLED: "true" }, runModel: broken, auditModel: memoryDeps().auditModel }));
    assert.equal(report.persisted, false);
    const listed = await runner.listMockRuns({ actorId: ADMIN, runModel: broken });
    assert.equal(listed.source, "memory");
    assert.equal(listed.items[0].runId, report.runId);
  });
});
