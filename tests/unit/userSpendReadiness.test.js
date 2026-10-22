/**
 * The gate for USER_SPEND_SORT=persisted. Every condition is exercised on its own, at its boundary, against a
 * stub checkpoint store (the gate only reads two checkpoint documents), including the readiness cache.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKPOINT_CLOCK_TOLERANCE_MS, PASS_MAX_AGE_FACTOR, PASS_MAX_AGE_FLOOR_MS, READINESS_CACHE_MS, SPEND_SWEEPER_JOB, SPEND_VERIFY_JOB, SWEEPER_MAX_AGE_MS,
  evaluatePersistedSpendReadiness, invalidatePersistedSpendSortCache, persistedSpendSortRequested, persistedSpendSortStatus,
} from "../../services/users/userSpend.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms) => new Date(ms);
const ENV = { USER_SPEND_SORT: "persisted" };

const healthy = () => ({
  verify: { state: { ok: true, verifiedAt: at(NOW - HOUR), users: 30_000, missing: 0, over: 0, under: 0, inFlight: 0, unexplainedUnder: 0 } },
  sweeper: {
    state: {
      lastSuccessAt: at(NOW - MIN), consecutiveFailures: 0, scanConsecutiveFailures: 0, reconcileConsecutiveFailures: 0,
      lastPass: { startedAt: at(NOW - 2 * HOUR), finishedAt: at(NOW - HOUR), users: 30_000, ok: 30_000, missing: 0, under: 0, over: 0, repaired: 0 },
    },
  },
});

function storeFor(docs, { fail = false } = {}) {
  const reads = { count: 0 };
  return {
    reads,
    collection: {
      async findOne({ name }) {
        reads.count += 1;
        if (fail) throw new Error("checkpoint store unavailable");
        return (name === SPEND_VERIFY_JOB ? docs.verify : name === SPEND_SWEEPER_JOB ? docs.sweeper : null) ?? null;
      },
    },
  };
}
const status = (docs, extra = {}) => persistedSpendSortStatus({ env: ENV, checkpointModel: storeFor(docs, extra), now: NOW, cacheMs: 0, ...extra });
const reasonOf = async (mutate) => { const docs = healthy(); mutate(docs); const result = await status(docs); return result.ready ? "READY" : result.reason; };

describe("persisted spend readiness: the requirements", () => {
  beforeEach(() => invalidatePersistedSpendSortCache());

  test("a verified, recently and fully healthy sweeper with a clean recent pass is ready", async () => {
    assert.deepEqual(await status(healthy()), { ready: true, reason: "verified" });
  });

  test("it is never ready unless USER_SPEND_SORT is exactly 'persisted' (and then it does not even read the checkpoints)", async () => {
    const store = storeFor(healthy());
    for (const value of [undefined, "", "aggregate", "true", "on"]) {
      assert.deepEqual(await persistedSpendSortStatus({ env: { USER_SPEND_SORT: value }, checkpointModel: store, now: NOW, cacheMs: 0 }), { ready: false, reason: "not_requested" });
    }
    assert.equal(store.reads.count, 0);
    assert.equal(persistedSpendSortRequested({ USER_SPEND_SORT: " Persisted " }), true, "case and surrounding spaces are ignored");
  });

  test("a missing, failed or inconsistent verification marker is not ready", async () => {
    assert.equal(await reasonOf((d) => { delete d.verify; }), "not_verified");
    assert.equal(await reasonOf((d) => { d.verify.state.ok = false; }), "not_verified");
    assert.equal(await reasonOf((d) => { d.verify.state.verifiedAt = "yesterday"; }), "not_verified");
    assert.equal(await reasonOf((d) => { d.verify.state = {}; }), "not_verified");
    for (const key of ["missing", "over", "unexplainedUnder"]) assert.equal(await reasonOf((d) => { d.verify.state[key] = 1; }), "verification_inconsistent", key);
  });

  test("missing checkpoint data is not ready", async () => {
    assert.equal(await reasonOf((d) => { delete d.sweeper; }), "sweeper_not_running");
    assert.equal(await reasonOf((d) => { d.sweeper = {}; }), "sweeper_not_running");
    assert.equal(await reasonOf((d) => { d.sweeper.state = {}; }), "sweeper_not_running");
    assert.equal(await reasonOf((d) => { delete d.sweeper.state.lastSuccessAt; }), "sweeper_not_running", "it never completed a healthy tick");
    assert.equal(await reasonOf((d) => { delete d.sweeper.state.lastPass; }), "no_completed_pass");
    assert.equal(await reasonOf((d) => { delete d.sweeper.state.lastPass; d.sweeper.state.pass = { startedAt: at(NOW), users: 500, missing: 0, under: 0, over: 0 }; }), "no_completed_pass", "a pass still in progress is not a completed pass");
  });

  test("a stale last success is not ready, exactly at the 15 minute boundary", async () => {
    assert.equal(SWEEPER_MAX_AGE_MS, 15 * MIN);
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = at(NOW - SWEEPER_MAX_AGE_MS); }), "READY");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = at(NOW - SWEEPER_MAX_AGE_MS - 1); }), "sweeper_stale");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = at(NOW - 3 * HOUR); }), "sweeper_stale");
  });

  test("any outstanding failure (overall, scan phase or reconcile phase) is not ready", async () => {
    for (const key of ["consecutiveFailures", "scanConsecutiveFailures", "reconcileConsecutiveFailures"]) {
      assert.equal(await reasonOf((d) => { d.sweeper.state[key] = 1; }), "sweeper_failing", key);
      assert.equal(await reasonOf((d) => { d.sweeper.state[key] = 7; }), "sweeper_failing", `${key} x7`);
    }
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastError = "Error"; d.sweeper.state.consecutiveFailures = 2; }), "sweeper_failing");
  });

  test("a stale last completed pass is not ready: floor of 6 hours, scaled to 3x a long pass", async () => {
    assert.equal(PASS_MAX_AGE_FLOOR_MS, 6 * HOUR);
    assert.equal(PASS_MAX_AGE_FACTOR, 3);
    const pass = (durationMs, ageMs) => (d) => { d.sweeper.state.lastPass.startedAt = at(NOW - ageMs - durationMs); d.sweeper.state.lastPass.finishedAt = at(NOW - ageMs); };
    assert.equal(await reasonOf(pass(HOUR, 6 * HOUR)), "READY");
    assert.equal(await reasonOf(pass(HOUR, 6 * HOUR + 1)), "pass_stale");
    assert.equal(await reasonOf(pass(10 * HOUR, 29 * HOUR)), "READY", "a 10 hour pass may be 30 hours old");
    assert.equal(await reasonOf(pass(10 * HOUR, 30 * HOUR + 1)), "pass_stale");
  });

  test("under-counts, over-counts and missing counters in the last completed pass or the pass in progress are not ready", async () => {
    for (const key of ["under", "over", "missing"]) {
      assert.equal(await reasonOf((d) => { d.sweeper.state.lastPass[key] = 1; }), "sweeper_found_discrepancies", `lastPass.${key}`);
      assert.equal(await reasonOf((d) => { d.sweeper.state.pass = { startedAt: at(NOW - MIN), users: 1_000, missing: 0, under: 0, over: 0, [key]: 2 }; }), "sweeper_found_discrepancies", `pass.${key}`);
    }
    assert.equal(await reasonOf((d) => { d.sweeper.state.pass = { startedAt: at(NOW - MIN), users: 1_000, missing: 0, under: 0, over: 0 }; }), "READY", "a clean pass in progress does not block");
  });

  test("malformed or inconsistent checkpoint data is not ready", async () => {
    assert.equal(CHECKPOINT_CLOCK_TOLERANCE_MS, 5 * MIN);
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = at(NOW + 4 * MIN); }), "READY", "small clock skew is tolerated");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = at(NOW + 6 * MIN); }), "checkpoint_inconsistent");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = NOW - MIN; }), "sweeper_not_running", "a number is not a date");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = "2026-06-01T11:59:00Z"; }), "sweeper_not_running", "a string is not a date");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastSuccessAt = new Date("nope"); }), "sweeper_not_running");
    for (const bad of [-1, "x", null, NaN]) assert.equal(await reasonOf((d) => { d.sweeper.state.consecutiveFailures = bad; }), "checkpoint_inconsistent", String(bad));
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastPass.finishedAt = at(NOW - 3 * HOUR); }), "checkpoint_inconsistent", "finished before it started");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastPass.finishedAt = at(NOW + HOUR); }), "checkpoint_inconsistent", "finished in the future");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastPass.startedAt = "earlier"; }), "checkpoint_inconsistent");
    assert.equal(await reasonOf((d) => { delete d.sweeper.state.lastPass.under; }), "checkpoint_inconsistent");
    assert.equal(await reasonOf((d) => { d.sweeper.state.lastPass.over = "0"; }), "checkpoint_inconsistent");
    assert.equal(await reasonOf((d) => { d.sweeper.state.pass = { users: 5 }; }), "checkpoint_inconsistent", "an unreadable in-progress pass cannot be assumed clean");
  });

  test("an unreadable checkpoint store is not ready", async () => {
    assert.deepEqual(await status(healthy(), { fail: true }), { ready: false, reason: "readiness_unavailable" });
  });

  test("recovery: ready again only after the sweeper succeeds and a clean pass has completed", async () => {
    const docs = healthy();
    docs.sweeper.state.lastPass.under = 2;                                                      // a pass found under-counts
    assert.equal((await status(docs)).reason, "sweeper_found_discrepancies");
    docs.sweeper.state.consecutiveFailures = 1;                                                 // and then a tick failed
    assert.equal((await status(docs)).reason, "sweeper_failing");
    docs.sweeper.state.consecutiveFailures = 0;                                                 // the sweeper recovered...
    docs.sweeper.state.lastSuccessAt = at(NOW);
    assert.equal((await status(docs)).reason, "sweeper_found_discrepancies", "...but the pass that found problems is still the latest");
    docs.sweeper.state.pass = { startedAt: at(NOW - MIN), users: 1_000, missing: 0, under: 0, over: 0 };
    assert.equal((await status(docs)).reason, "sweeper_found_discrepancies", "a clean pass in progress is not yet a completed clean pass");
    docs.sweeper.state.lastPass = { startedAt: at(NOW - 2 * HOUR), finishedAt: at(NOW), users: 30_000, ok: 30_000, missing: 0, under: 0, over: 0, repaired: 0 };
    delete docs.sweeper.state.pass;
    assert.deepEqual(await status(docs), { ready: true, reason: "verified" });
  });

  test("the pure evaluator reports when a ready answer stops being fresh", () => {
    const { value, validUntil } = evaluatePersistedSpendReadiness(healthy().verify, healthy().sweeper, NOW);
    assert.equal(value.ready, true);
    assert.equal(validUntil, Math.min(NOW - MIN + SWEEPER_MAX_AGE_MS, NOW - HOUR + 6 * HOUR));
  });
});

describe("persisted spend readiness: the cache cannot keep the persisted ranking on", () => {
  beforeEach(() => invalidatePersistedSpendSortCache());
  const call = (store, now, extra = {}) => persistedSpendSortStatus({ env: ENV, checkpointModel: store, now, ...extra });

  test("a ready answer is reused for at most 30 seconds, then a newly recorded failure takes effect", async () => {
    assert.equal(READINESS_CACHE_MS, 30_000);
    const docs = healthy();
    const store = storeFor(docs);
    assert.equal((await call(store, NOW)).ready, true);
    docs.sweeper.state.consecutiveFailures = 1;                                                 // a failure is recorded
    assert.equal((await call(store, NOW + 29_999)).ready, true, "bounded staleness: still the cached answer");
    assert.deepEqual(await call(store, NOW + 30_000), { ready: false, reason: "sweeper_failing" });
  });

  test("the same process drops the cached answer immediately when told about a failure", async () => {
    const docs = healthy();
    const store = storeFor(docs);
    assert.equal((await call(store, NOW)).ready, true);
    docs.sweeper.state.scanConsecutiveFailures = 1;
    invalidatePersistedSpendSortCache();
    assert.deepEqual(await call(store, NOW + 1), { ready: false, reason: "sweeper_failing" });
  });

  test("a cached ready answer expires when the sweeper's last success goes stale, even inside the 30 seconds", async () => {
    const docs = healthy();
    docs.sweeper.state.lastSuccessAt = at(NOW - SWEEPER_MAX_AGE_MS + 6_000);                    // fresh for 6 more seconds
    const store = storeFor(docs);
    assert.equal((await call(store, NOW)).ready, true);
    assert.equal((await call(store, NOW + 5_000)).ready, true);
    assert.deepEqual(await call(store, NOW + 7_000), { ready: false, reason: "sweeper_stale" });
  });

  test("a stopped sweeper therefore disables the persisted ranking within 15 minutes + 30 seconds at the latest", async () => {
    const docs = healthy();
    docs.sweeper.state.lastSuccessAt = at(NOW);
    const store = storeFor(docs);
    assert.equal((await call(store, NOW)).ready, true);
    let firstNotReady = null;
    for (let t = 0; t <= 20 * MIN && firstNotReady === null; t += 10_000) if (!(await call(store, NOW + t)).ready) firstNotReady = t;
    assert.ok(firstNotReady !== null && firstNotReady <= SWEEPER_MAX_AGE_MS + READINESS_CACHE_MS, `disabled after ${firstNotReady} ms`);
  });

  test("not-ready answers are cached too, so a broken store is not hammered, and recovery is picked up after the TTL", async () => {
    const docs = healthy();
    docs.sweeper.state.consecutiveFailures = 3;
    const store = storeFor(docs);
    await call(store, NOW);
    await call(store, NOW + 10_000);
    assert.equal(store.reads.count, 2, "one evaluation (two documents) for both calls");
    docs.sweeper.state.consecutiveFailures = 0;
    assert.equal((await call(store, NOW + 31_000)).ready, true);
  });
});
