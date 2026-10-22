/**
 * Sweeper, backfill and verify against a REAL MongoDB.
 *
 * The timing tests drive the sweeper with an injected database clock (`serverNow`) and place purchases at exact
 * completedAt values, so the correctness argument in userSpendSweeper.js is exercised at its boundaries:
 * write delay / clock skew up to the lookback (phase A), beyond it (phase B), future-dated rows, long multi-tick
 * scans, crash/restart and lease loss. Skips without a database.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { counters, insertPurchases, insertUsers, purchaseDoc, sleep, userDoc } from "../helpers/userSpendFixtures.js";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let User, WalletPurchase, JobCheckpoint, lease, spend, sweeper, maintenance;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: JobCheckpoint } = await import("../../models/JobCheckpoint.js"));
  lease = await import("../../services/jobLease.js");
  spend = await import("../../services/users/userSpend.js");
  sweeper = await import("../../services/users/userSpendSweeper.js");
  maintenance = await import("../../services/users/userSpendMaintenance.js");
}

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
// The coverage claim is stated for THIS value; the default must not shrink below it (a smaller lookback narrows phase A's guarantee).
const L = 15 * 60_000;
const pair = (S, C) => ({ totalSpent: S, completedOrderCount: C });
const at = (ms) => new Date(ms);
const tick = (nowMs, options = {}) => sweeper.runUserSpendSweepTick({ serverNow: at(nowMs), ...options });
const sweeperState = async () => (await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB))?.state || {};
const tsOf = (value) => (value ? new Date(value).getTime() : value);

async function allCountersExact() {
  const truth = new Map();
  for (const row of await WalletPurchase.collection.find({ status: "completed" }).toArray()) {
    const entry = truth.get(row.telegramId) || { s: 0, c: 0 };
    entry.s += row.amount; entry.c += 1; truth.set(row.telegramId, entry);
  }
  let checked = 0;
  for await (const user of User.collection.find({})) {
    const expected = truth.get(user.telegramId) || { s: 0, c: 0 };
    assert.deepEqual([user.totalSpent, user.completedOrderCount], [expected.s, expected.c], `user ${user.telegramId}`);
    checked += 1;
  }
  return checked;
}
const flakyUsers = (failOnCall) => {
  let calls = 0;
  return {
    get calls() { return calls; },
    find: (...args) => User.find(...args),
    collection: { bulkWrite: async (...args) => { calls += 1; if (calls === failOnCall) throw new Error("simulated crash"); return User.collection.bulkWrite(...args); } },
  };
};

describe("user spend sweeper", () => {
  before(async () => { if (dbAvailable) await Promise.all([User.syncIndexes(), WalletPurchase.syncIndexes(), JobCheckpoint.syncIndexes()]); });
  beforeEach(async () => {
    if (!dbAvailable) return;
    await Promise.all([User.deleteMany({}), WalletPurchase.deleteMany({}), JobCheckpoint.deleteMany({})]);
  });
  after(async () => { if (dbAvailable) await disconnectTestDB(); });

  // ── Phase A ──────────────────────────────────────────────────────────────────────────────────────────────
  skip("phase A repairs counters for completions whose hook never ran, and the watermark is the scan's start", async () => {
    await insertUsers(User, [userDoc("a", pair(0, 0)), userDoc("b", pair(0, 0)), userDoc("zero", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [
      purchaseDoc("a", { amount: 10_000, completedAt: at(T0 - 60_000) }),
      purchaseDoc("a", { amount: 5_000, completedAt: at(T0 - 30_000) }),
      purchaseDoc("b", { amount: 7_000, completedAt: at(T0 - 90_000) }),
      purchaseDoc("zero", { status: "failed", amount: 99_000, completedAt: null }),
    ]);
    const result = await tick(T0, { skipReconcile: true });
    assert.equal(result.error, null);
    assert.deepEqual(await counters(User, "a"), pair(15_000, 2));
    assert.deepEqual(await counters(User, "b"), pair(7_000, 1));
    assert.deepEqual(await counters(User, "zero"), pair(0, 0));
    const state = await sweeperState();
    assert.equal(tsOf(state.watermarkAt), T0);
    assert.equal(state.scan, undefined);
    assert.equal(state.consecutiveFailures, 0);

    await tick(T0 + 120_000, { skipReconcile: true });
    assert.equal(tsOf((await sweeperState()).watermarkAt), T0 + 120_000);
  });

  skip("a scan larger than one tick resumes from its keyset cursor (ties included) and the watermark moves only when it is complete", async () => {
    const owners = Array.from({ length: 7 }, (_, i) => `m${i}`);
    await insertUsers(User, owners.map((id) => userDoc(id, pair(0, 0))));
    // rows 2,3,4 share one completedAt, straddling the page boundary
    const times = [T0 - 9_000, T0 - 8_000, T0 - 5_000, T0 - 5_000, T0 - 5_000, T0 - 2_000, T0 - 1_000];
    await insertPurchases(WalletPurchase, owners.map((id, i) => purchaseDoc(id, { amount: 1_000 * (i + 1), completedAt: at(times[i]) })));
    const options = { skipReconcile: true, pageSize: 3, maxPagesPerTick: 1 };

    await tick(T0, options);
    let state = await sweeperState();
    assert.equal(state.watermarkAt, undefined, "an unfinished scan must not advance the watermark");
    assert.equal(tsOf(state.scan.startedAt), T0);
    assert.ok(state.scan.cursorAt && state.scan.cursorId);
    assert.deepEqual((await counters(User, "m2")), pair(3_000, 1));
    assert.deepEqual((await counters(User, "m3")), pair(0, 0), "row 4 is on the next page");

    await tick(T0 + 10_000, options);
    state = await sweeperState();
    assert.equal(state.watermarkAt, undefined);
    assert.equal(tsOf(state.scan.startedAt), T0, "the scan keeps the start time it began with");
    await tick(T0 + 20_000, options);
    state = await sweeperState();
    assert.equal(tsOf(state.watermarkAt), T0, "complete: the watermark is the START of that scan, not the last tick");
    assert.equal(state.scan, undefined);
    assert.equal(await allCountersExact(), 7);
  });

  skip("a crash or failed batch never advances the checkpoint; the restart resumes after the last finished page without redoing it", async () => {
    const owners = Array.from({ length: 6 }, (_, i) => `x${i}`);
    await insertUsers(User, owners.map((id) => userDoc(id, pair(0, 0))));
    await insertPurchases(WalletPurchase, owners.map((id, i) => purchaseDoc(id, { amount: 2_000 + i, completedAt: at(T0 - (6 - i) * 1_000) })));
    const options = { skipReconcile: true, pageSize: 2, userBatch: 1 };

    const flaky = flakyUsers(3); // page 1 = calls 1-2 succeed, page 2 dies on its first batch
    const failed = await tick(T0, { ...options, userModel: flaky });
    assert.equal(failed.error, "Error");
    let state = await sweeperState();
    assert.equal(state.watermarkAt, undefined);
    assert.equal(state.consecutiveFailures, 1);
    assert.ok(state.scan.cursorAt, "page 1 had finished, so the cursor moved past it");
    assert.ok(await lease.acquireLease(JobCheckpoint, spend.SPEND_SWEEPER_JOB, "next", 1_000), "the lease was released on failure");
    await lease.releaseLease(JobCheckpoint, { name: spend.SPEND_SWEEPER_JOB, owner: "next", ttlMs: 1_000 });

    const healthy = flakyUsers(-1);
    const recovered = await tick(T0 + 5_000, { ...options, userModel: healthy });
    assert.equal(recovered.error, null);
    assert.equal(healthy.calls, 4, "only the remaining 4 owners were re-processed, not page 1 again");
    state = await sweeperState();
    assert.equal(tsOf(state.watermarkAt), T0, "the completed scan reports the start time of the scan that finished");
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(await allCountersExact(), 6);
  });

  // ── The coverage argument: delay, skew, long scans ─────────────────────────────────────────────────────────
  skip("the shipped lookback is at least the 15 minutes the coverage argument and these tests assume", () => {
    assert.ok(sweeper.SWEEPER_DEFAULTS.lookbackMs >= L);
  });

  skip("a completion written with delay or clock skew d is covered by phase A when d <= lookback, and by phase B beyond it", async () => {
    const cases = [
      { label: "no delay", d: 0, byA: true },
      { label: "delay just under the lookback", d: L - 1_000, byA: true },
      { label: "delay equal to the lookback", d: L, byA: true },
      { label: "delay beyond the lookback", d: L + 61_000, byA: false },
      { label: "clock 40 minutes behind", d: 40 * 60_000, byA: false },
    ];
    for (const { label, d, byA } of cases) {
      await Promise.all([User.deleteMany({}), WalletPurchase.deleteMany({}), JobCheckpoint.deleteMany({})]);
      await insertUsers(User, [userDoc("late", pair(0, 0))]);
      await tick(T0, { skipReconcile: true });                              // a scan completed at T0
      const writtenAt = T0 + 60_000;                                         // the row becomes visible now...
      await insertPurchases(WalletPurchase, [purchaseDoc("late", { amount: 8_000, completedAt: at(writtenAt - d) })]); // ...stamped d earlier
      await tick(T0 + 120_000, { skipReconcile: true });                     // the next scan

      const afterA = await counters(User, "late");
      assert.deepEqual(afterA, byA ? pair(8_000, 1) : pair(0, 0), `${label}: phase A`);
      if (!byA) {
        let passes = 0;
        for (let i = 0; i < 3 && !(await sweeperState()).lastPass; i += 1) { await tick(T0 + 180_000 + i, { skipScan: true }); passes += 1; }
        const { lastPass } = await sweeperState();
        assert.ok(lastPass, `${label}: one reconcile pass completed`);
        assert.equal(lastPass.under, 1, `${label}: phase B found the missed completion`);
        assert.deepEqual(await counters(User, "late"), pair(8_000, 1), `${label}: repaired by phase B`);
      }
    }
  });

  skip("a future-dated completedAt cannot push the watermark forward or hide later completions", async () => {
    await insertUsers(User, [userDoc("future", pair(0, 0)), userDoc("normal", pair(0, 0))]);
    await tick(T0, { skipReconcile: true });
    await insertPurchases(WalletPurchase, [purchaseDoc("future", { amount: 3_000, completedAt: at(T0 + 2 * 86_400_000) })]);
    await tick(T0 + 120_000, { skipReconcile: true });
    assert.deepEqual(await counters(User, "future"), pair(3_000, 1), "the open-ended scan sees it early");
    assert.equal(tsOf((await sweeperState()).watermarkAt), T0 + 120_000, "the watermark is the database time of the scan, not max(completedAt)");

    await insertPurchases(WalletPurchase, [purchaseDoc("normal", { amount: 4_000, completedAt: at(T0 + 10 * 60_000) })]);
    await tick(T0 + 11 * 60_000, { skipReconcile: true });
    assert.deepEqual(await counters(User, "normal"), pair(4_000, 1), "a normal completion after the skewed row is still found");
  });

  skip("a row that becomes visible behind a long scan's cursor is picked up by the next scan", async () => {
    const owners = Array.from({ length: 6 }, (_, i) => `l${i}`);
    await insertUsers(User, [...owners, "straggler"].map((id) => userDoc(id, pair(0, 0))));
    await insertPurchases(WalletPurchase, owners.map((id, i) => purchaseDoc(id, { amount: 1_000, completedAt: at(T0 - (7 - i) * 1_000) })));
    const options = { skipReconcile: true, pageSize: 3, maxPagesPerTick: 1 };
    await tick(T0, options);                                                  // page 1: rows at T0-7s..T0-5s, cursor at T0-5s
    await insertPurchases(WalletPurchase, [purchaseDoc("straggler", { amount: 9_000, completedAt: at(T0 - 5_500) })]); // behind the cursor
    await tick(T0 + 10_000, options);
    await tick(T0 + 20_000, options);
    assert.equal(tsOf((await sweeperState()).watermarkAt), T0, "the first scan finished");
    assert.deepEqual(await counters(User, "straggler"), pair(0, 0), "this scan had already passed its position");
    await tick(T0 + 180_000, options);                                        // next scan: from = T0 - lookback
    await tick(T0 + 181_000, options);
    assert.deepEqual(await counters(User, "straggler"), pair(9_000, 1));
  });

  // ── Restart, overlap, lease loss ───────────────────────────────────────────────────────────────────────────
  skip("restart: a dead owner blocks sweeps only until its lease expires, then the next process continues", async () => {
    await insertUsers(User, [userDoc("r", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [purchaseDoc("r", { amount: 6_000, completedAt: at(T0 - 5_000) })]);
    await lease.acquireLease(JobCheckpoint, spend.SPEND_SWEEPER_JOB, "dead-process", 60_000);
    assert.equal((await tick(T0)).skipped, "lease_unavailable");
    assert.deepEqual(await counters(User, "r"), pair(0, 0));
    await JobCheckpoint.collection.updateOne({ name: spend.SPEND_SWEEPER_JOB }, { $set: { leaseUntil: new Date(Date.now() - 1_000) } });
    assert.equal((await tick(T0, { skipReconcile: true })).error, null);
    assert.deepEqual(await counters(User, "r"), pair(6_000, 1));
  });

  skip("overlap: of two simultaneous sweeps exactly one runs", async () => {
    await insertUsers(User, [userDoc("o", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [purchaseDoc("o", { amount: 1_500, completedAt: at(T0 - 5_000) })]);
    const slow = { find: (...args) => User.find(...args), collection: { bulkWrite: async (...args) => { await sleep(200); return User.collection.bulkWrite(...args); } } };
    const results = await Promise.all([tick(T0, { userModel: slow, skipReconcile: true }), tick(T0, { userModel: slow, skipReconcile: true })]);
    assert.deepEqual(results.map((r) => r.skipped).sort(), [null, "lease_unavailable"].sort());
    assert.deepEqual(await counters(User, "o"), pair(1_500, 1));
  });

  skip("a sweep that loses its lease mid-run stops, writes no progress and leaves the new owner's lease alone", async () => {
    const owners = ["p0", "p1", "p2", "p3"];
    await insertUsers(User, owners.map((id) => userDoc(id, pair(0, 0))));
    await insertPurchases(WalletPurchase, owners.map((id, i) => purchaseDoc(id, { amount: 1_000, completedAt: at(T0 - (5 - i) * 1_000) })));
    let stolen = false;
    let writes = 0;
    const pausing = {
      find: (...args) => User.find(...args),
      collection: { bulkWrite: async (...args) => {
        writes += 1;
        if (!stolen) {
          stolen = true;
          await JobCheckpoint.collection.updateOne({ name: spend.SPEND_SWEEPER_JOB }, { $set: { leaseOwner: "intruder", leaseUntil: new Date(Date.now() + 60_000) } });
        }
        return User.collection.bulkWrite(...args);
      } },
    };
    const result = await tick(T0, { userModel: pausing, skipReconcile: true, pageSize: 2, userBatch: 1 });
    assert.equal(result.error, "LeaseLostError");
    assert.equal(writes, 1, "the sweep stopped at its next lease check instead of continuing without the lease");
    const doc = await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB);
    assert.equal(doc.leaseOwner, "intruder", "the old owner did not release or overwrite the new owner's lease");
    assert.equal(doc.state.watermarkAt, undefined);
    assert.equal(doc.state.lastSuccessAt, undefined);
    assert.equal(doc.state.consecutiveFailures, undefined, "a fenced-out process records nothing");
  });

  // ── Phase isolation ──────────────────────────────────────────────────────────────────────────────────────────
  const failingScan = () => new Proxy(WalletPurchase, {
    get(target, prop) {
      if (prop === "find") return () => { throw new Error("simulated scan failure"); };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const failingReconcile = () => ({ collection: User.collection, find: () => { throw new Error("simulated reconcile failure"); } });

  skip("phase isolation: a failing scan does not stop the reconcile, each phase reports its own failure, and the tick is unhealthy", async () => {
    await insertUsers(User, [userDoc("iso1", pair(0, 0)), userDoc("iso2", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [purchaseDoc("iso1", { amount: 4_000, completedAt: at(T0 - 86_400_000) })]);

    const result = await tick(T0, { purchaseModel: failingScan() });
    assert.equal(result.error, "Error", "the tick is not reported healthy");
    assert.equal(result.scan.error, "Error");
    assert.equal(result.reconcile.checked, 2, "the reconcile still ran");
    assert.deepEqual(await counters(User, "iso1"), pair(4_000, 1), "and repaired the counter the scan could not");

    const state = await sweeperState();
    assert.equal(state.scanConsecutiveFailures, 1);
    assert.equal(state.lastScanError, "Error");
    assert.equal(state.reconcileConsecutiveFailures, 0);
    assert.equal(tsOf(state.lastReconcileSuccessAt), T0);
    assert.equal(state.lastScanSuccessAt, undefined);
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.lastError, "Error");
    assert.equal(state.lastSuccessAt, undefined, "no healthy tick was recorded");
    assert.equal(state.watermarkAt, undefined, "the failed scan did not advance its checkpoint");
    assert.ok(state.lastPass, "the reconcile's own checkpoint advanced");

    const recovered = await tick(T0 + 1_000);
    assert.equal(recovered.error, null);
    const after = await sweeperState();
    assert.deepEqual([after.scanConsecutiveFailures, after.reconcileConsecutiveFailures, after.consecutiveFailures], [0, 0, 0]);
    assert.equal(after.lastScanError, undefined);
    assert.equal(after.lastError, undefined);
    assert.equal(tsOf(after.lastSuccessAt), T0 + 1_000);
    assert.equal(tsOf(after.watermarkAt), T0, "the scan that finally completed is the one that started at T0: a resumed scan keeps its start time");
  });

  skip("phase isolation: a failing reconcile does not stop the scan, and its own checkpoint does not move", async () => {
    await insertUsers(User, [userDoc("iso3", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [purchaseDoc("iso3", { amount: 3_000, completedAt: at(T0 - 60_000) })]);
    const result = await tick(T0, { userModel: failingReconcile() });
    assert.equal(result.error, "Error");
    assert.equal(result.scan.completed, true, "the scan ran to completion");
    assert.equal(result.reconcile.error, "Error");
    assert.deepEqual(await counters(User, "iso3"), pair(3_000, 1));

    const state = await sweeperState();
    assert.equal(tsOf(state.watermarkAt), T0, "the scan's checkpoint advanced");
    assert.equal(state.reconcileConsecutiveFailures, 1);
    assert.equal(state.lastReconcileError, "Error");
    assert.equal(state.scanConsecutiveFailures, 0);
    assert.equal(state.reconcileCursor, undefined, "the reconcile's checkpoint did not move");
    assert.equal(state.pass, undefined);
    assert.equal(state.lastPass, undefined);
    assert.equal(state.lastSuccessAt, undefined);
    assert.equal(state.consecutiveFailures, 1);
  });

  skip("phase isolation: when both phases fail both are recorded, and failures accumulate tick after tick", async () => {
    await insertUsers(User, [userDoc("iso4", pair(0, 0))]);
    const both = { purchaseModel: failingScan(), userModel: failingReconcile() };
    const first = await tick(T0, both);
    assert.equal(first.scan.error, "Error");
    assert.equal(first.reconcile.error, "Error");
    let state = await sweeperState();
    assert.deepEqual([state.scanConsecutiveFailures, state.reconcileConsecutiveFailures, state.consecutiveFailures], [1, 1, 1], "one tick, one tick-level failure");
    await tick(T0 + 1_000, both);
    await tick(T0 + 2_000, { purchaseModel: failingScan() });
    state = await sweeperState();
    assert.deepEqual([state.scanConsecutiveFailures, state.reconcileConsecutiveFailures, state.consecutiveFailures], [3, 0, 3]);
  });

  const stealingUsers = () => {
    let stolen = false;
    return {
      get stolen() { return stolen; },
      find: (...args) => User.find(...args),
      collection: { bulkWrite: async (...args) => {
        if (!stolen) {
          stolen = true;
          await JobCheckpoint.collection.updateOne({ name: spend.SPEND_SWEEPER_JOB }, { $set: { leaseOwner: "intruder", leaseUntil: new Date(Date.now() + 60_000) } });
        }
        return User.collection.bulkWrite(...args);
      } },
    };
  };

  skip("phase isolation: losing the lease during the scan aborts the whole tick: no reconcile, no progress, no failure record", async () => {
    const owners = ["ls0", "ls1", "ls2"];
    await insertUsers(User, owners.map((id) => userDoc(id, pair(0, 0))));
    await insertPurchases(WalletPurchase, owners.map((id, i) => purchaseDoc(id, { amount: 1_000, completedAt: at(T0 - (4 - i) * 1_000) })));
    const result = await tick(T0, { userModel: stealingUsers(), pageSize: 2, userBatch: 1 });
    assert.equal(result.error, "LeaseLostError");
    assert.equal(result.reconcile, null, "the other phase did not run without the lease");
    const doc = await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB);
    assert.equal(doc.leaseOwner, "intruder");
    for (const key of ["pass", "lastPass", "reconcileCursor", "watermarkAt", "lastSuccessAt", "lastScanSuccessAt", "scanConsecutiveFailures", "reconcileConsecutiveFailures", "consecutiveFailures", "lastError"]) {
      assert.equal(doc.state[key], undefined, `${key} must not be written by a process without the lease`);
    }
  });

  skip("phase isolation: losing the lease during the reconcile persists none of the reconcile's progress and records no failure", async () => {
    await insertUsers(User, [userDoc("lr0", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [purchaseDoc("lr0", { amount: 6_000, completedAt: at(T0 - 3 * 86_400_000) })]); // outside the scan window: only the reconcile repairs it
    const model = stealingUsers();
    const result = await tick(T0, { userModel: model });
    assert.equal(model.stolen, true, "the lease was taken inside the reconcile's repair write");
    assert.equal(result.error, "LeaseLostError");
    const doc = await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB);
    assert.equal(doc.leaseOwner, "intruder");
    assert.equal(tsOf(doc.state.watermarkAt), T0, "the scan finished while this process still held the lease, so its progress is legitimately saved");
    for (const key of ["pass", "lastPass", "reconcileCursor", "lastReconcileSuccessAt", "reconcileConsecutiveFailures", "lastReconcileError", "lastScanError", "lastSuccessAt", "consecutiveFailures", "lastError"]) {
      assert.equal(doc.state[key], undefined, `${key} must not be written after the lease was lost`);
    }
  });

  // ── Phase B ──────────────────────────────────────────────────────────────────────────────────────────────
  skip("phase B visits every user, completes a pass, wraps around, repairs under/missing and reports over-counts without lowering them", async () => {
    const users = Array.from({ length: 2_500 }, (_, i) => userDoc(`b${i}`, pair(0, 0)));
    await insertUsers(User, users);
    await insertPurchases(WalletPurchase, Array.from({ length: 30 }, (_, i) => purchaseDoc(`b${i * 80}`, { amount: 10_000, completedAt: at(T0 - 3 * 86_400_000) })));
    await User.collection.updateOne({ telegramId: "b1" }, { $unset: { totalSpent: "", completedOrderCount: "" } });   // missing (zero purchases)
    await User.collection.updateOne({ telegramId: "b2" }, { $set: { totalSpent: 777_000, completedOrderCount: 7 } }); // over-count

    const options = { skipScan: true, reconcileBatch: 1_000 };
    await tick(T0, options);
    let state = await sweeperState();
    assert.equal(state.pass.users, 1_000);
    assert.ok(state.reconcileCursor);
    await tick(T0 + 1, options);
    assert.equal((await sweeperState()).pass.users, 2_000);
    await tick(T0 + 2, options);
    state = await sweeperState();
    assert.equal(state.pass, undefined);
    assert.equal(state.reconcileCursor, null);
    assert.equal(state.lastPass.users, 2_500);
    assert.equal(state.lastPass.under, 30);
    assert.equal(state.lastPass.missing, 1);
    assert.equal(state.lastPass.over, 1);
    assert.equal(state.lastPass.overSamples.length, 1);
    assert.equal(state.lastPass.overSamples[0].telegramId, "b2");

    assert.deepEqual(await counters(User, "b0"), pair(10_000, 1), "an under-count was raised");
    assert.deepEqual(await counters(User, "b1"), pair(0, 0), "a missing counter became an explicit zero");
    assert.deepEqual(await counters(User, "b2"), pair(777_000, 7), "the over-count was reported and NOT lowered");

    await tick(T0 + 3, options);                                              // wraps: a new pass starts from the first user
    assert.equal((await sweeperState()).pass.users, 1_000);
    await tick(T0 + 4, options); await tick(T0 + 5, options);
    const second = (await sweeperState()).lastPass;
    assert.deepEqual([second.under, second.missing, second.over, second.repaired], [0, 0, 1, 0], "the second pass has nothing left to repair; the over-count stays visible");
  });

  // ── Backfill ─────────────────────────────────────────────────────────────────────────────────────────────
  async function seedBackfillWorld(count = 2_500) {
    await insertUsers(User, Array.from({ length: count }, (_, i) => userDoc(`f${i}`))); // no counters at all
    const purchases = [];
    for (let i = 0; i < count; i += 7) purchases.push(purchaseDoc(`f${i}`, { amount: 1_000 + i, completedAt: at(T0 - 86_400_000) }), purchaseDoc(`f${i}`, { amount: 500, status: "refunded", completedAt: null }));
    for (let i = 0; i < count; i += 50) purchases.push(purchaseDoc(`f${i}`, { amount: 2_000, completedAt: at(T0 - 3_600_000), revokedAt: new Date() }));
    await insertPurchases(WalletPurchase, purchases);
  }

  skip("backfill gives every user explicit counters (zero-purchase users 0/0), matches the truth, and is idempotent", async () => {
    await seedBackfillWorld();
    const summary = await maintenance.runUserSpendBackfill({ chunkSize: 1_000 });
    assert.equal(summary.completed, true);
    assert.equal(summary.chunks, 3);
    assert.equal(summary.users, 2_500);
    assert.equal(await User.countDocuments({ totalSpent: { $type: "number" }, completedOrderCount: { $type: "number" } }), 2_500, "no user is missing a counter");
    assert.equal(await allCountersExact(), 2_500);
    assert.deepEqual(await counters(User, "f1"), pair(0, 0));
    const again = await maintenance.runUserSpendBackfill({ chunkSize: 1_000, restart: true });
    assert.equal(again.raised, 0, "a second run changes nothing");
    assert.equal(await allCountersExact(), 2_500);
  });

  skip("backfill interrupted and resumed (stop, crash in a chunk, restart) finishes exactly once with exact counters", async () => {
    await seedBackfillWorld();
    const first = await maintenance.runUserSpendBackfill({ chunkSize: 1_000, maxChunks: 1 });
    assert.equal(first.completed, false);
    assert.ok((await lease.readCheckpoint(JobCheckpoint, spend.SPEND_BACKFILL_JOB)).state.cursor);

    await assert.rejects(() => maintenance.runUserSpendBackfill({ chunkSize: 1_000, onChunk: (progress) => { if (progress.chunks === 1) throw new Error("operator pressed ctrl-c"); } }), /ctrl-c/);
    const resumed = await maintenance.runUserSpendBackfill({ chunkSize: 1_000 });
    assert.equal(resumed.completed, true);
    assert.ok(resumed.resumedFrom, "continued from the checkpoint");
    assert.equal(resumed.users, 500, "only the unfinished tail was processed");
    assert.equal(await allCountersExact(), 2_500);
    assert.equal((await lease.readCheckpoint(JobCheckpoint, spend.SPEND_BACKFILL_JOB)).state.cursor, undefined);
  });

  skip("backfill while purchases keep completing: nothing is lowered or double counted, and everything converges", async () => {
    await seedBackfillWorld(1_200);
    const truthOf = async (id) => {
      const rows = await WalletPurchase.collection.find({ telegramId: id, status: "completed" }).toArray();
      return pair(rows.reduce((sum, row) => sum + row.amount, 0), rows.length);
    };
    const hooked = [];
    const lagging = [];
    let injected = 0;
    const summary = await maintenance.runUserSpendBackfill({
      chunkSize: 200,
      onChunk: async ({ chunks }) => {
        // After each chunk: one completion for a user the backfill already passed (hooked on odd chunks, its hook
        // "lost" on even ones) and one for a user in a later chunk (hooked on even chunks, lost on odd ones).
        const passed = `f${chunks}`;
        const ahead = `f${1_199 - chunks}`;
        for (const [id, hook] of [[passed, chunks % 2 === 1], [ahead, chunks % 2 === 0]]) {
          injected += 1;
          await insertPurchases(WalletPurchase, [purchaseDoc(id, { amount: 10_000 + injected, completedAt: new Date() })]);
          if (hook) { await spend.recomputeUserSpend(id); hooked.push(id); }
          else if (id === passed) lagging.push(id);
        }
      },
    });
    assert.equal(summary.completed, true);
    assert.equal(lagging.length, 3);

    const strict = await maintenance.runUserSpendVerify({ settleMs: 0, graceMs: 0, writeMarker: false, chunkSize: 500 });
    assert.equal(strict.over, 0, "never above the truth at any point");
    assert.equal(strict.missing, 0);
    assert.equal(strict.under, 3, "only the already-passed users whose hook was lost lag; users reached later were read fresh");
    for (const id of hooked) assert.deepEqual(await counters(User, id), await truthOf(id), `hooked user ${id} is exact`);
    const lenient = await maintenance.runUserSpendVerify({ settleMs: 0, graceMs: 3_600_000, writeMarker: false, chunkSize: 500 });
    assert.equal(lenient.ok, true, "recent completions explain a lagging counter");
    assert.equal(lenient.inFlight, 3);

    await tick(Date.now(), { skipReconcile: true });                          // the sweeper closes the gap
    assert.equal(await allCountersExact(), 1_200);
    assert.equal((await maintenance.runUserSpendVerify({ settleMs: 0, graceMs: 0, writeMarker: false })).ok, true);
  });

  skip("backfill refuses to run twice at once", async () => {
    await seedBackfillWorld(300);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = maintenance.runUserSpendBackfill({ chunkSize: 100, onChunk: () => gate });
    await sleep(100);
    await assert.rejects(() => maintenance.runUserSpendBackfill({ chunkSize: 100 }), { code: "BACKFILL_ALREADY_RUNNING" });
    release();
    assert.equal((await first).completed, true);
  });

  skip("backfill dry-run counts what would change and writes nothing", async () => {
    await seedBackfillWorld(500);
    const dry = await maintenance.runUserSpendBackfill({ chunkSize: 200, dryRun: true });
    assert.equal(dry.completed, true);
    assert.equal(dry.wouldRaise, 500, "every user lacks counters");
    assert.equal(await User.countDocuments({ totalSpent: { $exists: true } }), 0);
    assert.equal(await JobCheckpoint.countDocuments({}), 1, "only the lease document exists; no progress was recorded");
  });

  // ── Verify ───────────────────────────────────────────────────────────────────────────────────────────────
  skip("verify: ok only when there are no missing counters, no over-counts and no unexplained under-counts", async () => {
    await seedBackfillWorld(400);
    await maintenance.runUserSpendBackfill({ chunkSize: 200 });
    const clean = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.equal(clean.ok, true);
    assert.equal(clean.users, 400);
    assert.equal((await lease.readCheckpoint(JobCheckpoint, spend.SPEND_VERIFY_JOB)).state.ok, true, "the marker is written");

    await User.collection.updateOne({ telegramId: "f3" }, { $unset: { totalSpent: "" } });
    const missing = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.deepEqual([missing.ok, missing.missing], [false, 1]);
    assert.equal((await lease.readCheckpoint(JobCheckpoint, spend.SPEND_VERIFY_JOB)).state.ok, false, "a failed verification clears readiness");
    await spend.recomputeUserSpend("f3");

    await User.collection.updateOne({ telegramId: "f7" }, { $inc: { totalSpent: 1 } });
    const over = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.deepEqual([over.ok, over.over], [false, 1]);
    assert.equal(over.samples[0].verdict, "over");
    assert.equal((await counters(User, "f7")).totalSpent, (await WalletPurchase.collection.find({ telegramId: "f7", status: "completed" }).toArray()).reduce((s, r) => s + r.amount, 0) + 1, "verify never writes counters");
    await User.collection.updateOne({ telegramId: "f7" }, { $inc: { totalSpent: -1 } });

    await User.collection.updateOne({ telegramId: "f14" }, { $set: { totalSpent: 0, completedOrderCount: 0 } });  // old completion, stale counters
    const unexplained = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.deepEqual([unexplained.ok, unexplained.under, unexplained.unexplainedUnder, unexplained.inFlight], [false, 1, 1, 0]);

    // A fresh completion must NOT excuse that old gap (it used to): the gap is far larger than the recent purchase.
    // Legitimate lag and the full masking matrix are in tests/integration/userSpendVerify.test.js.
    await insertPurchases(WalletPurchase, [purchaseDoc("f14", { amount: 1, completedAt: new Date() })]);
    const stillUnexplained = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.deepEqual([stillUnexplained.ok, stillUnexplained.inFlight, stillUnexplained.unexplainedUnder], [false, 0, 1]);
  });

  skip("verify re-reads discrepancies after the settle delay, so a completion whose hook is still running is not reported", async () => {
    await seedBackfillWorld(100);
    await maintenance.runUserSpendBackfill({ chunkSize: 100 });
    await insertPurchases(WalletPurchase, [purchaseDoc("f2", { amount: 4_000, completedAt: at(T0 - 7 * 86_400_000) })]);   // lagging, old stamp
    setTimeout(() => { void spend.recomputeUserSpend("f2"); }, 40);                                                      // its hook lands during the settle wait
    const report = await maintenance.runUserSpendVerify({ settleMs: 400 });
    assert.deepEqual([report.ok, report.under, report.unexplainedUnder], [true, 0, 0]);
  });
});
