/**
 * Operator tools for the persisted user spend counters: a resumable backfill and a read-only verification.
 * Both use the same conditional RAISE as the live writers (userSpend.js), never a plain $set, so they are safe to
 * run while purchases keep completing: whichever writer holds the larger true pair wins, nothing is ever lowered.
 */
import { randomUUID } from "node:crypto";
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import JobCheckpoint from "../../models/JobCheckpoint.js";
import { acquireLease, readCheckpoint, releaseLease, renewLease, writeLeasedState } from "../jobLease.js";
import { CHECKPOINT_CLOCK_TOLERANCE_MS, SPEND_BACKFILL_JOB, SPEND_VERIFY_JOB, classifySpend, readSpendTruth, recomputeUsersSpend } from "./userSpend.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* userChunks(userModel, chunkSize, afterId) {
  let cursor = afterId || null;
  for (;;) {
    const users = await userModel.find(cursor ? { _id: { $gt: cursor } } : {}).sort({ _id: 1 }).limit(chunkSize)
      .select("telegramId totalSpent completedOrderCount").lean().maxTimeMS(8_000);
    if (!users.length) return;
    yield users;
    cursor = users[users.length - 1]._id;
    if (users.length < chunkSize) return;
  }
}

/**
 * Raise every user's counters to the truth, INCLUDING an explicit 0/0 for users without purchases.
 * Resumable: progress (the last finished _id) is stored in the checkpoint after every chunk, so an interrupted
 * run continues where it stopped, and a re-run from the start is harmless (raising is idempotent).
 * @returns {Promise<{completed:boolean, chunks:number, users:number, raised:number, resumedFrom:string|null}>}
 */
export async function runUserSpendBackfill({
  userModel = User, purchaseModel = WalletPurchase, checkpointModel = JobCheckpoint,
  chunkSize = 1_000, sleepMs = 0, maxChunks = Infinity, restart = false, dryRun = false, onChunk = null, leaseTtlMs = 120_000,
} = {}) {
  const owner = `${process.pid}:${randomUUID()}`;
  const lease = await acquireLease(checkpointModel, SPEND_BACKFILL_JOB, owner, leaseTtlMs);
  if (!lease) throw Object.assign(new Error("Another user spend backfill is running"), { code: "BACKFILL_ALREADY_RUNNING" });
  const summary = { completed: false, chunks: 0, users: 0, raised: 0, wouldRaise: 0, resumedFrom: null };
  try {
    const saved = (await readCheckpoint(checkpointModel, SPEND_BACKFILL_JOB))?.state || {};
    const resumeFrom = !restart && saved.cursor ? saved.cursor : null;
    summary.resumedFrom = resumeFrom;
    if (!dryRun && (restart || !saved.cursor)) await writeLeasedState(checkpointModel, lease, { set: { startedAt: new Date() }, unset: ["completedAt"] });

    for await (const users of userChunks(userModel, chunkSize, resumeFrom)) {
      if (summary.chunks >= maxChunks) return summary;
      if (!(await renewLease(checkpointModel, lease))) throw new Error("backfill lease was lost");
      const ids = users.map((user) => user.telegramId).filter(Boolean);
      if (dryRun) {
        const truth = await readSpendTruth(ids, { purchaseModel });
        summary.wouldRaise += users.filter((user) => ["missing", "under"].includes(classifySpend(user, truth.get(String(user.telegramId))))).length;
      } else {
        summary.raised += (await recomputeUsersSpend(ids, { userModel, purchaseModel })).raised;
        if (!(await writeLeasedState(checkpointModel, lease, { set: { cursor: String(users[users.length - 1]._id), users: summary.users + users.length } }))) throw new Error("backfill lease was lost");
      }
      summary.chunks += 1;
      summary.users += users.length;
      if (onChunk) await onChunk({ ...summary });
      if (sleepMs) await sleep(sleepMs);
    }
    summary.completed = true;
    if (!dryRun) await writeLeasedState(checkpointModel, lease, { set: { completedAt: new Date() }, unset: ["cursor"] });
    return summary;
  } finally {
    await releaseLease(checkpointModel, lease).catch(() => {});
  }
}

/**
 * Width of the "just completed" window. The post-completion hook finishes within seconds (its own timeout is 5 s) and
 * verify first waits `settleMs`, so a lag that is still there after that and involves a purchase older than this window
 * is not a timing delay; it is a lost update that only the sweeper would repair.
 */
export const VERIFY_DEFAULT_GRACE_MS = 30_000;
/** The CLI refuses a wider window: the wider it is, the easier it is for lag to hide a real discrepancy. */
export const VERIFY_MAX_GRACE_MS = 5 * 60_000;
const NUMERIC_TYPES = ["int", "long", "double", "decimal"];

/** Spent / count / malformed-row totals of each user's COMPLETED purchases whose completedAt lies in [from, to]. */
async function recentCompletions(purchaseModel, telegramIds, from, to) {
  const rows = await purchaseModel.aggregate([
    { $match: { telegramId: { $in: telegramIds }, status: "completed", completedAt: { $gte: from, $lte: to } } },
    { $group: {
      _id: "$telegramId",
      totalSpent: { $sum: "$amount" },
      completedOrderCount: { $sum: 1 },
      malformed: { $sum: { $cond: [{ $in: [{ $type: "$amount" }, NUMERIC_TYPES] }, 0, 1] } },
    } },
  ]).option({ maxTimeMS: 8_000 });
  return new Map(rows.map((row) => [String(row._id), row]));
}

/**
 * Is a lagging (under-counted) pair fully accounted for by purchases that just completed?
 * It is only when the WHOLE gap, spent AND count, fits inside the recent completions, which means the stored pair
 * already contains everything older. If the gap is bigger in either component, an older purchase is missing too, so
 * the recent completion cannot be the explanation. Why this is sound: every writer recomputes the user's FULL pair,
 * so a stored pair is always a read taken at some moment; it contains every purchase completed before that moment.
 * Genuine lag therefore means "stored equals an earlier read", i.e. stored >= truth - (what completed since), which is
 * exactly the test below. A stored pair that includes a recent purchase but misses an older one cannot be produced by
 * the system's own writers (only by corruption), and the narrow window plus the sweeper's under-count gate cover it.
 * Ambiguity is never excused: no recent completions in the window,
 * a recent purchase with a non-numeric amount, or a recent purchase without a real Date completedAt all leave the
 * gap unexplained.
 */
function explainUnderCount(stored, expected, recent) {
  const gap = { totalSpent: expected.totalSpent - stored.totalSpent, completedOrderCount: expected.completedOrderCount - stored.completedOrderCount };
  const explained = Boolean(recent) && recent.malformed === 0
    && gap.totalSpent <= recent.totalSpent && gap.completedOrderCount <= recent.completedOrderCount;
  return { gap, explained };
}

/**
 * Check of every user against the truth. A discrepancy is re-read once after `settleMs`, so a purchase that
 * completes during the run (its hook has not landed yet) is not reported. What remains is:
 *   missing  — a counter is absent / not a number;
 *   over     — a counter is above the truth (never produced by the system; never lowered automatically);
 *   under    — below the truth. "inFlight" ONLY when the gap is entirely covered by purchases that completed within
 *              `graceMs` before the re-read (see explainUnderCount); every other under-count is "unexplainedUnder".
 * `ok` is true only when missing, over and unexplainedUnder are all zero, so ambiguous data is never reported healthy.
 * The outcome is stored as the verification marker that USER_SPEND_SORT=persisted requires. Besides that marker
 * nothing is written; counters are never changed.
 */
export async function runUserSpendVerify({
  userModel = User, purchaseModel = WalletPurchase, checkpointModel = JobCheckpoint,
  chunkSize = 1_000, settleMs = 3_000, graceMs = VERIFY_DEFAULT_GRACE_MS, writeMarker = true, sampleLimit = 20, now = () => new Date(),
} = {}) {
  const report = { ok: false, users: 0, missing: 0, over: 0, under: 0, inFlight: 0, unexplainedUnder: 0, graceMs, samples: [], underSamples: [], verifiedAt: null };
  const suspects = [];
  for await (const users of userChunks(userModel, chunkSize, null)) {
    const truth = await readSpendTruth(users.map((user) => user.telegramId).filter(Boolean), { purchaseModel });
    report.users += users.length;
    for (const user of users) {
      if (user.telegramId && classifySpend(user, truth.get(String(user.telegramId))) !== "ok") suspects.push(String(user.telegramId));
    }
  }

  if (suspects.length) {
    if (settleMs) await sleep(settleMs);
    for (let i = 0; i < suspects.length; i += chunkSize) {
      const ids = suspects.slice(i, i + chunkSize);
      const [fresh, truth] = await Promise.all([
        userModel.find({ telegramId: { $in: ids } }).select("telegramId totalSpent completedOrderCount").lean(),
        readSpendTruth(ids, { purchaseModel }),
      ]);
      const lagging = [];
      for (const user of fresh) {
        const expected = truth.get(String(user.telegramId));
        const verdict = classifySpend(user, expected);
        if (verdict === "ok") continue;
        report[verdict] += 1;
        if (verdict === "under") lagging.push({ user, expected });
        else if (report.samples.length < sampleLimit) {
          report.samples.push({ telegramId: String(user.telegramId), verdict, stored: { totalSpent: user.totalSpent ?? null, completedOrderCount: user.completedOrderCount ?? null }, truth: expected });
        }
      }
      if (lagging.length) {
        const reference = now().getTime();
        const recent = graceMs > 0
          ? await recentCompletions(purchaseModel, lagging.map(({ user }) => String(user.telegramId)), new Date(reference - graceMs), new Date(reference + CHECKPOINT_CLOCK_TOLERANCE_MS))
          : new Map();
        for (const { user, expected } of lagging) {
          const id = String(user.telegramId);
          const { gap, explained } = explainUnderCount(user, expected, recent.get(id));
          if (explained) report.inFlight += 1; else report.unexplainedUnder += 1;
          if (report.underSamples.length < sampleLimit) {
            const r = recent.get(id);
            report.underSamples.push({
              telegramId: id, verdict: explained ? "inFlight" : "unexplainedUnder",
              stored: { totalSpent: user.totalSpent, completedOrderCount: user.completedOrderCount }, truth: expected, gap,
              recent: { totalSpent: r?.totalSpent ?? 0, completedOrderCount: r?.completedOrderCount ?? 0, malformed: r?.malformed ?? 0 },
            });
          }
        }
      }
    }
  }

  report.ok = report.missing === 0 && report.over === 0 && report.unexplainedUnder === 0;
  report.verifiedAt = now();
  if (writeMarker) {
    await checkpointModel.collection.updateOne(
      { name: SPEND_VERIFY_JOB },
      { $set: { state: { ok: report.ok, verifiedAt: report.verifiedAt, users: report.users, missing: report.missing, over: report.over, under: report.under, inFlight: report.inFlight, unexplainedUnder: report.unexplainedUnder, graceMs }, updatedAt: new Date() }, $setOnInsert: { leaseOwner: null, leaseUntil: null } },
      { upsert: true },
    );
  }
  return report;
}
