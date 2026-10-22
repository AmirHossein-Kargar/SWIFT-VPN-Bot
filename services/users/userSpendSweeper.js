/**
 * Sweeper that keeps User.totalSpent / completedOrderCount converged with WalletPurchase (see userSpend.js).
 * It is a SEPARATE job (not part of the HooshPay recovery cron) with its own lease, checkpoint and failure
 * isolation. It only raises counters; it never touches balances, purchase status or any ledger.
 *
 * Two independent mechanisms, with different jobs:
 *
 *  Phase A — recent completions (latency optimisation, NOT the correctness mechanism).
 *    Scans WalletPurchase {status:"completed", completedAt >= from} through idx_wallet_purchase_completed_at in
 *    keyset pages (completedAt, _id) and recomputes the owners. A scan starts at `watermarkAt - lookbackMs`,
 *    where watermarkAt is the DATABASE time at which the previous scan STARTED, and watermarkAt is advanced
 *    only after that scan has processed every page. Consequences:
 *      - a crash, restart, lost lease or failed batch leaves the checkpoint untouched, so the same window is
 *        scanned again (reruns are idempotent);
 *      - the watermark never depends on the data (no max(completedAt)), so a future-dated or skewed completedAt
 *        cannot push it forward, and the scan is open-ended upwards so such rows are simply seen early;
 *      - a purchase written at database time W with completedAt = W - d (write delay and/or clock skew d) is
 *        covered by the first scan that starts after W provided d <= lookbackMs, because the previous scan
 *        started at s <= W and scanned from s - lookbackMs <= W - lookbackMs <= completedAt;
 *      - a scan too large for one tick resumes from its stored keyset cursor on the next tick, with `from`
 *        fixed, so a backlog always makes progress and never restarts from scratch.
 *    A delay or skew beyond lookbackMs is NOT claimed to be covered here: phase B covers it.
 *
 *  Phase B — rolling reconcile (the correctness backstop, independent of every timestamp).
 *    Walks ALL users by _id in batches with a persisted cursor and wraps around. Every user is compared with the
 *    truth at least once per pass, whatever completedAt says. Under-counts and missing counters are raised;
 *    over-counts are counted and reported (samples kept in the checkpoint) and never lowered. So any completion
 *    that phase A missed for any reason is repaired within one pass (users / reconcileBatch ticks).
 *
 * Failure isolation: the phases are independent. A failure in either one is recorded under that phase's own
 * checkpoint keys (the scan... and reconcile... fields), leaves that phase's progress exactly where it was, and does NOT stop the
 * other phase from running in the same tick. The tick as a whole is reported healthy (lastSuccessAt,
 * consecutiveFailures = 0) only when every phase that ran succeeded; otherwise `summary.error` is set and
 * consecutiveFailures grows, which also switches the persisted ranking off (userSpend.js readiness).
 *
 * Duplicate execution: a MongoDB lease (jobLease.js) is acquired per tick, renewed before every page/batch and
 * released at the end; every checkpoint write is fenced by the lease, so a process that lost it cannot write.
 * Losing the lease aborts the WHOLE tick at once (neither the other phase nor any failure record is written).
 */
import { randomUUID } from "node:crypto";
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import JobCheckpoint from "../../models/JobCheckpoint.js";
import { acquireLease, databaseNow, readCheckpoint, releaseLease, renewLease, writeLeasedState } from "../jobLease.js";
import { SPEND_SWEEPER_JOB, invalidatePersistedSpendSortCache, recomputeUsersSpend, reconcileUserSpend, userSpendSweeperEnabled } from "./userSpend.js";
import { recordJobRun } from "../admin/monitoring.js";

export const SWEEPER_DEFAULTS = Object.freeze({
  intervalMs: 2 * 60_000,
  initialDelayMs: 30_000,
  leaseTtlMs: 2 * 60_000,
  lookbackMs: 15 * 60_000,
  initialWindowMs: 24 * 60 * 60_000, // first scan only: older history is the backfill's job
  pageSize: 500,
  userBatch: 100,
  maxPagesPerTick: 20,
  reconcileBatch: 1_000,
  sampleLimit: 20,
});

class LeaseLostError extends Error {
  constructor() { super("user spend sweeper lease was lost"); this.name = "LeaseLostError"; }
}

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "user-spend-sweeper", level, message, ...meta }),
  );
}

const toDate = (value) => (value instanceof Date ? value : new Date(value));

/**
 * One sweep. Returns a summary; never throws for ordinary failures (they are recorded in the checkpoint).
 * Options are injectable for tests: models, `serverNow` (Date | () => Date | Promise<Date>), sizes, and
 * `skipScan` / `skipReconcile` to run a single phase.
 */
export async function runUserSpendSweepTick(options = {}) {
  const config = { ...SWEEPER_DEFAULTS, ...options };
  const userModel = options.userModel || User;
  const purchaseModel = options.purchaseModel || WalletPurchase;
  const checkpointModel = options.checkpointModel || JobCheckpoint;
  const owner = options.owner || `${process.pid}:${randomUUID()}`;
  const summary = { skipped: null, error: null, scan: null, reconcile: null };

  const lease = await acquireLease(checkpointModel, SPEND_SWEEPER_JOB, owner, config.leaseTtlMs);
  if (!lease) return { ...summary, skipped: "lease_unavailable" };

  const ensureLease = async () => { if (!(await renewLease(checkpointModel, lease))) throw new LeaseLostError(); };
  const save = async (fields) => { if (!(await writeLeasedState(checkpointModel, lease, fields))) throw new LeaseLostError(); };
  const now = async () => {
    const value = typeof config.serverNow === "function" ? await config.serverNow() : config.serverNow;
    return value ? toDate(value) : databaseNow(checkpointModel);
  };

  try {
    const state = (await readCheckpoint(checkpointModel, SPEND_SWEEPER_JOB))?.state || {};
    const tickStart = await now();
    const deps = { userModel, purchaseModel };
    const failures = [];

    // Runs one phase in isolation: its failure is recorded under its own keys and does not stop the other phase.
    // A lost lease is the exception: it aborts the whole tick (rethrown to the outer handler, nothing is written).
    const runPhase = async (label, keys, run) => {
      try {
        const result = await run();
        await save({ set: { [keys.successAt]: tickStart, [keys.failures]: 0 }, unset: [keys.error] });
        return result;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        const name = String(error?.name || "Error").slice(0, 80);
        failures.push(name);
        await save({ set: { [keys.failures]: Number(state[keys.failures] || 0) + 1, [keys.failureAt]: new Date(), [keys.error]: name } });
        invalidatePersistedSpendSortCache();
        log("warn", `User spend sweeper ${label} phase failed; the other phase still runs`, { errorType: name });
        return { error: name };
      }
    };

    if (!options.skipScan) {
      summary.scan = await runPhase("scan", { successAt: "lastScanSuccessAt", failures: "scanConsecutiveFailures", failureAt: "lastScanFailureAt", error: "lastScanError" },
        () => scanRecentCompletions({ state, tickStart, config, deps, ensureLease, save }));
    }
    if (!options.skipReconcile) {
      summary.reconcile = await runPhase("reconcile", { successAt: "lastReconcileSuccessAt", failures: "reconcileConsecutiveFailures", failureAt: "lastReconcileFailureAt", error: "lastReconcileError" },
        () => reconcileNextBatch({ state, tickStart, config, deps, ensureLease, save }));
    }

    if (failures.length) {
      summary.error = failures[0];
      await save({ set: { consecutiveFailures: Number(state.consecutiveFailures || 0) + 1, lastFailureAt: new Date(), lastError: failures[0] } });
      invalidatePersistedSpendSortCache();
      return summary;
    }
    await save({ set: { lastSuccessAt: tickStart, consecutiveFailures: 0 }, unset: ["lastError"] });
    return summary;
  } catch (error) {
    summary.error = error?.name || "Error";
    if (!(error instanceof LeaseLostError)) {
      // An unexpected failure outside the phases (e.g. the checkpoint itself): recorded best-effort, retried next tick.
      const previous = (await readCheckpoint(checkpointModel, SPEND_SWEEPER_JOB).catch(() => null))?.state || {};
      await writeLeasedState(checkpointModel, lease, {
        set: { consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1, lastFailureAt: new Date(), lastError: String(error?.name || "Error").slice(0, 80) },
      }).catch(() => {});
      invalidatePersistedSpendSortCache();
    }
    log("warn", "User spend sweep failed; it will be retried", { errorType: summary.error });
    return summary;
  } finally {
    await releaseLease(checkpointModel, lease).catch(() => {});
  }
}

async function scanRecentCompletions({ state, tickStart, config, deps, ensureLease, save }) {
  const out = { pages: 0, rows: 0, users: 0, completed: false };
  let scan = state.scan || null;
  if (!scan) {
    const base = state.watermarkAt ? toDate(state.watermarkAt).getTime() : tickStart.getTime() - config.initialWindowMs;
    scan = { startedAt: tickStart, from: new Date(base - config.lookbackMs), cursorAt: null, cursorId: null };
    await save({ set: { scan } });
  }

  for (let page = 0; page < config.maxPagesPerTick; page += 1) {
    await ensureLease();
    const filter = { status: "completed" };
    if (scan.cursorAt) {
      filter.$or = [{ completedAt: { $gt: toDate(scan.cursorAt) } }, { completedAt: toDate(scan.cursorAt), _id: { $gt: scan.cursorId } }];
      filter.completedAt = { $gte: toDate(scan.from) };
    } else {
      filter.completedAt = { $gte: toDate(scan.from) };
    }
    const rows = await deps.purchaseModel.find(filter).sort({ completedAt: 1, _id: 1 }).limit(config.pageSize)
      .select("telegramId completedAt").lean().maxTimeMS(8_000);

    const owners = [...new Set(rows.map((row) => row.telegramId).filter(Boolean))];
    for (let i = 0; i < owners.length; i += config.userBatch) {
      await ensureLease();
      await recomputeUsersSpend(owners.slice(i, i + config.userBatch), deps);
    }
    out.pages += rows.length ? 1 : 0;
    out.rows += rows.length;
    out.users += owners.length;

    if (rows.length < config.pageSize) {
      // Every page up to the end was processed: only now may the watermark move (to when this scan STARTED).
      await save({ set: { watermarkAt: toDate(scan.startedAt), lastScanCompletedAt: tickStart }, unset: ["scan"] });
      out.completed = true;
      return out;
    }
    const last = rows[rows.length - 1];
    scan = { ...scan, cursorAt: last.completedAt, cursorId: String(last._id) };
    await save({ set: { "scan.cursorAt": scan.cursorAt, "scan.cursorId": scan.cursorId } });
  }
  return out; // budget used: the stored cursor resumes this scan on the next tick
}

async function reconcileNextBatch({ state, tickStart, config, deps, ensureLease, save }) {
  await ensureLease();
  const pass = state.pass || { startedAt: tickStart, users: 0, ok: 0, missing: 0, under: 0, over: 0, repaired: 0, overSamples: [] };
  const filter = state.reconcileCursor ? { _id: { $gt: state.reconcileCursor } } : {};
  const users = await deps.userModel.find(filter).sort({ _id: 1 }).limit(config.reconcileBatch)
    .select("telegramId totalSpent completedOrderCount").lean().maxTimeMS(8_000);

  const result = await reconcileUserSpend(users, { ...deps, sampleLimit: config.sampleLimit });
  const next = {
    startedAt: pass.startedAt,
    users: pass.users + result.checked,
    ok: pass.ok + result.ok,
    missing: pass.missing + result.missing,
    under: pass.under + result.under,
    over: pass.over + result.over,
    repaired: pass.repaired + result.repaired,
    overSamples: [...(pass.overSamples || []), ...result.overSamples].slice(0, config.sampleLimit),
  };
  if (result.over) log("warn", "User spend over-count detected (reported, not changed)", { count: result.over });
  if (result.over || result.under || result.missing) invalidatePersistedSpendSortCache();

  const finished = users.length < config.reconcileBatch;
  if (finished) {
    await save({ set: { lastPass: { ...next, finishedAt: tickStart }, reconcileCursor: null }, unset: ["pass"] });
  } else {
    await save({ set: { pass: next, reconcileCursor: String(users[users.length - 1]._id) } });
  }
  return { checked: result.checked, missing: result.missing, under: result.under, over: result.over, repaired: result.repaired, passCompleted: finished };
}

// ── Scheduling ──────────────────────────────────────────────────────────────────────────────────────────────

let timer = null;
let initialTimer = null;
let active = false;

export function startUserSpendSweeper({ env = process.env, run = runUserSpendSweepTick, intervalMs = SWEEPER_DEFAULTS.intervalMs, initialDelayMs = SWEEPER_DEFAULTS.initialDelayMs, ...options } = {}) {
  if (!userSpendSweeperEnabled(env)) {
    log("info", "User spend sweeper disabled by USER_SPEND_SWEEPER");
    return null;
  }
  if (timer) return timer;
  const tick = async () => {
    if (active) return; // never overlap within this process; other processes are excluded by the lease
    active = true;
    try {
      const summary = await run(options);
      recordJobRun("user-spend-sweeper", { ok: !summary?.error, meta: summary?.skipped ? { skipped: summary.skipped } : {} });
    } catch (error) {
      recordJobRun("user-spend-sweeper", { ok: false });
      log("error", "User spend sweeper tick crashed", { errorType: error?.name || "Error" });
    } finally {
      active = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  initialTimer = setTimeout(tick, initialDelayMs);
  initialTimer.unref?.();
  return timer;
}

export function stopUserSpendSweeper() {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}
