/**
 * Pure/unit behavior of the persisted user spend counters: flags, classification, the raise rule's shape,
 * and the best-effort hook (never throws, never blocks, never rejects), using stub models only.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifySpend, flushUserSpendRecomputesForTests, getUserSpendHookStats, persistedSpendSortRequested, raiseFilter,
  scheduleUserSpendRecompute, userSpendHookEnabled, userSpendSweeperEnabled,
} from "../../services/users/userSpend.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("feature flags", () => {
  test("USER_SPEND_SORT keeps the aggregate unless it is exactly 'persisted'", () => {
    for (const value of [undefined, "", "aggregate", "on", "true", "1", "persist", "persisted-ish"]) {
      assert.equal(persistedSpendSortRequested({ USER_SPEND_SORT: value }), false, String(value));
    }
    assert.equal(persistedSpendSortRequested({ USER_SPEND_SORT: "persisted" }), true);
    assert.equal(persistedSpendSortRequested({ USER_SPEND_SORT: " Persisted " }), true);
    assert.equal(persistedSpendSortRequested({}), false);
  });

  test("USER_SPEND_HOOK and USER_SPEND_SWEEPER are on by default and off only for explicit off values", () => {
    for (const check of [userSpendHookEnabled, userSpendSweeperEnabled]) {
      const name = check === userSpendHookEnabled ? "USER_SPEND_HOOK" : "USER_SPEND_SWEEPER";
      assert.equal(check({}), true);
      assert.equal(check({ [name]: "on" }), true);
      for (const off of ["off", "OFF", "false", "0", "disabled", "no"]) assert.equal(check({ [name]: off }), false, off);
    }
  });
});

describe("classifySpend", () => {
  const truth = { totalSpent: 500, completedOrderCount: 2 };
  test("ok / under / missing / over", () => {
    assert.equal(classifySpend({ totalSpent: 500, completedOrderCount: 2 }, truth), "ok");
    assert.equal(classifySpend({ totalSpent: 100, completedOrderCount: 1 }, truth), "under");
    assert.equal(classifySpend({ totalSpent: 500, completedOrderCount: 1 }, truth), "under");
    assert.equal(classifySpend({ totalSpent: 0, completedOrderCount: 0 }, { totalSpent: 0, completedOrderCount: 0 }), "ok");
    for (const stored of [undefined, {}, { totalSpent: 5 }, { completedOrderCount: 1 }, { totalSpent: null, completedOrderCount: null }, { totalSpent: "5", completedOrderCount: "1" }, { totalSpent: NaN, completedOrderCount: 1 }]) {
      assert.equal(classifySpend(stored, truth), "missing", JSON.stringify(stored));
    }
    assert.equal(classifySpend({ totalSpent: 501, completedOrderCount: 2 }, truth), "over");
    assert.equal(classifySpend({ totalSpent: 500, completedOrderCount: 3 }, truth), "over");
  });

  test("a component above the truth is an over-count even when the other is below it or absent", () => {
    assert.equal(classifySpend({ totalSpent: 900, completedOrderCount: 1 }, truth), "over");
    assert.equal(classifySpend({ totalSpent: 900 }, truth), "over");
    assert.equal(classifySpend({ completedOrderCount: 9 }, truth), "over");
  });
});

describe("raiseFilter", () => {
  test("is scoped to one user and can only match when no stored component would be lowered", () => {
    const filter = raiseFilter(77, { totalSpent: 300, completedOrderCount: 2 });
    assert.equal(filter.telegramId, "77");
    const text = JSON.stringify(filter);
    assert.match(text, /"\$lte":300/);
    assert.match(text, /"\$lte":2/);
    assert.match(text, /"\$lt":300/);
    assert.doesNotMatch(text, /"\$gt"/);
  });
});

describe("best-effort recompute hook", () => {
  beforeEach(async () => { await flushUserSpendRecomputesForTests(); });

  const stubs = ({ aggregate, bulkWrite } = {}) => {
    const calls = { aggregate: 0, bulkWrite: 0 };
    return {
      calls,
      purchaseModel: {
        aggregate() {
          calls.aggregate += 1;
          const promise = Promise.resolve(aggregate ? aggregate() : [{ _id: "77", totalSpent: 500, completedOrderCount: 2 }]);
          return { option: () => promise };
        },
      },
      userModel: { collection: { async bulkWrite(ops) { calls.bulkWrite += 1; if (bulkWrite) await bulkWrite(ops); return { modifiedCount: ops.length }; } } },
    };
  };

  test("returns immediately without running anything synchronously, then recomputes", async () => {
    const { calls, purchaseModel, userModel } = stubs();
    const result = scheduleUserSpendRecompute("77", { userModel, purchaseModel });
    assert.equal(result, undefined);
    assert.equal(calls.aggregate, 0, "nothing ran on the caller's stack");
    await flushUserSpendRecomputesForTests();
    assert.equal(calls.aggregate, 1);
    assert.equal(calls.bulkWrite, 1);
  });

  test("never throws or rejects, whatever the inputs or the failure", async () => {
    const failing = stubs({ aggregate: () => { throw new Error("db down"); } });
    for (const id of [undefined, null, "", 0, "77", { toString() { throw new Error("bad id"); } }]) {
      assert.doesNotThrow(() => scheduleUserSpendRecompute(id, failing));
    }
    assert.doesNotThrow(() => scheduleUserSpendRecompute("77", { userModel: null, purchaseModel: null }));
    assert.doesNotThrow(() => scheduleUserSpendRecompute("77", undefined));
    const before = getUserSpendHookStats().failed;
    await flushUserSpendRecomputesForTests();
    assert.ok(getUserSpendHookStats().failed > before, "the failure was counted, not thrown");
  });

  test("a failing or hanging recompute never leaks an unhandled rejection and frees its slot", async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
      const hanging = stubs({ aggregate: () => new Promise(() => {}) });
      scheduleUserSpendRecompute("88", { ...hanging, timeoutMs: 40 });
      await flushUserSpendRecomputesForTests();
      await sleep(20);
      assert.equal(getUserSpendHookStats().inFlight, 0);
      assert.equal(unhandled, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("models that cannot aggregate (test doubles) are skipped silently", async () => {
    const before = getUserSpendHookStats().skipped;
    scheduleUserSpendRecompute("77", { userModel: { findOneAndUpdate() {} }, purchaseModel: { findOneAndUpdate() {} } });
    assert.equal(getUserSpendHookStats().skipped, before + 1);
    assert.equal(getUserSpendHookStats().inFlight, 0);
  });

  test("USER_SPEND_HOOK=off schedules nothing", async () => {
    const { calls, purchaseModel, userModel } = stubs();
    scheduleUserSpendRecompute("77", { userModel, purchaseModel, env: { USER_SPEND_HOOK: "off" } });
    await flushUserSpendRecomputesForTests();
    assert.equal(calls.aggregate, 0);
  });

  test("a completion that arrives while a read is running triggers one more read (nothing is lost to coalescing)", async () => {
    let releaseFirst;
    let reads = 0;
    const { calls, purchaseModel, userModel } = stubs({
      aggregate: () => { reads += 1; return reads === 1 ? new Promise((resolve) => { releaseFirst = () => resolve([]); }) : []; },
    });
    scheduleUserSpendRecompute("77", { userModel, purchaseModel });
    await sleep(15);                       // the first read is now in flight
    scheduleUserSpendRecompute("77", { userModel, purchaseModel });
    scheduleUserSpendRecompute("77", { userModel, purchaseModel });
    assert.equal(calls.aggregate, 1, "duplicates did not start parallel reads");
    releaseFirst();
    await flushUserSpendRecomputesForTests();
    assert.equal(calls.aggregate, 2, "exactly one follow-up read covers the completions that arrived meanwhile");
  });
});
