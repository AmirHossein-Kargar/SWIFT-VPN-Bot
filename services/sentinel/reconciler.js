/**
 * The reconciliation job. It decides WHICH customers to evaluate; rules.js decides what is wrong with them.
 *
 * Each tick evaluates a bounded set of customers:
 *   priority - owners of recent money records, of open exceptions found through the recovery indexes, and of open
 *              confirmed or probable findings (so a fixed problem clears quickly);
 *   rolling  - the next users by _id from a persisted cursor, wrapping around, so every wallet is reconciled once per
 *              pass however quiet it is.
 * No query scans a whole money collection, and a tick stops at its time budget with the cursor where it got to.
 *
 * Anything new is read a second time before it is stored: a writer caught between its two steps moves on, the finding
 * disappears from the second read, and no false alert is raised.
 *
 * Writes: SentinelFinding (findingsStore.js) and this job's JobCheckpoint row. Nothing else, on any path.
 */
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import JobCheckpoint from "../../models/JobCheckpoint.js";
import { acquireLease, readCheckpoint, releaseLease, renewLease, writeLeasedState } from "../jobLease.js";
import { recordJobRun } from "../admin/monitoring.js";
import { PAYMENT_PROVIDERS, SENTINEL_JOB, readSentinelConfig } from "./constants.js";
import { defaultSources } from "./readOnly.js";
import { loadBundles } from "./bundle.js";
import { evaluateBundle } from "./rules.js";
import { openFingerprints, syncFindings } from "./findingsStore.js";
import SentinelFinding from "../../models/SentinelFinding.js";

export const TICK_DEFAULTS = Object.freeze({
  leaseTtlMs: 3 * 60_000,
  budgetMs: 45_000,
  priorityUsers: 100,
  hotRowLimit: 200,
  recentWindowMs: 2 * 60 * 60_000,
  batchSize: 25,
  initialDelayMs: 45_000,
});

const QUERY_TIMEOUT_MS = 8_000;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "money-flow-sentinel", level, message, ...meta }),
  );
}

class LeaseLostError extends Error {
  constructor() { super("sentinel lease was lost"); this.name = "LeaseLostError"; }
}

const objectIdAt = (date) => mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
const timed = (query) => query.lean().maxTimeMS(QUERY_TIMEOUT_MS);

/** Owners worth looking at now. Every query here is served by an existing index or _id. */
export async function collectPriorityUsers({ sources, now, findingModel = SentinelFinding, limits = TICK_DEFAULTS }) {
  const hot = limits.hotRowLimit;
  const recentFrom = objectIdAt(new Date(now.getTime() - limits.recentWindowMs));
  const unsettled = [
    sources.hooshpay.find({ fulfilled: true, balanceCredited: false, status: "paid" }).select("userId").sort({ _id: -1 }).limit(hot),
    sources.nowpayments.find({ status: "finished", balanceCredited: false }).select("userId").limit(hot),
    sources.nowpayments.find({ status: "creation_unknown" }).select("userId").limit(hot),
    sources.bank.find({ status: "confirmed", balanceCredited: false }).select("userId").limit(hot),
    sources.trx.find({ status: "paid", balanceCredited: false }).select("userId").limit(hot),
    ...["hooshpay", "nowpayments", "bank", "trx"].map((provider) => sources[provider].find({ recoveryStatus: "required" }).select("userId").limit(hot)),
    ...Object.keys(PAYMENT_PROVIDERS).map((provider) => sources[provider].find({ _id: { $gte: recentFrom } }).select("userId").sort({ _id: -1 }).limit(hot)),
  ];
  const orders = [
    sources.purchases.find({ status: { $in: ["reserving", "reserved", "provisioning", "provisioned", "uncertain", "manual_review", "refund_pending", "awaiting_provider"] } }).select("telegramId").sort({ status: 1, createdAt: 1 }).limit(hot),
    sources.purchases.find({ _id: { $gte: recentFrom } }).select("telegramId").sort({ _id: -1 }).limit(hot),
  ];
  const [paymentRows, orderRows, tombstones, findings] = await Promise.all([
    Promise.all(unsettled.map((query) => timed(query))),
    Promise.all(orders.map((query) => timed(query))),
    timed(sources.tombstones.find({ lateEventCount: { $gt: 0 } }).select("userId").limit(hot)),
    timed(findingModel.find({ state: "open", classification: { $ne: "informational" } }).select("userId").sort({ lastCheckedAt: 1 }).limit(limits.priorityUsers)),
  ]);
  const active = new Set();
  for (const rows of paymentRows) for (const row of rows) if (row.userId != null) active.add(String(row.userId));
  for (const rows of orderRows) for (const row of rows) if (row.telegramId != null) active.add(String(row.telegramId));
  for (const row of tombstones) if (row.userId != null) active.add(String(row.userId));
  // Neither side can starve the other: open findings keep a share however busy the day is, and the reverse. Informational
  // findings wait for the rolling pass, so a large legacy backlog cannot crowd out live problems.
  const recheck = [...new Set(findings.map((row) => row.userId))].filter((id) => !active.has(id));
  const reserved = Math.floor(limits.priorityUsers / 3);
  const fromActive = [...active].slice(0, Math.max(limits.priorityUsers - Math.min(reserved, recheck.length), 0));
  return [...fromActive, ...recheck].slice(0, limits.priorityUsers);
}

/** Evaluate customers and store the result. New findings must survive a second, later read of the same customer. */
export async function evaluateUsers(userIds, { sources = defaultSources(), config, now = new Date(), batchSize = TICK_DEFAULTS.batchSize, findingModel = SentinelFinding } = {}) {
  const totals = { evaluated: 0, created: 0, updated: 0, unchanged: 0, reopened: 0, cleared: 0, deferred: 0 };
  if (!userIds.length) return totals;
  const ctx = { now, config };
  const bundles = await loadBundles(userIds, { sources, config, batchSize });
  const first = [...bundles.values()].flatMap((bundle) => evaluateBundle(bundle, ctx));
  const known = await openFingerprints(userIds, { model: findingModel });
  const fresh = first.filter((finding) => !known.has(finding.fingerprint));
  let confirmed = first;
  if (fresh.length) {
    const recheck = await loadBundles([...new Set(fresh.map((finding) => finding.userId))], { sources, config, batchSize });
    const again = new Set([...recheck.values()].flatMap((bundle) => evaluateBundle(bundle, ctx)).map((finding) => finding.fingerprint));
    confirmed = first.filter((finding) => known.has(finding.fingerprint) || again.has(finding.fingerprint));
    totals.deferred = first.length - confirmed.length;
  }
  const summary = await syncFindings({ userIds, findings: confirmed, now, model: findingModel });
  return { ...totals, ...summary, deferred: totals.deferred, evaluated: bundles.size };
}

/** One bounded pass. Returns a summary; ordinary failures are recorded in the checkpoint, not thrown. */
export async function runSentinelTick(options = {}) {
  const config = options.config || readSentinelConfig();
  const limits = { ...TICK_DEFAULTS, ...options };
  const sources = options.sources || defaultSources();
  const checkpointModel = options.checkpointModel || JobCheckpoint;
  const findingModel = options.findingModel || SentinelFinding;
  const clock = options.now || (() => new Date());
  const owner = options.owner || `${process.pid}:${randomUUID()}`;
  const summary = { skipped: null, error: null, priority: 0, rolling: 0, evaluated: 0, created: 0, updated: 0, reopened: 0, cleared: 0, deferred: 0, wrapped: false };

  const lease = await acquireLease(checkpointModel, SENTINEL_JOB, owner, limits.leaseTtlMs);
  if (!lease) return { ...summary, skipped: "lease_unavailable" };

  const startedAt = clock();
  const deadline = startedAt.getTime() + limits.budgetMs;
  const ensureLease = async () => { if (!(await renewLease(checkpointModel, lease))) throw new LeaseLostError(); };
  const save = async (fields) => { if (!(await writeLeasedState(checkpointModel, lease, fields))) throw new LeaseLostError(); };
  const add = (result) => {
    for (const field of ["evaluated", "created", "updated", "reopened", "cleared", "deferred"]) summary[field] += result[field] || 0;
  };

  try {
    const state = (await readCheckpoint(checkpointModel, SENTINEL_JOB))?.state || {};
    const done = new Set();
    try {
      const priority = options.userIds || await collectPriorityUsers({ sources, now: startedAt, findingModel, limits });
      summary.priority = priority.length;
      for (let index = 0; index < priority.length; index += limits.batchSize) {
        if (Date.now() > deadline) break;
        await ensureLease();
        const page = priority.slice(index, index + limits.batchSize);
        add(await evaluateUsers(page, { sources, config, now: clock(), batchSize: limits.batchSize, findingModel }));
        for (const id of page) done.add(id);
      }

      let cursor = state.cursor || null;
      let passUsers = Number(state.passUsers || 0);
      let lastPassCompletedAt = state.lastPassCompletedAt || null;
      if (!options.userIds) {
        const filter = cursor ? { _id: { $gt: new mongoose.Types.ObjectId(cursor) } } : {};
        const users = await timed(sources.users.find(filter).select("telegramId").sort({ _id: 1 }).limit(config.usersPerTick));
        summary.rolling = users.length;
        for (let index = 0; index < users.length; index += limits.batchSize) {
          if (Date.now() > deadline) break;
          const page = users.slice(index, index + limits.batchSize);
          await ensureLease();
          add(await evaluateUsers(page.map((user) => String(user.telegramId)).filter((id) => !done.has(id)), { sources, config, now: clock(), batchSize: limits.batchSize, findingModel }));
          cursor = String(page[page.length - 1]._id);
          passUsers += page.length;
        }
        if (users.length < config.usersPerTick && Date.now() <= deadline) {
          cursor = null;
          lastPassCompletedAt = clock();
          passUsers = 0;
          summary.wrapped = true;
        }
      }

      const finishedAt = clock();
      await save({
        set: {
          ...(options.userIds ? {} : { cursor, passUsers, lastPassCompletedAt }),
          lastTickAt: finishedAt,
          lastSuccessAt: finishedAt,
          consecutiveFailures: 0,
          lastTrigger: options.trigger || "cron",
          lastSummary: { priority: summary.priority, rolling: summary.rolling, evaluated: summary.evaluated, created: summary.created, cleared: summary.cleared },
        },
        unset: ["lastError"],
      });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      const name = String(error?.name || "Error").slice(0, 80);
      summary.error = name;
      await save({ set: { lastTickAt: clock(), lastError: name, consecutiveFailures: Number(state.consecutiveFailures || 0) + 1 } });
      log("warn", "Sentinel tick failed; money records were not touched", { errorType: name });
    }
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
    summary.error = "LeaseLostError";
    summary.skipped = "lease_lost";
  } finally {
    await releaseLease(checkpointModel, lease).catch(() => {});
  }
  return summary;
}

let timer = null;
let initialTimer = null;
let active = false;

export async function runGuardedTick(options = {}) {
  if (active) return { skipped: "already_running" };
  active = true;
  try {
    const summary = await runSentinelTick(options);
    recordJobRun("money-flow-sentinel", { ok: !summary.error, meta: summary.skipped ? { skipped: summary.skipped } : {} });
    return summary;
  } catch (error) {
    recordJobRun("money-flow-sentinel", { ok: false });
    log("error", "Sentinel tick crashed", { errorType: error?.name || "Error" });
    throw error;
  } finally {
    active = false;
  }
}

export function startSentinelCron({ env = process.env } = {}) {
  const config = readSentinelConfig(env);
  if (!config.enabled || timer) return false;
  const tick = () => { runGuardedTick({ config }).catch(() => {}); };
  timer = setInterval(tick, config.intervalMs);
  timer.unref?.();
  initialTimer = setTimeout(tick, TICK_DEFAULTS.initialDelayMs);
  initialTimer.unref?.();
  return true;
}

export function stopSentinelCron() {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}
