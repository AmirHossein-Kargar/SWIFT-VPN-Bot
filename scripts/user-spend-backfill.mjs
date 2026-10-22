#!/usr/bin/env node
/**
 * Backfill and verify the persisted user spend counters (User.totalSpent / completedOrderCount).
 *
 *   node scripts/user-spend-backfill.mjs --backfill [--restart] [--chunk 1000] [--sleep-ms 50]
 *   node scripts/user-spend-backfill.mjs --dry-run
 *   node scripts/user-spend-backfill.mjs --verify  [--settle-ms 3000] [--grace-ms 30000]
 *
 * What each mode WRITES (nothing else is ever written; balances, purchase status, payments and every ledger are untouched):
 *   --backfill  raises every user's counters to the true value (explicit 0 for users without purchases) and records its
 *               progress in the "user-spend-backfill" checkpoint document. Resumable, and safe while purchases keep
 *               completing: it only raises, never lowers.
 *   --dry-run   writes NO user counters and NO progress. It does take and release the backfill lease: the
 *               "user-spend-backfill" document in the jobcheckpoints collection is created if absent and its lease
 *               fields are set and then cleared. It reports how many users a backfill would change. Because of that lease,
 *               a dry-run refuses to start while a real backfill is running (and the reverse).
 *   --verify    compares every user with WalletPurchase and writes no user counters, but it DOES write one document:
 *               the verification marker "user-spend-verify" (jobcheckpoints), recording whether the result was clean.
 *               Exits 1 unless there are no missing counters, no over-counts and no unexplained under-counts. A clean
 *               marker is one of the conditions for USER_SPEND_SORT=persisted (see docs/user-spend.md).
 *               An under-count is excused as timing lag ONLY when the whole gap (spent and count) is covered by purchases
 *               that completed within the last --grace-ms (default 30000, at most 300000), i.e. the stored counters already
 *               contain everything older. A bigger gap, an older or future-dated purchase, malformed data, or no recent
 *               purchase at all is an unexplained under-count and fails the check; ambiguous data is never reported healthy.
 *               Re-run it after the sweeper has caught up if a lagging user is reported.
 *
 * Connects with the same MongoDB variables as the bot (MONGO_URL or the Railway variables). Like the bot in
 * production it connects with autoIndex and autoCreate OFF, so running this script never builds or creates indexes
 * or collections as a side effect of connecting (the bot builds its indexes at startup).
 */
import mongoose from "mongoose";
import { resolveMongoUrl } from "../config/env.js";
import { VERIFY_DEFAULT_GRACE_MS, VERIFY_MAX_GRACE_MS, runUserSpendBackfill, runUserSpendVerify } from "../services/users/userSpendMaintenance.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(args[index + 1]);
  if (!Number.isFinite(parsed) || parsed < 0) { console.error(`Invalid value for ${name}`); process.exit(2); }
  return parsed;
};

const graceMs = value("--grace-ms", VERIFY_DEFAULT_GRACE_MS);
if (graceMs > VERIFY_MAX_GRACE_MS) {
  console.error(`--grace-ms must be between 0 and ${VERIFY_MAX_GRACE_MS}: a wider window can hide a real discrepancy`);
  process.exit(2);
}

const modes = ["--backfill", "--dry-run", "--verify"].filter(flag);
if (modes.length !== 1) {
  console.error("Choose exactly one of --backfill, --dry-run, --verify (see the header of this file).");
  process.exit(2);
}

let exitCode = 0;
try {
  const resolved = resolveMongoUrl();
  if (!resolved) throw new Error("MongoDB is not configured (set MONGO_URL)");
  // Deliberately off, as the bot does in production (config/db.js): connecting must not build indexes.
  await mongoose.connect(resolved.url, { serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false });
  const chunkSize = Math.max(1, Math.min(5_000, value("--chunk", 1_000)));

  if (flag("--verify")) {
    const report = await runUserSpendVerify({ chunkSize, settleMs: value("--settle-ms", 3_000), graceMs });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) exitCode = 1;
  } else {
    const summary = await runUserSpendBackfill({
      chunkSize, sleepMs: value("--sleep-ms", 50), restart: flag("--restart"), dryRun: flag("--dry-run"),
      onChunk: (progress) => console.error(`chunk ${progress.chunks}: ${progress.users} users processed`),
    });
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.completed) exitCode = 1;
  }
} catch (error) {
  console.error(`user-spend: ${error?.code || error?.name || "Error"}: ${error?.message || "failed"}`);
  exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
process.exit(exitCode);
