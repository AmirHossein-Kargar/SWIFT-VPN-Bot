import { randomUUID } from "node:crypto";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireCronLock, releaseCronLock } from "./verifyLock.js";
import { startRedisLeaseHeartbeat } from "../redisLease.js";
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import { recoverWalletPurchases } from "../buyService/purchaseLedger.js";
import { recoverTestServiceAttempts } from "../createTestService.js";

const INTERVAL_MS = 5 * 60_000;
const EXPIRY_GRACE_MINUTES = 35;
const RECONCILE_MINUTES = 10;
const BATCH_SIZE = 50;
const CRON_JOB_NAME = "hooshpay-recovery";
const CRON_LOCK_TTL_SECONDS = 900;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay-cron", level, message, ...meta })
  );
}

let cronTimer = null;
let activeCycle = false;

export function startHooshpayRecoveryCron(bot) {
  if (cronTimer) return;
  void runCycle(bot);
  cronTimer = setInterval(() => { void runCycle(bot); }, INTERVAL_MS);
  cronTimer.unref?.();
  log("info", "Recovery and expiry cron started", { pid: process.pid });
}

export function stopHooshpayRecoveryCron() {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = null;
  log("info", "Recovery and expiry cron stopped", { pid: process.pid });
}

async function runCycle(bot) {
  if (activeCycle) return;
  activeCycle = true;
  const lease = await acquireCronLock(CRON_JOB_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lease) {
    activeCycle = false;
    return;
  }

  const cycleId = randomUUID();
  const leaseState = { healthy: true };
  const stopHeartbeat = startRedisLeaseHeartbeat(lease, {
    ttlSeconds: CRON_LOCK_TTL_SECONDS,
    intervalMs: 60_000,
    onLost: async (error) => {
      leaseState.healthy = false;
      log("error", "Cron lease was lost; stopping the current cycle", { cycleId, errorType: error?.name || "RedisError" });
    },
  });

  try {
    await recoverStuckInvoices(bot, cycleId, leaseState);
    if (leaseState.healthy) await recoverWalletPurchases(bot);
    if (leaseState.healthy) await recoverTestServiceAttempts(bot);
    if (leaseState.healthy) await reconcilePendingInvoices(bot, cycleId, leaseState);
    if (leaseState.healthy) await expireStaleInvoices(cycleId);
    log("info", "Recovery cycle complete", { cycleId, leaseHealthy: leaseState.healthy });
  } catch (error) {
    log("error", "Recovery cycle failed", {
      cycleId, errorType: error?.name || "Error",
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
    });
  } finally {
    stopHeartbeat();
    await releaseCronLock(lease);
    activeCycle = false;
  }
}

async function recoverStuckInvoices(bot, cycleId, leaseState) {
  const stuck = await HooshPayInvoice.find({
    status: "paid",
    $or: [
      { creditLedgerVersion: 2, balanceCredited: false },
      { creditLedgerVersion: 2, notificationPending: true },
    ],
  }).limit(BATCH_SIZE).lean();

  if (!stuck.length) return;
  log("warn", "Recovering HooshPay invoices with versioned wallet ledger or pending notification", {
    cycleId, count: stuck.length,
  });

  for (const invoice of stuck) {
    if (!leaseState.healthy) break;
    try {
      await fulfillHooshOrder({
        invoice,
        bot,
        chatId: invoice.userId,
        correlationId: randomUUID(),
      });
    } catch (error) {
      log("error", "Invoice recovery failed", {
        cycleId, uid: invoice.uid, errorType: error?.name || "Error",
        code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
      });
    }
  }
}

function verifyAmountMatches(invoice, result) {
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  if (data?.uid != null && String(data.uid) !== String(invoice.uid)) return false;
  if (data?.amount != null && (!Number.isSafeInteger(Number(data.amount)) || Number(data.amount) !== Number(invoice.amount))) return false;
  if (data?.merchant_credit != null && invoice.merchantCredit != null && Number(data.merchant_credit) !== Number(invoice.merchantCredit)) return false;
  return true;
}

async function reconcilePendingInvoices(bot, cycleId, leaseState) {
  const cutoff = new Date(Date.now() - RECONCILE_MINUTES * 60_000);
  const pending = await HooshPayInvoice.find({
    status: "pending",
    createdAt: { $lt: cutoff },
    fulfilled: false,
  }).sort({ createdAt: 1 }).limit(BATCH_SIZE).lean();
  if (!pending.length) return;

  log("info", "Reconciling pending HooshPay invoices", { cycleId, count: pending.length });
  for (const invoice of pending) {
    if (!leaseState.healthy) break;
    try {
      const result = await apiVerify(invoice.uid);
      const status = String(result.status ?? result.data?.status ?? "").toLowerCase();
      const paid = result.paid === true || status === "paid";
      if (paid) {
        if (!verifyAmountMatches(invoice, result)) {
          log("error", "HooshPay verification did not match local invoice", { cycleId, uid: invoice.uid });
          continue;
        }
        const trackingCode = result.data?.tracking_code ?? result.tracking_code;
        if (typeof trackingCode === "string" && trackingCode.length <= 128) {
          await HooshPayInvoice.findOneAndUpdate(
            { _id: invoice._id, status: "pending", fulfilled: false },
            { $set: { trackingCode } }
          );
        }
        await fulfillHooshOrder({
          invoice,
          bot,
          chatId: invoice.userId,
          correlationId: randomUUID(),
          paidAt: result.data?.paid_at ?? result.paid_at,
        });
      } else if (["expired", "cancelled", "failed"].includes(status)) {
        await HooshPayInvoice.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false },
          { $set: { status } }
        );
      }
    } catch (error) {
      log("warn", "Pending invoice verification failed", {
        cycleId, uid: invoice.uid, errorType: error?.name || "HooshPayApiError",
        code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
      });
    }
  }
}

async function expireStaleInvoices(cycleId) {
  const now = new Date();
  const createdCutoff = new Date(now.getTime() - EXPIRY_GRACE_MINUTES * 60_000);
  const result = await HooshPayInvoice.updateMany(
    {
      status: "pending",
      fulfilled: false,
      $or: [
        { expiresAt: { $lte: now } },
        { expiresAt: null, createdAt: { $lt: createdCutoff } },
      ],
    },
    { $set: { status: "expired" } }
  );
  if (result.modifiedCount) log("info", "Expired stale HooshPay invoices", { cycleId, count: result.modifiedCount });
}
