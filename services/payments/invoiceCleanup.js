import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { observeJob } from "../reliability/telemetry.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import PaymentTombstone from "../../models/PaymentTombstone.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";

/**
 * 24h cleanup of definitively cancelled / failed invoices.
 *
 * What is deleted: the invoice document itself (and therefore its admin-panel
 * row). What is kept: an immutable PaymentTombstone (provider, orderId, uid /
 * invoiceId / paymentId, user, amount, final status, timestamps), plus - by
 * construction, because they live elsewhere - the user's wallet idempotency
 * ledgers (User.appliedPaymentKeys etc.), purchase/ledger records and the admin
 * audit log. Nothing here touches those.
 *
 * What is NEVER eligible: pending/creating rows, paid/finished, partially paid,
 * refunded/reversed, expired, creation_failed, anything credited or fulfilled,
 * anything flagged for manual recovery, and (NOWPayments) anything with funds
 * actually received. Only `cancelled`/`failed` (HooshPay) and `failed`
 * (NOWPayments) qualify, 24h after the invoice FIRST entered that state.
 */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BATCH_SIZE = 200;
export const DEFAULT_MAX_BATCHES = 25;
const LEASE_KEY = "lock:invoice-cleanup";
const LEASE_TTL_SECONDS = 300;

export const CLEANUP_RULES = Object.freeze([
  {
    provider: "hooshpay",
    model: HooshPayInvoice,
    statuses: ["cancelled", "failed"],
    extraFilter: { fulfilled: { $ne: true }, balanceCredited: { $ne: true }, recoveryStatus: { $ne: "required" } },
    tombstoneFields: (doc) => ({ uid: doc.uid || null, amountToman: Number.isFinite(doc.amount) ? doc.amount : null }),
  },
  {
    provider: "nowpayments",
    model: NowPaymentsInvoice,
    statuses: ["failed"],
    extraFilter: { balanceCredited: { $ne: true }, recoveryStatus: { $ne: "required" }, actuallyPaid: { $in: [null, 0] } },
    tombstoneFields: (doc) => ({
      invoiceId: doc.invoiceId || null,
      paymentId: doc.paymentId || null,
      amountToman: Number.isFinite(doc.amountToman) ? doc.amountToman : null,
    }),
  },
]);

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "invoice-cleanup", level, message, ...meta }),
  );
}

function eligibleFilter(rule, cutoff) {
  return {
    status: { $in: rule.statuses },
    terminalStatusAt: { $type: "date", $lte: cutoff },
    ...rule.extraFilter,
  };
}

/**
 * @returns {Promise<{dryRun:boolean, cutoff:Date, stamped:number, eligible:number, deleted:number, tombstoned:number, byProvider:object}>}
 */
export async function runInvoiceCleanupBatches({
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  maxBatches = DEFAULT_MAX_BATCHES,
  dryRun = false,
  rules = CLEANUP_RULES,
  tombstoneModel = PaymentTombstone,
} = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const summary = { dryRun, cutoff, stamped: 0, eligible: 0, deleted: 0, tombstoned: 0, byProvider: {} };

  for (const rule of rules) {
    const stats = { stamped: 0, eligible: 0, deleted: 0 };
    summary.byProvider[rule.provider] = stats;

    // Rows that reached a terminal state before the stamp existed (or whose
    // stamp is missing / not a date) start their 24h clock the first time they
    // are seen. This never resets a valid stamp.
    if (!dryRun) {
      const stamped = await rule.model.updateMany(
        { status: { $in: rule.statuses }, terminalStatusAt: { $not: { $type: "date" } } },
        { $set: { terminalStatusAt: now } },
      );
      stats.stamped = Number(stamped?.modifiedCount ?? stamped?.nModified ?? 0);
      summary.stamped += stats.stamped;
    }

    const filter = eligibleFilter(rule, cutoff);
    if (dryRun) {
      stats.eligible = await rule.model.countDocuments(filter);
      summary.eligible += stats.eligible;
      continue;
    }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const docs = await rule.model.find(filter).sort({ terminalStatusAt: 1, _id: 1 }).limit(batchSize).lean();
      if (!docs.length) break;
      stats.eligible += docs.length;
      let progressed = 0;
      for (const doc of docs) {
        const orderId = String(doc.orderId || "");
        if (!orderId) continue;
        try {
          await tombstoneModel.updateOne(
            { provider: rule.provider, orderId },
            {
              $setOnInsert: {
                provider: rule.provider,
                orderId,
                userId: Number.isFinite(doc.userId) ? doc.userId : null,
                finalStatus: doc.status,
                invoiceCreatedAt: doc.createdAt || null,
                terminalStatusAt: doc.terminalStatusAt,
                ...rule.tombstoneFields(doc),
              },
            },
            { upsert: true },
          );
        } catch (error) {
          if (error?.code !== 11000) throw error; // a concurrent worker already wrote it
        }
        summary.tombstoned += 1;
        // Conditional delete: only if the row is STILL eligible. A status that
        // changed meanwhile (credited, flagged, ...) keeps the invoice.
        const removed = await rule.model.deleteOne({ _id: doc._id, ...filter });
        if (Number(removed?.deletedCount || 0) > 0) {
          stats.deleted += 1;
          progressed += 1;
          await tombstoneModel.updateOne({ provider: rule.provider, orderId, deletedAt: null }, { $set: { deletedAt: now } });
        }
      }
      summary.deleted += progressed;
      if (progressed === 0) break; // nothing left that can be removed; avoid spinning
    }
  }
  return summary;
}

/** Cluster-safe entry point: only one instance runs a cleanup at a time. */
export async function runInvoiceCleanup(options = {}) {
  const acquire = options.acquireLease || acquireRedisLease;
  const release = options.releaseLease || releaseRedisLease;
  let lease = null;
  try {
    lease = await acquire(LEASE_KEY, LEASE_TTL_SECONDS);
  } catch {
    lease = null;
  }
  if (!lease && !options.allowWithoutLease) {
    log("warn", "Cleanup skipped: lease unavailable (another instance running or Redis down)");
    return { skipped: true, reason: "lease_unavailable" };
  }
  try {
    const summary = await runInvoiceCleanupBatches(options);
    log("info", "Invoice cleanup finished", {
      dryRun: summary.dryRun, stamped: summary.stamped, eligible: summary.eligible, deleted: summary.deleted,
    });
    return summary;
  } finally {
    if (lease) await release(lease).catch(() => {});
  }
}

let timer = null;
export function startInvoiceCleanupCron({ intervalMs = 60 * 60 * 1000, run = runInvoiceCleanup } = {}) {
  if (timer) return timer;
  const tick = () => run()
    .then((summary) => { observeJob("invoice-cleanup", { ok: true, skipped: summary?.skipped ? summary.reason : null }); return summary; })
    .catch((error) => { observeJob("invoice-cleanup", { ok: false }); log("error", "Invoice cleanup failed", { errorType: error?.name || "Error" }); });
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
  return timer;
}

export function stopInvoiceCleanupCron() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Called by webhook handlers when a notification references an unknown invoice. */
export async function findTombstone({ provider, orderId = null, uid = null, invoiceId = null, paymentId = null, tombstoneModel = PaymentTombstone }) {
  const or = [];
  if (orderId) or.push({ orderId });
  if (uid) or.push({ uid });
  if (invoiceId) or.push({ invoiceId });
  if (paymentId) or.push({ paymentId });
  if (!or.length) return null;
  return tombstoneModel.findOne({ provider, $or: or }).lean();
}

/** Records a late notification on the tombstone (bounded). Never credits anything. */
export async function recordLateEvent({ tombstone, status, tombstoneModel = PaymentTombstone, now = new Date() }) {
  if (!tombstone?._id) return false;
  await tombstoneModel.updateOne(
    { _id: tombstone._id },
    {
      $inc: { lateEventCount: 1 },
      $push: { lateEvents: { $each: [{ receivedAt: now, status: String(status || "").slice(0, 40) || null }], $slice: -10 } },
    },
  );
  return true;
}

export default { runInvoiceCleanup, runInvoiceCleanupBatches, startInvoiceCleanupCron, stopInvoiceCleanupCron, findTombstone, recordLateEvent, RETENTION_MS };
