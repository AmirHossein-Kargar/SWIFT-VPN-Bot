import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { assertAdminUser } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { retryPayment } from "./payments.js";
import { parsePagination } from "./validation.js";

const STALE_PROVISIONING_MS = 10 * 60_000;

function recoveryItem(provider, record, kind) {
  const id = provider === "hooshpay" ? record.uid : provider === "bank" ? record.paymentId : provider === "trx" ? record.invoiceId : record.purchaseId;
  return {
    key: `${provider}:${id}`,
    provider,
    kind,
    userId: String(record.userId ?? record.telegramId),
    amount: Number(record.amount || 0),
    createdAt: record.createdAt || null,
    lastEventAt: record.paidAt || record.confirmedAt || record.provisioningStartedAt || record.updatedAt || record.createdAt || null,
    status: String(record.status || "unknown"),
    retryCount: Number(record.retryCount || 0),
    lastRetryAt: record.lastRetryAt || null,
    nextRetryAt: record.nextRetryAt || null,
    lastError: record.lastErrorCode || record.errorCode || record.recoveryReason || null,
    retrySafe: kind !== "provisioning-uncertain",
  };
}

async function collectRecoveryCandidates(now) {
  const [hoosh, bank, trx, wallet] = await Promise.all([
    HooshPayInvoice.find({
      $or: [
        { status: "paid", balanceCredited: false },
        { recoveryStatus: "required" },
      ],
    }).select("uid userId amount status balanceCredited paidAt createdAt retryCount lastRetryAt nextRetryAt lastErrorCode recoveryStatus recoveryReason webhookLog").lean().limit(500),
    bankInvoice.find({
      $or: [
        { status: { $in: ["confirmed", "paid"] }, balanceCredited: false },
        { recoveryStatus: "required" },
      ],
    }).select("paymentId userId amount status balanceCredited confirmedAt createdAt retryCount lastRetryAt nextRetryAt lastErrorCode recoveryStatus recoveryReason").lean().limit(500),
    CryptoInvoice.find({
      $or: [
        { status: "paid", balanceCredited: false },
        { recoveryStatus: "required" },
      ],
    }).select("invoiceId userId amount status balanceCredited confirmedAt createdAt retryCount lastRetryAt nextRetryAt lastErrorCode recoveryStatus recoveryReason").lean().limit(500),
    WalletPurchase.find({
      $or: [
        { status: { $in: ["uncertain", "manual_review"] } },
        { status: "provisioned" },
        { status: "completed", notificationPending: true },
        { status: "provisioning", provisioningStartedAt: { $lt: new Date(now.getTime() - STALE_PROVISIONING_MS) } },
        { recoveryStatus: "required" },
      ],
    }).select("purchaseId telegramId amount status provisioningStartedAt provisionedAt completedAt createdAt errorCode retryCount lastRetryAt nextRetryAt recoveryStatus recoveryReason expiresAt").lean().limit(500),
  ]);

  const items = [];
  for (const record of hoosh) {
    const lastWebhook = Array.isArray(record.webhookLog) ? record.webhookLog[record.webhookLog.length - 1] : null;
    const kind = record.status === "paid" && record.balanceCredited === false
      ? (lastWebhook ? "webhook-processing-failed" : "paid-not-fulfilled")
      : "manual-review";
    items.push(recoveryItem("hooshpay", record, kind));
  }
  for (const record of bank) items.push(recoveryItem("bank", record, record.balanceCredited === false ? "paid-not-fulfilled" : "manual-review"));
  for (const record of trx) items.push(recoveryItem("trx", record, record.balanceCredited === false ? "paid-not-fulfilled" : "manual-review"));
  for (const record of wallet) {
    let kind = "manual-review";
    if (record.status === "provisioned") kind = "provisioning-commit-pending";
    else if (record.status === "completed" && record.notificationPending) kind = "delivery-notification-pending";
    else if (record.status === "provisioning") kind = "provisioning-stalled";
    else if (["uncertain", "manual_review"].includes(record.status)) kind = "provisioning-uncertain";
    items.push(recoveryItem("wallet", record, kind));
  }
  return items.sort((a, b) => new Date(a.lastEventAt || a.createdAt || 0) - new Date(b.lastEventAt || b.createdAt || 0));
}

export async function getRecoveryQueue({ actorId, page = 1, pageSize = 25, now = new Date() } = {}) {
  assertAdminUser(actorId);
  const { page: safePage, pageSize: safeSize } = parsePagination({ page, pageSize });
  const all = await collectRecoveryCandidates(now);
  const offset = (safePage - 1) * safeSize;
  return {
    items: all.slice(offset, offset + safeSize),
    page: safePage,
    pageSize: safeSize,
    total: all.length,
    pages: Math.ceil(all.length / safeSize),
    counts: all.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {}),
  };
}

const MAX_RETRY_ITEMS = 25;

export async function retrySafeRecoveryItems({ actorId, operationId, keys, ipAddress, now = new Date() } = {}) {
  assertAdminUser(actorId);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PAYMENT_RETRIED",
    targetType: "recovery",
    targetId: "batch",
    ipAddress,
    metadata: { mode: keys ? "selection" : "safe-all" },
    resumeStarted: true,
    execute: async () => {
      let targets;
      if (Array.isArray(keys) && keys.length) {
        if (keys.length > MAX_RETRY_ITEMS) {
          const error = new Error("too many");
          error.code = "invalid_request";
          throw error;
        }
        targets = keys.map(String).filter((key) => /^[a-z]+:[A-Za-z0-9_.:-]{1,128}$/.test(key));
      } else {
        targets = (await collectRecoveryCandidates(now)).filter((item) => item.retrySafe).slice(0, MAX_RETRY_ITEMS).map((item) => item.key);
      }

      const attempted = [];
      const succeeded = [];
      const failed = [];
      for (const [index, key] of targets.entries()) {
        const subOperationId = `${operationId.slice(0, 60)}-${index}`;
        attempted.push(key);
        try {
          await retryPayment({ actorId, operationId: subOperationId, key, ipAddress });
          succeeded.push(key);
        } catch (error) {
          failed.push({ key, code: error?.code || "retry_failed" });
        }
      }
      return {
        ok: true,
        attempted: attempted.length,
        succeeded: succeeded.length,
        failed,
        auditSummary: { attempted: attempted.length, succeeded: succeeded.length, failed: failed.length },
      };
    },
  });
  return result;
}
