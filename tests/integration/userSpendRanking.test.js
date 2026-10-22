/**
 * The admin "top spending" list: the persisted ranking must equal the aggregate ranking for every filter, search,
 * page and tie (equal spend, zero spend, equal createdAt, missing createdAt); it must be served by
 * idx_user_spend_rank without a blocking sort; and it must stay OFF unless requested AND verified. Real MongoDB.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { insertPurchases, insertUsers, purchaseDoc, userDoc } from "../helpers/userSpendFixtures.js";

process.env.ADMINS = "424242";
const ADMIN = "424242";
const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let User, WalletPurchase, JobCheckpoint, users, spend, sweeper, maintenance, lease;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: JobCheckpoint } = await import("../../models/JobCheckpoint.js"));
  users = await import("../../services/admin/users.js");
  spend = await import("../../services/users/userSpend.js");
  sweeper = await import("../../services/users/userSpendSweeper.js");
  maintenance = await import("../../services/users/userSpendMaintenance.js");
  lease = await import("../../services/jobLease.js");
}

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 3, 1);
const N = 700;
let lcg = 12345;
const rnd = () => { lcg = (lcg * 1664525 + 1013904223) % 4294967296; return lcg / 4294967296; };

async function seedWorld() {
  const docs = [];
  const purchases = [];
  for (let i = 0; i < N; i += 1) {
    const id = String(5_000_000 + i);
    docs.push(userDoc(id, {
      username: `user${i}`, firstName: i % 3 === 0 ? `Ali${i}` : `Sara${i}`,
      createdAt: new Date(BASE + (i % 15) * DAY),                      // 15 distinct values: heavy createdAt ties
      lastActivityAt: i % 11 === 0 ? null : new Date(Date.now() - Math.floor(rnd() * 90) * DAY),
      isBanned: i % 17 === 0, successfulPayments: i % 4,
    }));
    if (rnd() < 0.55) {                                                // ~45% of users never bought: a big zero-spend tie group
      for (let k = 0; k < 1 + Math.floor(rnd() * 3); k += 1) {
        purchases.push(purchaseDoc(id, { amount: [50_000, 90_000, 150_000][Math.floor(rnd() * 3)], completedAt: new Date(BASE + 20 * DAY) }));
      }
    }
    purchases.push(purchaseDoc(id, { status: i % 2 ? "refunded" : "failed", amount: 999_999, completedAt: null }));
  }
  for (const doc of docs.slice(0, 6)) delete doc.createdAt;           // no createdAt at all
  await insertUsers(User, docs);
  await insertPurchases(WalletPurchase, purchases);
}

const filters = [
  {}, { search: "5000007" }, { search: "user1" }, { search: "ali2" }, { search: "@sara" }, { search: "nobody-matches" },
  { activity: "active" }, { activity: "inactive" }, { paying: "yes" }, { paying: "no" }, { blocked: "yes" }, { blocked: "no" },
  { paying: "yes", blocked: "no", activity: "active" }, { paying: "no", blocked: "no" }, { search: "user", blocked: "no" },
];

const listAll = async (query, flag, { pageSize = 25, maxPages = 60 } = {}) => {
  process.env.USER_SPEND_SORT = flag;
  spend.resetPersistedSpendSortCacheForTests();
  const pages = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await users.listUsers({ actorId: ADMIN, query: { ...query, sort: "spending", page, pageSize } });
    pages.push(result);
    if (!result.items.length || page >= result.pages) break;
  }
  return pages;
};

describe("user spend ranking", () => {
  before(async () => {
    if (!dbAvailable) return;
    await Promise.all([User.syncIndexes(), WalletPurchase.syncIndexes(), JobCheckpoint.syncIndexes()]);
    await seedWorld();
    await maintenance.runUserSpendBackfill({ chunkSize: 300 });
    const report = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.equal(report.ok, true, "the seeded world verifies clean");
    // The gate also needs a healthy sweeper: one full tick completes a reconcile pass (700 users < one batch of 1000).
    const swept = await sweeper.runUserSpendSweepTick({});
    assert.equal(swept.error, null);
    assert.ok((await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB)).state.lastPass, "a reconcile pass completed");
  });
  beforeEach(() => { delete process.env.USER_SPEND_SORT; spend?.resetPersistedSpendSortCacheForTests(); });
  after(async () => { delete process.env.USER_SPEND_SORT; if (dbAvailable) await disconnectTestDB(); });

  skip("persisted and aggregate rankings are identical for every filter, search, page and tie", async () => {
    let comparedPages = 0;
    // every filter over the WHOLE list (pageSize 100), and small pages (whose boundaries cut through tie groups) for a few
    const runs = [...filters.map((query) => [query, 100, 60]), ...[{}, { blocked: "no" }, { search: "user1" }].map((query) => [query, 7, 10])];
    for (const [query, pageSize, maxPages] of runs) {
      const aggregate = await listAll(query, "aggregate", { pageSize, maxPages });
      const persisted = await listAll(query, "persisted", { pageSize, maxPages });
      assert.deepEqual(persisted, aggregate, `${JSON.stringify(query)} pageSize ${pageSize}`);
      comparedPages += aggregate.length;
    }
    assert.ok(comparedPages > 50, `compared ${comparedPages} pages`);
    // a page far beyond the end, and the very large page numbers the API clamps to
    for (const page of [9_999, 1_000_000]) {
      process.env.USER_SPEND_SORT = "aggregate";
      const aggregate = await users.listUsers({ actorId: ADMIN, query: { sort: "spending", page, pageSize: 25 } });
      process.env.USER_SPEND_SORT = "persisted"; spend.resetPersistedSpendSortCacheForTests();
      const persisted = await users.listUsers({ actorId: ADMIN, query: { sort: "spending", page, pageSize: 25 } });
      assert.deepEqual(persisted, aggregate);
    }
  });

  skip("equal-spend users keep the aggregate's tie-break: createdAt descending, then _id ascending, missing createdAt last", async () => {
    const rows = (await listAll({}, "persisted", { pageSize: 100 })).flatMap((page) => page.items);
    assert.equal(rows.length, N);
    const stored = new Map((await User.collection.find({}).toArray()).map((u) => [u.telegramId, u]));
    for (let i = 1; i < rows.length; i += 1) {
      const a = stored.get(rows[i - 1].telegramId), b = stored.get(rows[i].telegramId);
      if (a.totalSpent !== b.totalSpent) { assert.ok(a.totalSpent > b.totalSpent); continue; }
      const at = a.createdAt ? +a.createdAt : -Infinity, bt = b.createdAt ? +b.createdAt : -Infinity;
      if (at !== bt) { assert.ok(at > bt, "createdAt descending within equal spend"); continue; }
      assert.ok(String(a._id) < String(b._id), "_id ascending within equal spend and createdAt");
    }
    assert.ok(rows.filter((r) => r.totalSpent === 0).length > 200, "the zero-spend tie group is large");
  });

  // ── Query plans ──────────────────────────────────────────────────────────────────────────────────────────
  const planOf = async (query) => {
    const filter = users.buildUserSearchQuery(query);
    const explained = await User.find(filter).sort({ totalSpent: -1, createdAt: -1, _id: 1 }).skip(0).limit(20).lean().explain("executionStats");
    return { text: JSON.stringify(explained.queryPlanner.winningPlan), stats: explained.executionStats };
  };
  skip("the ranking is served by idx_user_spend_rank with no blocking sort stage", async () => {
    for (const query of [{}, { blocked: "no" }, { paying: "yes" }, { activity: "active" }, { paying: "no", blocked: "no" }]) {
      const { text, stats } = await planOf(query);
      assert.match(text, /"indexName":"idx_user_spend_rank"/, JSON.stringify(query));
      assert.doesNotMatch(text, /"stage":"SORT"/, `${JSON.stringify(query)} must not sort in memory`);
      assert.doesNotMatch(text, /COLLSCAN/);
      assert.ok(stats.totalKeysExamined < 400, `${JSON.stringify(query)} examined ${stats.totalKeysExamined} keys for 20 rows`);
    }
  });

  skip("the sweeper's reads use idx_wallet_purchase_completed_at with no collection scan or blocking sort", async () => {
    await insertPurchases(WalletPurchase, Array.from({ length: 3_000 }, (_, i) => purchaseDoc(`plan-${i % 90}`, { completedAt: new Date(BASE + 30 * DAY + i * 1000) })));
    const from = new Date(BASE + 30 * DAY + 2_000_000);
    const first = await WalletPurchase.find({ status: "completed", completedAt: { $gte: from } }).sort({ completedAt: 1, _id: 1 }).limit(500).select("telegramId completedAt").lean().explain("executionStats");
    const cursor = await WalletPurchase.findOne({ status: "completed", completedAt: { $gte: from } }).sort({ completedAt: 1, _id: 1 }).lean();
    const keyset = await WalletPurchase.find({
      status: "completed", completedAt: { $gte: from },
      $or: [{ completedAt: { $gt: cursor.completedAt } }, { completedAt: cursor.completedAt, _id: { $gt: String(cursor._id) } }],
    }).sort({ completedAt: 1, _id: 1 }).limit(500).select("telegramId completedAt").lean().explain("executionStats");
    for (const [label, explained] of [["first page", first], ["keyset page", keyset]]) {
      const text = JSON.stringify(explained.queryPlanner.winningPlan);
      assert.match(text, /"indexName":"idx_wallet_purchase_completed_at"/, label);
      assert.doesNotMatch(text, /COLLSCAN/, label);
      assert.doesNotMatch(text, /"stage":"SORT"/, label);
      assert.ok(explained.executionStats.totalDocsExamined <= 700, `${label}: examined ${explained.executionStats.totalDocsExamined} documents`);
    }
  });

  // ── Gating: persisted only when requested AND verified ────────────────────────────────────────────────────
  const status = (env, extra = {}) => spend.persistedSpendSortStatus({ env, cacheMs: 0, ...extra });
  skip("USER_SPEND_SORT defaults to the aggregate and the persisted ranking needs a clean verification", async () => {
    assert.deepEqual(await status({}), { ready: false, reason: "not_requested" });
    assert.deepEqual(await status({ USER_SPEND_SORT: "aggregate" }), { ready: false, reason: "not_requested" });
    assert.deepEqual(await status({ USER_SPEND_SORT: "persisted" }), { ready: true, reason: "verified" });

    await JobCheckpoint.deleteOne({ name: spend.SPEND_VERIFY_JOB });
    assert.deepEqual(await status({ USER_SPEND_SORT: "persisted" }), { ready: false, reason: "not_verified" });
    await JobCheckpoint.collection.insertOne({ name: spend.SPEND_VERIFY_JOB, leaseOwner: null, leaseUntil: null, state: { ok: false, verifiedAt: new Date(), missing: 1 } });
    assert.deepEqual(await status({ USER_SPEND_SORT: "persisted" }), { ready: false, reason: "not_verified" });
    await maintenance.runUserSpendVerify({ settleMs: 0 });                                  // clean again
    assert.equal((await status({ USER_SPEND_SORT: "persisted" })).ready, true);

    const broken = { collection: { findOne: async () => { throw new Error("db down"); } } };
    assert.deepEqual(await status({ USER_SPEND_SORT: "persisted" }, { checkpointModel: broken }), { ready: false, reason: "readiness_unavailable" });
  });

  skip("without verification the persisted flag is ignored and the exact aggregate ranking is returned", async () => {
    await JobCheckpoint.deleteOne({ name: spend.SPEND_VERIFY_JOB });
    const aggregate = await listAll({ blocked: "no" }, "aggregate", { pageSize: 100, maxPages: 3 });
    const requested = await listAll({ blocked: "no" }, "persisted", { pageSize: 100, maxPages: 3 });
    assert.deepEqual(requested, aggregate);
    await maintenance.runUserSpendVerify({ settleMs: 0 });
  });

  // ── Readiness follows the REAL sweeper's state ────────────────────────────────────────────────────────────
  const REQUEST = { USER_SPEND_SORT: "persisted" };
  const failingScan = () => new Proxy(WalletPurchase, {
    get(target, prop) {
      if (prop === "find") return () => { throw new Error("simulated scan failure"); };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const sweeperDoc = async () => (await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB)).state;
  const healthyTick = async () => { const result = await sweeper.runUserSpendSweepTick({}); assert.equal(result.error, null); return result; };

  skip("a failing sweeper tick switches the persisted ranking off at once (cache included), a clean tick brings it back", async () => {
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).ready, true, "ready, and now cached for up to 30 s");

    const failed = await sweeper.runUserSpendSweepTick({ purchaseModel: failingScan() });
    assert.equal(failed.error, "Error");
    assert.deepEqual(await spend.persistedSpendSortStatus({ env: REQUEST }), { ready: false, reason: "sweeper_failing" }, "the failing tick dropped the cached answer");
    const aggregate = await listAll({ blocked: "no" }, "aggregate", { pageSize: 100, maxPages: 2 });
    assert.deepEqual(await listAll({ blocked: "no" }, "persisted", { pageSize: 100, maxPages: 2 }), aggregate, "the list falls back to the aggregate");

    await healthyTick();
    spend.resetPersistedSpendSortCacheForTests();
    assert.deepEqual(await spend.persistedSpendSortStatus({ env: REQUEST }), { ready: true, reason: "verified" }, "the failure counters were cleared by the clean tick");
  });

  skip("a stale sweeper success and a missing sweeper checkpoint both fall back, and a clean tick recovers", async () => {
    await JobCheckpoint.collection.updateOne({ name: spend.SPEND_SWEEPER_JOB }, { $set: { "state.lastSuccessAt": new Date(Date.now() - 16 * 60_000) } });
    spend.resetPersistedSpendSortCacheForTests();
    assert.deepEqual(await spend.persistedSpendSortStatus({ env: REQUEST }), { ready: false, reason: "sweeper_stale" });
    await healthyTick();
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).ready, true);

    await JobCheckpoint.deleteOne({ name: spend.SPEND_SWEEPER_JOB });
    spend.resetPersistedSpendSortCacheForTests();
    assert.deepEqual(await spend.persistedSpendSortStatus({ env: REQUEST }), { ready: false, reason: "sweeper_not_running" });
    await healthyTick();                                                      // recreates the checkpoint and completes a pass (700 users)
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).ready, true);
  });

  skip("an under-count found by a reconcile pass switches the persisted ranking off until a clean pass completes", async () => {
    const victim = (await User.collection.findOne({ totalSpent: { $gt: 0 } })).telegramId;
    const before = await User.collection.findOne({ telegramId: victim });
    await User.collection.updateOne({ telegramId: victim }, { $set: { totalSpent: 0, completedOrderCount: 0 } }); // stale counters

    await sweeper.runUserSpendSweepTick({ skipScan: true });                  // the pass finds and repairs it, and reports it
    assert.equal((await sweeperDoc()).lastPass.under, 1);
    assert.equal((await User.collection.findOne({ telegramId: victim })).totalSpent, before.totalSpent, "repaired");
    spend.resetPersistedSpendSortCacheForTests();
    assert.deepEqual(await spend.persistedSpendSortStatus({ env: REQUEST }), { ready: false, reason: "sweeper_found_discrepancies" }, "still off: the latest pass reported a discrepancy");

    await sweeper.runUserSpendSweepTick({ skipScan: true });                  // the next pass is clean
    assert.equal((await sweeperDoc()).lastPass.under, 0);
    spend.resetPersistedSpendSortCacheForTests();
    assert.deepEqual(await spend.persistedSpendSortStatus({ env: REQUEST }), { ready: true, reason: "verified" }, "recovered after a clean pass");
  });

  skip("missing counters found by a reconcile pass also switch it off, and the first deploy is not ready before a pass completed", async () => {
    const victim = (await User.collection.findOne({})).telegramId;
    await User.collection.updateOne({ telegramId: victim }, { $unset: { totalSpent: "", completedOrderCount: "" } });
    await sweeper.runUserSpendSweepTick({ skipScan: true });
    assert.equal((await sweeperDoc()).lastPass.missing, 1);
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).reason, "sweeper_found_discrepancies");
    await sweeper.runUserSpendSweepTick({ skipScan: true });
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).ready, true);

    // a sweeper that has only just started (a tick succeeded but no pass has completed yet)
    await JobCheckpoint.collection.updateOne({ name: spend.SPEND_SWEEPER_JOB }, { $unset: { "state.lastPass": "" } });
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).reason, "no_completed_pass");
    await healthyTick();
    spend.resetPersistedSpendSortCacheForTests();
    assert.equal((await spend.persistedSpendSortStatus({ env: REQUEST })).ready, true);
  });

  skip("the persisted ranking is really used when ready, and the sweeper's over-count finding switches it off again", async () => {
    const exact = await listAll({}, "aggregate", { pageSize: 5, maxPages: 1 });
    const victim = exact[0].items[exact[0].items.length - 1].telegramId;                       // someone on page 1...
    const zeroUser = (await User.collection.findOne({ totalSpent: 0 })).telegramId;
    await User.collection.updateOne({ telegramId: zeroUser }, { $set: { totalSpent: 90_000_000, completedOrderCount: 9 } }); // corrupt: over-count

    const persisted = await listAll({}, "persisted", { pageSize: 5, maxPages: 1 });
    assert.equal(persisted[0].items[0].telegramId, zeroUser, "ranked by the stored counter (proves the persisted path is serving)");
    assert.equal(persisted[0].items[0].totalSpent, 0, "...while the displayed total is still the exact aggregate");
    assert.ok(victim);

    await sweeper.runUserSpendSweepTick({ skipScan: true, reconcileBatch: 5_000 });          // a full pass sees the over-count
    const { lastPass } = (await lease.readCheckpoint(JobCheckpoint, spend.SPEND_SWEEPER_JOB)).state;
    assert.equal(lastPass.over, 1);
    assert.deepEqual(await status({ USER_SPEND_SORT: "persisted" }), { ready: false, reason: "sweeper_found_discrepancies" });
    const fallback = await listAll({}, "persisted", { pageSize: 5, maxPages: 1 });
    assert.deepEqual(fallback, exact, "back to the exact aggregate ranking");
    assert.equal((await User.collection.findOne({ telegramId: zeroUser })).totalSpent, 90_000_000, "the over-count was never lowered automatically");
  });
});
