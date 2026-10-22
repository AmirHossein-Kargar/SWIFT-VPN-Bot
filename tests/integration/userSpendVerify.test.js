/**
 * `--verify` must never mistake a genuine counter discrepancy for acceptable timing lag.
 *
 * A lagging counter is "in flight" only when the whole gap (spent AND count) is covered by purchases that
 * completed within the short grace window: the stored pair must already include everything older. Anything
 * ambiguous (a gap larger than the recent completions, a window that is too old, future-dated, malformed or
 * untimed data) is an unexplained under-count and verification is not healthy.
 * Real MongoDB; skips without one.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { insertPurchases, insertUsers, purchaseDoc, userDoc } from "../helpers/userSpendFixtures.js";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let User, WalletPurchase, JobCheckpoint, maintenance, spend, lease;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: JobCheckpoint } = await import("../../models/JobCheckpoint.js"));
  maintenance = await import("../../services/users/userSpendMaintenance.js");
  spend = await import("../../services/users/userSpend.js");
  lease = await import("../../services/jobLease.js");
}

const MIN = 60_000;
const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms);
const pair = (spent, count) => ({ totalSpent: spent, completedOrderCount: count });

/** One user whose stored counters are exactly `stored`, with old and recent completed purchases. */
async function world(id, { stored, old = [], recent = [] }) {
  await insertUsers(User, [userDoc(id, pair(...stored))]);
  await insertPurchases(WalletPurchase, [
    ...old.map((amount) => purchaseDoc(id, { amount, completedAt: ago(3 * DAY) })),
    ...recent.map((entry) => { const { amount, agoMs = 5_000, ...rest } = typeof entry === "number" ? { amount: entry } : entry; return purchaseDoc(id, { amount, completedAt: ago(agoMs), ...rest }); }),
  ]);
}
const verify = (options = {}) => maintenance.runUserSpendVerify({ settleMs: 0, writeMarker: false, ...options });
const outcome = (report) => ({ ok: report.ok, under: report.under, inFlight: report.inFlight, unexplained: report.unexplainedUnder });
const HEALTHY_LAG = { ok: true, under: 1, inFlight: 1, unexplained: 0 };
const REJECTED = { ok: false, under: 1, inFlight: 0, unexplained: 1 };

describe("verify: timing lag versus a genuine under-count", () => {
  before(async () => { if (dbAvailable) await Promise.all([User.syncIndexes(), WalletPurchase.syncIndexes(), JobCheckpoint.syncIndexes()]); });
  beforeEach(async () => { if (dbAvailable) await Promise.all([User.deleteMany({}), WalletPurchase.deleteMany({}), JobCheckpoint.deleteMany({})]); });
  after(async () => { if (dbAvailable) await disconnectTestDB(); });

  // ── legitimate temporary lag ─────────────────────────────────────────────────────────────────────────────
  skip("legitimate lag: everything old is counted and only a just-completed purchase is missing", async () => {
    await world("lag1", { stored: [30_000, 2], old: [10_000, 20_000], recent: [5_000] });
    assert.deepEqual(outcome(await verify()), HEALTHY_LAG);
  });

  skip("legitimate lag: several recent purchases, some already counted, some not", async () => {
    await world("lag2", { stored: [10_000 + 3_000, 2], old: [10_000], recent: [3_000, 4_000, 2_000] });   // 3,000 landed; 6,000 pending
    assert.deepEqual(outcome(await verify()), HEALTHY_LAG);
  });

  skip("legitimate lag: the gap exactly equal to the recent completions is explained, one Toman more is not", async () => {
    await world("edge-exact", { stored: [10_000, 1], old: [10_000], recent: [5_000] });                   // gap (5,000 / 1) == recent
    await world("edge-over", { stored: [10_000, 1], old: [10_000, 1], recent: [5_000] });                // gap (5,001 / 2) > recent (5,000 / 1)
    const report = await verify();
    assert.deepEqual([report.inFlight, report.unexplainedUnder, report.ok], [1, 1, false]);
    assert.deepEqual(report.underSamples.map((s) => [s.telegramId, s.verdict]).sort(), [["edge-exact", "inFlight"], ["edge-over", "unexplainedUnder"]]);
  });

  // ── the masked cases the old rule accepted ─────────────────────────────────────────────────────────────────
  skip("an old under-count is NOT excused by a recent completion that is already counted", async () => {
    await world("masked1", { stored: [5_000, 1], old: [10_000, 20_000], recent: [5_000] });             // two old purchases missing, the recent one counted
    assert.deepEqual(outcome(await verify()), REJECTED);
  });

  skip("an old under-count is NOT excused by a recent completion that is itself not yet counted", async () => {
    await world("masked2", { stored: [0, 0], old: [10_000, 20_000], recent: [5_000] });                 // the audit's probe: stored 0, truth 35,000 / 3
    const report = await verify();
    assert.deepEqual(outcome(report), REJECTED);
    assert.equal(report.underSamples[0].gap.totalSpent, 35_000);
    assert.equal(report.underSamples[0].recent.totalSpent, 5_000);
  });

  skip("an old under-count with no recent activity is rejected", async () => {
    await world("old-only", { stored: [0, 0], old: [10_000] });
    assert.deepEqual(outcome(await verify()), REJECTED);
  });

  skip("both components must be covered: a large recent purchase cannot hide missing old orders (count) or a missing large one (spent)", async () => {
    await world("count-gap", { stored: [10_000, 1], old: [100, 100], recent: [10_000] });                // spent gap 200 <= 10,000 but count gap 2 > 1
    await world("spent-gap", { stored: [100, 1], old: [50_000], recent: [100] });                        // count gap 1 <= 1 but spent gap 50,000 > 100
    const report = await verify();
    assert.deepEqual([report.under, report.inFlight, report.unexplainedUnder, report.ok], [2, 0, 2, false]);
  });

  // ── the window ───────────────────────────────────────────────────────────────────────────────────────────
  skip("only completions inside the grace window explain lag; the default window is short (30 s), and 0 allows no explanation", async () => {
    assert.equal(maintenance.VERIFY_DEFAULT_GRACE_MS, 30_000);
    await world("window", { stored: [10_000, 1], old: [10_000], recent: [{ amount: 5_000, agoMs: 10 * MIN }] });
    assert.deepEqual(outcome(await verify()), REJECTED, "completed 10 minutes ago: a healthy hook would have landed long ago");
    assert.deepEqual(outcome(await verify({ graceMs: 15 * MIN })), HEALTHY_LAG, "an explicitly wider window explains it");
    assert.deepEqual(outcome(await verify({ graceMs: 0 })), REJECTED, "zero grace explains nothing");
  });

  skip("a completion dated in the future does not explain lag (beyond a small clock-skew tolerance)", async () => {
    await world("future", { stored: [10_000, 1], old: [10_000], recent: [{ amount: 5_000, agoMs: -2 * DAY }] });
    assert.deepEqual(outcome(await verify()), REJECTED);
    await User.deleteMany({}); await WalletPurchase.deleteMany({});
    await world("skew", { stored: [10_000, 1], old: [10_000], recent: [{ amount: 5_000, agoMs: -MIN }] });  // one minute ahead: tolerated skew
    assert.deepEqual(outcome(await verify()), HEALTHY_LAG);
  });

  // ── ambiguity is never healthy ─────────────────────────────────────────────────────────────────────────────
  skip("malformed or untimed recent data cannot explain a gap", async () => {
    await world("bad-amount", { stored: [10_000, 1], old: [10_000], recent: [{ amount: "5,000" }] });      // a completed purchase whose amount is not a number
    await world("no-time", { stored: [10_000, 1], old: [10_000], recent: [{ amount: 5_000, completedAt: null }] });
    await world("text-time", { stored: [10_000, 1], old: [10_000], recent: [{ amount: 5_000, completedAt: new Date().toISOString() }] });
    const report = await verify();
    assert.deepEqual(outcome(report), { ok: false, under: 3, inFlight: 0, unexplained: 3 });
  });

  skip("only COMPLETED purchases of the SAME user can explain lag", async () => {
    await world("other-status", { stored: [10_000, 1], old: [10_000], recent: [{ amount: 5_000, status: "provisioned", completedAt: null }, { amount: 7_000, status: "refunded" }] });
    await world("other-user", { stored: [0, 0], old: [10_000] });
    await insertPurchases(WalletPurchase, [purchaseDoc("someone-else", { amount: 50_000, completedAt: ago(1_000) })]);
    await insertUsers(User, [userDoc("someone-else", pair(50_000, 1))]);
    // other-status: the refunded/provisioned rows are not in the truth, so there is no gap at all (healthy), while other-user's gap stays unexplained
    const report = await verify();
    assert.deepEqual([report.under, report.unexplainedUnder, report.ok], [1, 1, false]);
    assert.equal(report.underSamples[0].telegramId, "other-user");
  });

  // ── what is recorded ─────────────────────────────────────────────────────────────────────────────────────
  skip("a masked discrepancy fails the stored marker, so USER_SPEND_SORT=persisted stays off", async () => {
    await world("marker", { stored: [0, 0], old: [10_000, 20_000], recent: [5_000] });
    const report = await maintenance.runUserSpendVerify({ settleMs: 0 });
    assert.equal(report.ok, false);
    const marker = await lease.readCheckpoint(JobCheckpoint, spend.SPEND_VERIFY_JOB);
    assert.deepEqual([marker.state.ok, marker.state.unexplainedUnder, marker.state.inFlight], [false, 1, 0]);
    assert.equal(spend.evaluatePersistedSpendReadiness(marker, { state: {} }, Date.now()).value.reason, "not_verified");
  });

  skip("lag that resolves during the settle wait is not reported at all, and a gap that does not resolve is", async () => {
    await world("resolves", { stored: [10_000, 1], old: [10_000], recent: [5_000] });
    await world("persists", { stored: [0, 0], old: [10_000], recent: [{ amount: 5_000, agoMs: 20 * MIN }] });
    setTimeout(() => { void spend.recomputeUserSpend("resolves"); }, 40);                                  // its hook lands during the wait
    const report = await maintenance.runUserSpendVerify({ settleMs: 400, writeMarker: false });
    assert.deepEqual([report.under, report.inFlight, report.unexplainedUnder, report.ok], [1, 0, 1, false]);
    assert.equal(report.underSamples[0].telegramId, "persists");
  });
});
