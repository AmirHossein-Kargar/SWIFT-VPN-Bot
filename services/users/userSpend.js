/**
 * Persisted per-user spend counters (User.totalSpent, User.completedOrderCount) for the admin "top spending" ranking.
 *
 * Definition (identical to the aggregate in services/admin/users.js): the sum and count of WalletPurchase.amount
 * for purchases with status "completed", per telegramId. Top-ups, admin balance edits and every non-completed
 * purchase are excluded; revoked/expired services stay counted because their purchases stay completed.
 *
 * The counters are DERIVED data. Nothing here reads or writes balances, purchase status, idempotency ledgers or
 * payment state, and nothing money-related ever reads these fields.
 *
 * ── Consistency model ────────────────────────────────────────────────────────────────────────────────────────
 * A writer always recomputes the user's FULL pair (sum, count) from WalletPurchase in one aggregation (the sum
 * and the count come from the same documents) and then RAISES the stored pair with one conditional update:
 *
 *   write (S, C) only when the stored pair is missing/non-numeric OR is componentwise <= (S, C) and different.
 *
 * Why not two independent $max: reads that overlap with commits are not nested snapshots, so a read r1 may
 * contain a purchase that a later read r2 lacks. Independent $max would then store S from r1 and C from r2: a
 * pair no read ever returned. With the conditional raise the stored pair is replaced as a unit, so it is ALWAYS
 * exactly a pair some read returned, and it is never lowered in either component.
 *
 * Guarantees (spend only grows: "completed" is terminal, amounts are never edited, purchases are never deleted):
 *  1. stored <= true, componentwise, at all times: every written pair is a subset-read of completed purchases.
 *  2. Monotone: neither field ever decreases through this module.
 *  3. Convergence: a read that starts after the last commit sees every completed purchase, so its pair equals the
 *     truth and dominates every stored pair; it is written. Equal count implies equal sum (a subset of the same
 *     size is the whole set), so "stored count == true count" means the stored pair is exact.
 *  4. Idempotent and order-independent: retries, duplicates, concurrent writers and replays cannot change the
 *     outcome beyond "closer to the truth".
 * Not guaranteed: freshness (a lost recompute leaves the pair stale until the next one; the sweeper bounds it)
 * and repair of an OVER-count (stored above truth): that cannot be produced by this module, only by corruption
 * or manual edits. It is detected and reported (classifySpend / reconcile) and never lowered automatically.
 */
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import JobCheckpoint from "../../models/JobCheckpoint.js";
import { readCheckpoint } from "../jobLease.js";

export const SPEND_SWEEPER_JOB = "user-spend-sweeper";
export const SPEND_VERIFY_JOB = "user-spend-verify";
export const SPEND_BACKFILL_JOB = "user-spend-backfill";

const OFF_VALUES = new Set(["off", "false", "0", "disabled", "no"]);
const isOff = (value) => OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** USER_SPEND_HOOK: on unless set to off/false/0/disabled/no. */
export const userSpendHookEnabled = (env = process.env) => !isOff(env.USER_SPEND_HOOK);
/** USER_SPEND_SWEEPER: on unless set to off/false/0/disabled/no. */
export const userSpendSweeperEnabled = (env = process.env) => !isOff(env.USER_SPEND_SWEEPER);
/** USER_SPEND_SORT: the persisted ranking is requested only by the exact value "persisted"; anything else keeps the aggregate. */
export const persistedSpendSortRequested = (env = process.env) => String(env.USER_SPEND_SORT ?? "").trim().toLowerCase() === "persisted";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "user-spend", level, message, ...meta }),
  );
}

// ── Truth, classification, raise ────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<Map<string,{totalSpent:number,completedOrderCount:number}>>} an entry (zero when none) for every id */
export async function readSpendTruth(telegramIds, { purchaseModel = WalletPurchase, maxTimeMS = 8_000 } = {}) {
  const ids = [...new Set(telegramIds.map((id) => String(id)))];
  const truth = new Map(ids.map((id) => [id, { totalSpent: 0, completedOrderCount: 0 }]));
  if (!ids.length) return truth;
  const rows = await purchaseModel.aggregate([
    { $match: { telegramId: { $in: ids }, status: "completed" } },
    { $group: { _id: "$telegramId", totalSpent: { $sum: "$amount" }, completedOrderCount: { $sum: 1 } } },
  ]).option({ maxTimeMS });
  for (const row of rows) truth.set(String(row._id), { totalSpent: Number(row.totalSpent) || 0, completedOrderCount: Number(row.completedOrderCount) || 0 });
  return truth;
}

/**
 * "ok" | "missing" | "under" | "over".
 * over: any stored component is above the truth (never produced by this module; reported, never lowered).
 * missing: a counter is absent or not a number. under: numeric, not above, and below the truth in some component.
 */
export function classifySpend(stored, truth) {
  const spent = stored?.totalSpent;
  const count = stored?.completedOrderCount;
  if ((isNumber(spent) && spent > truth.totalSpent) || (isNumber(count) && count > truth.completedOrderCount)) return "over";
  if (!isNumber(spent) || !isNumber(count)) return "missing";
  if (spent < truth.totalSpent || count < truth.completedOrderCount) return "under";
  return "ok";
}

const notNumber = (field) => ({ [field]: { $not: { $type: "number" } } });
const canRaise = (field, value) => ({ $or: [notNumber(field), { [field]: { $lte: value } }] });

/** The conditional raise described in the header; its filter is the whole safety rule. */
export function raiseFilter(telegramId, { totalSpent, completedOrderCount }) {
  return {
    telegramId: String(telegramId),
    $and: [
      canRaise("totalSpent", totalSpent),
      canRaise("completedOrderCount", completedOrderCount),
      { $or: [notNumber("totalSpent"), notNumber("completedOrderCount"), { totalSpent: { $lt: totalSpent } }, { completedOrderCount: { $lt: completedOrderCount } }] },
    ],
  };
}

function raiseOps(entries) {
  return entries.map(([telegramId, pair]) => ({
    updateOne: { filter: raiseFilter(telegramId, pair), update: { $set: { totalSpent: pair.totalSpent, completedOrderCount: pair.completedOrderCount } } },
  }));
}

/** Recompute and raise the counters of many users: one aggregation, one unordered bulk write. */
export async function recomputeUsersSpend(telegramIds, { userModel = User, purchaseModel = WalletPurchase, truth = null } = {}) {
  const ids = [...new Set(telegramIds.map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return { users: 0, raised: 0 };
  const known = truth || await readSpendTruth(ids, { purchaseModel });
  const result = await userModel.collection.bulkWrite(raiseOps(ids.map((id) => [id, known.get(id)])), { ordered: false });
  return { users: ids.length, raised: result.modifiedCount };
}

export const recomputeUserSpend = (telegramId, deps) => recomputeUsersSpend([telegramId], deps);

/**
 * Compare stored counters with the truth for the given user documents, repair under-counts and missing
 * counters (raise only) and REPORT over-counts without touching them.
 * @param {Array<{telegramId:string,totalSpent?:any,completedOrderCount?:any}>} users
 */
export async function reconcileUserSpend(users, { userModel = User, purchaseModel = WalletPurchase, sampleLimit = 20 } = {}) {
  const rows = users.filter((user) => user?.telegramId);
  const truth = await readSpendTruth(rows.map((user) => user.telegramId), { purchaseModel });
  const counts = { checked: rows.length, ok: 0, missing: 0, under: 0, over: 0, repaired: 0, overSamples: [] };
  const toRaise = [];
  for (const user of rows) {
    const id = String(user.telegramId);
    const expected = truth.get(id);
    const verdict = classifySpend(user, expected);
    counts[verdict] += 1;
    if (verdict === "missing" || verdict === "under") toRaise.push([id, expected]);
    if (verdict === "over" && counts.overSamples.length < sampleLimit) {
      counts.overSamples.push({ telegramId: id, stored: { totalSpent: user.totalSpent ?? null, completedOrderCount: user.completedOrderCount ?? null }, truth: expected });
    }
  }
  if (toRaise.length) {
    const result = await userModel.collection.bulkWrite(raiseOps(toRaise), { ordered: false });
    counts.repaired = result.modifiedCount;
  }
  return counts;
}

// ── Best-effort hook after a purchase becomes "completed" ───────────────────────────────────────────────────

const MAX_IN_FLIGHT = 1_000;
const inFlight = new Map(); // telegramId -> { promise, dirty }
const hookStats = { scheduled: 0, succeeded: 0, failed: 0, skipped: 0, coalesced: 0, dropped: 0, lastFailureAt: null };

export const getUserSpendHookStats = () => ({ ...hookStats, inFlight: inFlight.size });

async function runHook(telegramId, deps, timeoutMs) {
  const entry = inFlight.get(telegramId);
  try {
    for (;;) {
      entry.dirty = false;
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("user spend recompute timed out")), timeoutMs); timer.unref?.(); });
      try {
        await Promise.race([recomputeUserSpend(telegramId, deps), timeout]);
      } finally { clearTimeout(timer); }
      hookStats.succeeded += 1;
      if (!entry.dirty) break; // a completion arrived while this read was running: read again
    }
  } catch (error) {
    hookStats.failed += 1;
    hookStats.lastFailureAt = new Date().toISOString();
    log("warn", "Post-completion spend recompute failed; the sweeper will repair it", { errorType: error?.name || "Error" });
  } finally {
    inFlight.delete(telegramId);
  }
}

/**
 * Called after a purchase has been committed as completed. Fire-and-forget: it returns immediately, never
 * throws, never rejects and never delays the caller. A lost or failed recompute only leaves the counters stale
 * until the sweeper runs. Models that cannot aggregate (test doubles) are skipped silently.
 */
export function scheduleUserSpendRecompute(telegramId, { userModel = User, purchaseModel = WalletPurchase, env = process.env, timeoutMs = 5_000 } = {}) {
  try {
    const id = String(telegramId ?? "");
    if (!id || !userSpendHookEnabled(env)) { hookStats.skipped += 1; return; }
    if (typeof purchaseModel?.aggregate !== "function" || typeof userModel?.collection?.bulkWrite !== "function") { hookStats.skipped += 1; return; }
    const running = inFlight.get(id);
    if (running) { running.dirty = true; hookStats.coalesced += 1; return; }
    if (inFlight.size >= MAX_IN_FLIGHT) { hookStats.dropped += 1; return; }
    hookStats.scheduled += 1;
    const entry = { promise: null, dirty: false };
    inFlight.set(id, entry);
    entry.promise = new Promise((resolve) => setImmediate(resolve)).then(() => runHook(id, { userModel, purchaseModel }, timeoutMs));
  } catch {
    hookStats.failed += 1; // scheduling itself must never affect the caller
  }
}

/** Test helper: resolves when every scheduled recompute has finished. */
export async function flushUserSpendRecomputesForTests() {
  while (inFlight.size) await Promise.all([...inFlight.values()].map((entry) => entry.promise));
}

// ── Gate for the persisted ranking ──────────────────────────────────────────────────────────────────────────

/** How long a readiness answer is reused. A newly detected problem is therefore acted on within this time. */
export const READINESS_CACHE_MS = 30_000;
/** The sweeper must have completed a fully successful tick (both phases) within this long. It ticks every 2 minutes. */
export const SWEEPER_MAX_AGE_MS = 15 * 60_000;
/**
 * The last completed reconcile pass must have finished within max(PASS_MAX_AGE_FLOOR_MS, PASS_MAX_AGE_FACTOR x that
 * pass's own duration). A pass takes about users / 1000 ticks (about an hour at 30k users), and healthy passes run
 * back to back, so 3x leaves room for slow ticks while a stopped sweeper is noticed.
 */
export const PASS_MAX_AGE_FLOOR_MS = 6 * 60 * 60_000;
export const PASS_MAX_AGE_FACTOR = 3;
/** Checkpoint timestamps may be this far ahead of this process's clock (clock skew) before they are called inconsistent. */
export const CHECKPOINT_CLOCK_TOLERANCE_MS = 5 * 60_000;

let readinessCache = null; // { until, value }
/** Drops the cached readiness answer now (the sweeper calls this when it records a failure or a discrepancy). */
export function invalidatePersistedSpendSortCache() { readinessCache = null; }
export const resetPersistedSpendSortCacheForTests = invalidatePersistedSpendSortCache;

const asTime = (value) => (value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null);
const isCount = (value) => Number.isFinite(value) && value >= 0;

/**
 * Pure decision over the two checkpoint documents. Everything must hold, otherwise the aggregate is used:
 *  1. the verification marker is ok and consistent (no missing / over / unexplained under-counts recorded);
 *  2. the sweeper has a checkpoint and a fully successful tick within SWEEPER_MAX_AGE_MS (and not in the future);
 *  3. no failure is outstanding: overall, scan-phase and reconcile-phase consecutive failures are all 0;
 *  4. at least one reconcile pass has completed, recently enough (PASS_MAX_AGE_*);
 *  5. neither the last completed pass nor the pass in progress reported missing counters, under-counts or over-counts.
 * Missing, malformed or internally inconsistent checkpoint data is "not ready", never "ready by default".
 * @returns {{value:{ready:boolean,reason:string}, validUntil:number}} validUntil: when a "ready" answer stops being true by age
 */
export function evaluatePersistedSpendReadiness(verifyDoc, sweeperDoc, nowMs) {
  const no = (reason) => ({ value: { ready: false, reason }, validUntil: 0 });
  const verified = verifyDoc?.state;
  if (!verified || verified.ok !== true || asTime(verified.verifiedAt) === null) return no("not_verified");
  if ([verified.missing, verified.over, verified.unexplainedUnder].some((n) => n !== undefined && n !== 0)) return no("verification_inconsistent");

  const sweeper = sweeperDoc?.state;
  if (!sweeper || typeof sweeper !== "object") return no("sweeper_not_running");
  const successAt = asTime(sweeper.lastSuccessAt);
  if (successAt === null) return no("sweeper_not_running");
  if (successAt > nowMs + CHECKPOINT_CLOCK_TOLERANCE_MS) return no("checkpoint_inconsistent");
  if (nowMs - successAt > SWEEPER_MAX_AGE_MS) return no("sweeper_stale");

  const failureCounters = [sweeper.consecutiveFailures, sweeper.scanConsecutiveFailures, sweeper.reconcileConsecutiveFailures];
  if (failureCounters.some((n) => n !== undefined && !isCount(n))) return no("checkpoint_inconsistent");
  if (failureCounters.some((n) => n > 0)) return no("sweeper_failing");

  const complete = (pass) => pass && typeof pass === "object" && ["missing", "under", "over"].every((key) => isCount(pass[key]));
  const inProgress = sweeper.pass;
  if (inProgress !== undefined && inProgress !== null && !complete(inProgress)) return no("checkpoint_inconsistent");
  const last = sweeper.lastPass;
  if (!last) return no("no_completed_pass");
  const startedAt = asTime(last.startedAt);
  const finishedAt = asTime(last.finishedAt);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt || finishedAt > nowMs + CHECKPOINT_CLOCK_TOLERANCE_MS || !complete(last)) return no("checkpoint_inconsistent");
  const passMaxAge = Math.max(PASS_MAX_AGE_FLOOR_MS, PASS_MAX_AGE_FACTOR * (finishedAt - startedAt));
  if (nowMs - finishedAt > passMaxAge) return no("pass_stale");

  const dirty = (pass) => pass.missing + pass.under + pass.over > 0;
  if (dirty(last) || (inProgress && dirty(inProgress))) return no("sweeper_found_discrepancies");
  return { value: { ready: true, reason: "verified" }, validUntil: Math.min(successAt + SWEEPER_MAX_AGE_MS, finishedAt + passMaxAge) };
}

/**
 * Whether the persisted ranking may be used right now: requested (USER_SPEND_SORT=persisted) AND
 * evaluatePersistedSpendReadiness() passes. Any doubt, including an unreadable checkpoint, keeps the aggregate.
 * A "ready" answer is cached for at most READINESS_CACHE_MS and never past the moment it stops being fresh
 * (validUntil), so a failure that appears in the checkpoint disables the persisted ranking within that time on
 * every process, and immediately on the process that observed it.
 * @returns {Promise<{ready:boolean, reason:string}>}
 */
export async function persistedSpendSortStatus({ env = process.env, checkpointModel = JobCheckpoint, now = Date.now(), cacheMs = READINESS_CACHE_MS } = {}) {
  if (!persistedSpendSortRequested(env)) return { ready: false, reason: "not_requested" };
  if (cacheMs > 0 && readinessCache && now < readinessCache.until) return readinessCache.value;
  let decision;
  try {
    const [verify, sweeper] = await Promise.all([readCheckpoint(checkpointModel, SPEND_VERIFY_JOB), readCheckpoint(checkpointModel, SPEND_SWEEPER_JOB)]);
    decision = evaluatePersistedSpendReadiness(verify, sweeper, now);
  } catch {
    decision = { value: { ready: false, reason: "readiness_unavailable" }, validUntil: 0 };
  }
  const { value, validUntil } = decision;
  readinessCache = { until: value.ready ? Math.min(now + cacheMs, validUntil) : now + cacheMs, value };
  if (!value.ready) log("warn", "USER_SPEND_SORT=persisted ignored; using the aggregate ranking", { reason: value.reason });
  return value;
}

export async function usePersistedSpendSort(options) {
  return (await persistedSpendSortStatus(options)).ready;
}
