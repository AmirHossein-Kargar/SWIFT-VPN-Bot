/**
 * Persisted user spend, core behavior against a REAL MongoDB: the MongoDB lease, the pair-consistent raise
 * rule under concurrency, exact status exclusions, reconcile classification (over-counts reported, never
 * lowered), and the post-completion hook against the real commitProvisionedPurchase. Skips without a database.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import {
  NON_COMPLETED_STATUSES, counters, insertPurchases, insertUsers, purchaseDoc, sleep, truthByScan, userDoc,
} from "../helpers/userSpendFixtures.js";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let User, WalletPurchase, JobCheckpoint, lease, spend, ledger, ensureTelegramUser;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: JobCheckpoint } = await import("../../models/JobCheckpoint.js"));
  lease = await import("../../services/jobLease.js");
  spend = await import("../../services/users/userSpend.js");
  ledger = await import("../../services/buyService/purchaseLedger.js");
  ({ ensureTelegramUser } = await import("../../services/users/ensureTelegramUser.js"));
}

const pair = (S, C) => ({ totalSpent: S, completedOrderCount: C });
const asTruth = (id, S, C) => new Map([[id, pair(S, C)]]);
const withAggregate = (impl) => new Proxy(WalletPurchase, {
  get(target, prop) {
    if (prop === "aggregate") return impl;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

describe("persisted user spend (core)", () => {
  before(async () => { if (dbAvailable) await Promise.all([User.syncIndexes(), WalletPurchase.syncIndexes(), JobCheckpoint.syncIndexes()]); });
  beforeEach(async () => {
    if (!dbAvailable) return;
    delete process.env.USER_SPEND_HOOK;
    await Promise.all([User.deleteMany({}), WalletPurchase.deleteMany({}), JobCheckpoint.deleteMany({})]);
    await spend.flushUserSpendRecomputesForTests();
  });
  after(async () => { delete process.env.USER_SPEND_HOOK; if (dbAvailable) await disconnectTestDB(); });

  // ── MongoDB lease ────────────────────────────────────────────────────────────────────────────────────────
  skip("lease: acquire, renew, release and state writes are owner-checked", async () => {
    const A = await lease.acquireLease(JobCheckpoint, "t-lease", "A", 60_000);
    assert.ok(A);
    assert.equal(await lease.acquireLease(JobCheckpoint, "t-lease", "B", 60_000), null, "a live lease excludes everyone else");
    const notMine = { name: "t-lease", owner: "B", ttlMs: 60_000 };
    assert.equal(await lease.renewLease(JobCheckpoint, notMine), false);
    assert.equal(await lease.releaseLease(JobCheckpoint, notMine), false);
    assert.equal(await lease.writeLeasedState(JobCheckpoint, notMine, { set: { x: 1 } }), false);
    assert.equal(await lease.acquireLease(JobCheckpoint, "t-lease", "B", 60_000), null, "B's release attempt did not free A's lease");

    assert.equal(await lease.writeLeasedState(JobCheckpoint, A, { set: { x: 1, "nested.y": 2 } }), true);
    assert.deepEqual((await lease.readCheckpoint(JobCheckpoint, "t-lease")).state, { x: 1, nested: { y: 2 } });
    assert.equal(await lease.writeLeasedState(JobCheckpoint, A, { unset: ["x"] }), true);
    assert.equal((await lease.readCheckpoint(JobCheckpoint, "t-lease")).state.x, undefined);

    assert.ok(await lease.acquireLease(JobCheckpoint, "t-lease", "A", 60_000), "the owner may re-acquire");
    assert.equal(await lease.renewLease(JobCheckpoint, A), true);
    assert.equal(await lease.releaseLease(JobCheckpoint, A), true);
    assert.ok(await lease.acquireLease(JobCheckpoint, "t-lease", "B", 60_000), "released leases are free");
  });

  skip("lease: after expiry another owner takes over and the old owner is fenced out of every write", async () => {
    const A = await lease.acquireLease(JobCheckpoint, "t-fence", "A", 60_000);
    await lease.writeLeasedState(JobCheckpoint, A, { set: { cursor: "a1" } });
    await JobCheckpoint.collection.updateOne({ name: "t-fence" }, { $set: { leaseUntil: new Date(Date.now() - 1_000) } }); // A paused past its TTL

    assert.equal(await lease.renewLease(JobCheckpoint, A), false, "an expired lease cannot be renewed");
    assert.equal(await lease.writeLeasedState(JobCheckpoint, A, { set: { cursor: "stale" } }), false, "expired and untaken: still fenced");

    const B = await lease.acquireLease(JobCheckpoint, "t-fence", "B", 60_000);
    assert.ok(B);
    assert.equal(await lease.writeLeasedState(JobCheckpoint, A, { set: { cursor: "stale-after-takeover" } }), false);
    assert.equal(await lease.releaseLease(JobCheckpoint, A), false, "the old owner cannot release the new owner's lease");
    assert.equal(await lease.writeLeasedState(JobCheckpoint, B, { set: { cursor: "b1" } }), true);
    assert.equal((await lease.readCheckpoint(JobCheckpoint, "t-fence")).state.cursor, "b1");
    assert.equal((await lease.readCheckpoint(JobCheckpoint, "t-fence")).leaseOwner, "B");
  });

  skip("lease: of 25 simultaneous contenders for a brand-new job exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => lease.acquireLease(JobCheckpoint, "t-race", `owner-${i}`, 60_000)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await JobCheckpoint.countDocuments({ name: "t-race" }), 1);
  });

  // ── The raise rule: pair consistency ────────────────────────────────────────────────────────────────────
  skip("raise: the stored pair is replaced as a unit and is never lowered in either component", async () => {
    await insertUsers(User, [userDoc("r1", pair(0, 0))]);
    const write = async (S, C) => (await spend.recomputeUsersSpend(["r1"], { truth: asTruth("r1", S, C) })).raised;

    assert.equal(await write(500, 1), 1);
    assert.deepEqual(await counters(User, "r1"), pair(500, 1));
    assert.equal(await write(300, 2), 0, "more orders but a smaller sum is not componentwise larger: not written");
    assert.deepEqual(await counters(User, "r1"), pair(500, 1));
    assert.equal(await write(100, 1), 0);
    assert.equal(await write(500, 1), 0, "an identical pair is a no-op");
    assert.equal(await write(800, 3), 1, "a pair that dominates both components is written");
    assert.deepEqual(await counters(User, "r1"), pair(800, 3));
  });

  skip("raise: two independent $max would store a pair no read ever returned; the raise rule never does", async () => {
    await insertUsers(User, [userDoc("m1", pair(0, 0)), userDoc("m2", pair(0, 0))]);
    // read 1 saw {P2} -> (500, 1); read 2 saw {P1, P3} -> (300, 2): the sets are not nested.
    for (const [S, C] of [[500, 1], [300, 2]]) {
      await User.collection.updateOne({ telegramId: "m1" }, { $max: { totalSpent: S, completedOrderCount: C } });
      await spend.recomputeUsersSpend(["m2"], { truth: asTruth("m2", S, C) });
    }
    assert.deepEqual(await counters(User, "m1"), pair(500, 2), "independent $max mixes the two reads");
    assert.deepEqual(await counters(User, "m2"), pair(500, 1), "the raise rule keeps exactly one read's pair");
    await spend.recomputeUsersSpend(["m2"], { truth: asTruth("m2", 800, 3) }); // the full read after the last commit
    assert.deepEqual(await counters(User, "m2"), pair(800, 3));
  });

  skip("raise: missing counters are set (explicit zero included), but an over-count in one field is never lowered to fill the other", async () => {
    await insertUsers(User, [
      userDoc("z1"), // no counters at all
      userDoc("z2", { totalSpent: 9_999_999 }), // one field present and above the truth, the other missing
      userDoc("z3", { totalSpent: "oops", completedOrderCount: null }),
    ]);
    for (const id of ["z1", "z2", "z3"]) await User.collection.updateOne({ telegramId: id }, { $unset: id === "z1" ? { totalSpent: "", completedOrderCount: "" } : id === "z2" ? { completedOrderCount: "" } : {} });
    await spend.recomputeUsersSpend(["z1", "z2", "z3"], { truth: new Map([["z1", pair(0, 0)], ["z2", pair(100, 1)], ["z3", pair(250, 2)]]) });
    assert.deepEqual(await counters(User, "z1"), pair(0, 0), "a zero-purchase user gets explicit zeros");
    assert.deepEqual(await counters(User, "z2"), { totalSpent: 9_999_999, completedOrderCount: undefined }, "untouched: writing would lower the over-count");
    assert.deepEqual(await counters(User, "z3"), pair(250, 2), "non-numeric garbage is replaced");
  });

  // ── Concurrency ──────────────────────────────────────────────────────────────────────────────────────────
  skip("concurrent completions with dropped updates: the stored pair is always a pair some read returned, never decreases, and converges", async () => {
    const id = "c1";
    await insertUsers(User, [userDoc(id, pair(0, 0)), userDoc("c-other", pair(0, 0))]);
    await insertPurchases(WalletPurchase, [purchaseDoc("c-other", { amount: 777 })]);
    const reads = new Set(["0:0"]);
    let next = 0;
    let dropped = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= 200) return;
        await sleep(Math.random() * 3);
        await WalletPurchase.collection.insertOne(purchaseDoc(id, { amount: 1_000 + i }));
        if (Math.random() < 0.25) { dropped += 1; continue; } // a lost hook
        await sleep(Math.random() * 3);
        const truth = await spend.readSpendTruth([id]);
        const read = truth.get(id);
        reads.add(`${read.totalSpent}:${read.completedOrderCount}`);
        await spend.recomputeUsersSpend([id], { truth });
      }
    };
    const seen = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) { const c = await counters(User, id); seen.push(c); await sleep(1); }
    })();
    await Promise.all(Array.from({ length: 12 }, worker));
    watching = false;
    await watcher;

    assert.ok(dropped > 10, "the scenario really dropped updates");
    for (const c of seen) assert.ok(reads.has(`${c.totalSpent}:${c.completedOrderCount}`), `observed ${c.totalSpent}:${c.completedOrderCount} was never returned by any read`);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i].totalSpent >= seen[i - 1].totalSpent && seen[i].completedOrderCount >= seen[i - 1].completedOrderCount, "never decreases");
    }
    const truth = await truthByScan(WalletPurchase, id);
    const stored = await counters(User, id);
    assert.ok(stored.totalSpent <= truth.totalSpent && stored.completedOrderCount <= truth.completedOrderCount, "never above the truth");

    await spend.recomputeUserSpend(id); // one read after the last commit converges exactly
    assert.deepEqual(await counters(User, id), truth);
    assert.deepEqual(await counters(User, "c-other"), pair(0, 0), "other users are untouched until their own recompute");
  });

  // ── Exact semantics ─────────────────────────────────────────────────────────────────────────────────────
  skip("only completed purchases count: revoked/expired included; every other status, top-ups and balance edits excluded", async () => {
    await insertUsers(User, [userDoc("s1", pair(0, 0)), userDoc("s2", pair(0, 0))]);
    const past = new Date(Date.now() - 90 * 86_400_000);
    await insertPurchases(WalletPurchase, [
      purchaseDoc("s1", { amount: 10_000 }),
      purchaseDoc("s1", { amount: 20_000, revokedAt: new Date(), revokedBy: "999" }),
      purchaseDoc("s1", { amount: 30_000, expiresAt: past }),
      ...NON_COMPLETED_STATUSES.map((status) => purchaseDoc("s1", { status, amount: 7_777, completedAt: null })),
      purchaseDoc("s2", { amount: 55_000 }),
    ]);
    await User.collection.updateOne({ telegramId: "s1" }, { $inc: { balance: 9_999_999, successfulPayments: 4 } });
    await WalletPurchase.db.collection("hooshpayinvoices").insertOne({ uid: "paid-1", userId: 1, amount: 5_000_000, status: "paid", balanceCredited: true });

    await spend.recomputeUsersSpend(["s1", "s2"]);
    assert.deepEqual(await counters(User, "s1"), pair(60_000, 3));
    assert.deepEqual(await counters(User, "s2"), pair(55_000, 1));
  });

  skip("new users start at an explicit 0/0", async () => {
    await ensureTelegramUser({ id: 990001, first_name: "New" });
    const raw = await User.collection.findOne({ telegramId: "990001" });
    assert.equal(raw.totalSpent, 0);
    assert.equal(raw.completedOrderCount, 0);
  });

  // ── Reconcile ───────────────────────────────────────────────────────────────────────────────────────────
  skip("reconcile: repairs under-counts and missing counters, reports over-counts and never lowers them", async () => {
    await insertUsers(User, [
      userDoc("k-ok", pair(25_000, 1)),
      userDoc("k-under", pair(0, 0)),
      userDoc("k-missing"),
      userDoc("k-over", pair(900_000, 9)),
      userDoc("k-zero", pair(0, 0)),
    ]);
    await User.collection.updateOne({ telegramId: "k-missing" }, { $unset: { totalSpent: "", completedOrderCount: "" } });
    await insertPurchases(WalletPurchase, ["k-ok", "k-under", "k-missing", "k-over"].map((id) => purchaseDoc(id, { amount: 25_000 })));

    const users = await User.find({}).lean();
    const first = await spend.reconcileUserSpend(users);
    assert.deepEqual({ checked: first.checked, ok: first.ok, missing: first.missing, under: first.under, over: first.over, repaired: first.repaired }, { checked: 5, ok: 2, missing: 1, under: 1, over: 1, repaired: 2 });
    assert.equal(first.overSamples.length, 1);
    assert.deepEqual(first.overSamples[0], { telegramId: "k-over", stored: pair(900_000, 9), truth: pair(25_000, 1) });
    assert.deepEqual(await counters(User, "k-under"), pair(25_000, 1));
    assert.deepEqual(await counters(User, "k-missing"), pair(25_000, 1));
    assert.deepEqual(await counters(User, "k-over"), pair(900_000, 9), "an over-count is reported, never lowered");

    const second = await spend.reconcileUserSpend(await User.find({}).lean());
    assert.deepEqual({ ok: second.ok, over: second.over, repaired: second.repaired }, { ok: 4, over: 1, repaired: 0 }, "idempotent; the over-count stays visible");
  });

  // ── The hook against the real commit ────────────────────────────────────────────────────────────────────
  let serial = 0;
  async function seedProvisioned(telegramId, amount) {
    serial += 1;
    await User.collection.updateOne({ telegramId: String(telegramId) }, { $setOnInsert: userDoc(telegramId, pair(0, 0)) }, { upsert: true });
    const doc = purchaseDoc(telegramId, {
      status: "provisioned", walletDebitStatus: "reserved", completedAt: null, amount, serviceUsername: `svc_${telegramId}_${serial}`,
      serviceLink: "https://example.invalid/sub/x", provisionedAt: new Date(),
    });
    await WalletPurchase.collection.insertOne(doc);
    return doc;
  }
  const commit = (doc, purchaseModel = WalletPurchase) => ledger.commitProvisionedPurchase(doc, undefined, { userModel: User, purchaseModel });

  skip("hook: a commit updates the counters once, and duplicate or concurrent commits never double count", async () => {
    const doc = await seedProvisioned("h1", 40_000);
    const first = await commit(doc);
    assert.equal(first.purchase.status, "completed");
    await spend.flushUserSpendRecomputesForTests();
    assert.deepEqual(await counters(User, "h1"), pair(40_000, 1));

    const replay = await commit(doc); // already completed: the idempotent branch
    assert.equal(replay.purchase.status, "completed");
    await spend.flushUserSpendRecomputesForTests();
    assert.deepEqual(await counters(User, "h1"), pair(40_000, 1));

    const racing = await seedProvisioned("h1", 15_000);
    await Promise.all([commit(racing), commit(racing), commit(racing), commit(racing)]);
    await spend.flushUserSpendRecomputesForTests();
    assert.deepEqual(await counters(User, "h1"), pair(55_000, 2));
    assert.equal((await User.findOne({ telegramId: "h1" }).lean()).services.length, 2, "services are untouched by the hook");
    assert.deepEqual(await counters(User, "h1"), await truthByScan(WalletPurchase, "h1"));
  });

  skip("hook: a failing recompute never changes the commit result; the counters just lag until repaired", async () => {
    const failing = withAggregate(() => { throw new Error("simulated aggregation failure"); });
    const doc = await seedProvisioned("h2", 33_000);
    const result = await commit(doc, failing);
    assert.equal(result.purchase.status, "completed");
    assert.equal((await WalletPurchase.findOne({ purchaseId: doc.purchaseId }).lean()).status, "completed");
    assert.equal((await User.findOne({ telegramId: "h2" }).lean()).services.length, 1);
    const failedBefore = spend.getUserSpendHookStats().failed;
    await spend.flushUserSpendRecomputesForTests();
    assert.ok(spend.getUserSpendHookStats().failed >= failedBefore);
    assert.deepEqual(await counters(User, "h2"), pair(0, 0), "stale, not wrong");
    await spend.recomputeUserSpend("h2");
    assert.deepEqual(await counters(User, "h2"), pair(33_000, 1));
  });

  skip("hook: the commit returns without waiting for a slow recompute", async () => {
    let finished = false;
    const slow = withAggregate((...args) => {
      const query = WalletPurchase.aggregate(...args);
      return { option: async (opts) => { await sleep(300); const rows = await query.option(opts); finished = true; return rows; } };
    });
    const doc = await seedProvisioned("h3", 12_000);
    await commit(doc, slow);
    assert.equal(finished, false, "the commit did not wait for the recompute");
    await spend.flushUserSpendRecomputesForTests();
    assert.equal(finished, true);
    assert.deepEqual(await counters(User, "h3"), pair(12_000, 1));
  });

  skip("hook: USER_SPEND_HOOK=off leaves the counters to the sweeper", async () => {
    process.env.USER_SPEND_HOOK = "off";
    const doc = await seedProvisioned("h4", 9_000);
    const result = await commit(doc);
    await spend.flushUserSpendRecomputesForTests();
    assert.equal(result.purchase.status, "completed");
    assert.deepEqual(await counters(User, "h4"), pair(0, 0));
  });
});
