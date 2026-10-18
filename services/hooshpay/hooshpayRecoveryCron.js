import { randomUUID } from "node:crypto";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireCronLock, releaseCronLock } from "./verifyLock.js";
import { startRedisLeaseHeartbeat } from "../redisLease.js";
import { verifyInvoice as apiVerify } from "./hooshpayClient.js";
import { recoverWalletPurchases } from "../buyService/purchaseLedger.js";
import { recoverTestServiceAttempts } from "../createTestService.js";
import { recordJobRun } from "../admin/monitoring.js";
import {
  HOOSH_TERMINAL_NONPAYABLE,
  hooshProviderData,
  normalizeHooshStatus,
  validateHooshPaidDetails,
} from "./paymentValidation.js";

const INTERVAL_MS = 5 * 60_000;
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
  log("info", "Recovery and provider-reconciliation cron started", { pid: process.pid });
}

export function stopHooshpayRecoveryCron() {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = null;
  log("info", "Recovery and provider-reconciliation cron stopped", { pid: process.pid });
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
    log("info", "Recovery cycle complete", { cycleId, leaseHealthy: leaseState.healthy });
    recordJobRun("hooshpay-recovery-cron", { ok: true, meta: { cycleId } });
  } catch (error) {
    log("error", "Recovery cycle failed", {
      cycleId, errorType: error?.name || "Error",
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
    });
    recordJobRun("hooshpay-recovery-cron", { ok: false, meta: { cycleId } });
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
      const data = hooshProviderData(result);
      const status = normalizeHooshStatus(data.status);
      const paidFlag = result?.paid ?? data.paid;
      const paid = status === "paid" && paidFlag !== false;
      if (paid) {
        const mismatch = validateHooshPaidDetails(invoice, data, {
          requireUid: true,
          requireOrderId: true,
          requireCurrency: true,
        });
        if (mismatch) {
          log("error", "HooshPay verification did not match local invoice", { cycleId, uid: invoice.uid, reason: mismatch });
          continue;
        }
        const trackingCode = data.tracking_code;
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
          paidAt: data.paid_at,
        });
      } else if (HOOSH_TERMINAL_NONPAYABLE.includes(status)) {
        const closed = await HooshPayInvoice.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false, balanceCredited: false },
          { $set: { status } },
          { new: true },
        );
        if (!closed) {
          await HooshPayInvoice.findOneAndUpdate(
            { _id: invoice._id, status: "paid" },
            { $set: { recoveryStatus: "required", recoveryReason: `provider_${status}_after_payment_claim` } },
          );
        }
      } else if (status === "reversed") {
        const reversed = await HooshPayInvoice.findOneAndUpdate(
          { _id: invoice._id, status: "pending", fulfilled: false, balanceCredited: false },
          { $set: { status: "reversed", reversedAt: new Date() } },
          { new: true },
        );
        if (!reversed) {
          await HooshPayInvoice.findOneAndUpdate(
            { _id: invoice._id, status: "paid" },
            { $set: { status: "reversed", reversedAt: new Date(), recoveryStatus: "required", recoveryReason: "provider_reversal_after_payment_claim" } },
          );
        }
      } else if (paidFlag === true) {
        log("error", "HooshPay verification returned conflicting status fields", { cycleId, uid: invoice.uid, status });
      }
    } catch (error) {
      log("warn", "Pending invoice verification failed", {
        cycleId, uid: invoice.uid, errorType: error?.name || "HooshPayApiError",
        code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
      });
    }
  }
}
