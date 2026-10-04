import { randomUUID } from "node:crypto";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { default as botInstance } from "../../config/botInstance.js";
import { verifyHooshPayment } from "../hooshpay/verifyHooshPayment.js";
import { fulfillHooshOrder } from "../hooshpay/fulfillHooshOrder.js";
import { confirmBankPayment } from "../payments/confirmBankPayment.js";
import { commitProvisionedPurchase, deliverPurchaseNotification } from "../buyService/purchaseLedger.js";
import trxScanner from "../trxWalletScanner.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { escapeRegex, parsePagination, requireReason, requireTelegramId } from "./validation.js";

const NORMALIZED_STATUSES = ["pending", "paid", "fulfilled", "failed", "cancelled", "refunded", "recovery-required"];
const PURCHASE_PENDING = ["reserving", "reserved", "provisioning", "provisioned", "refund_pending"];
const PURCHASE_RECOVERY = ["uncertain", "manual_review"];

function normalizeStatus(provider, record) {
  if (record.recoveryStatus === "required") return "recovery-required";
  if (provider === "hooshpay") {
    if (record.status === "paid") return record.balanceCredited ? "fulfilled" : "recovery-required";
    if (["expired", "cancelled"].includes(record.status)) return "cancelled";
    if (record.status === "reversed") return "refunded";
    return record.status === "failed" ? "failed" : "pending";
  }
  if (provider === "bank") {
    if (["confirmed", "paid"].includes(record.status)) return record.balanceCredited ? "fulfilled" : "recovery-required";
    if (record.status === "rejected") return "failed";
    if (record.status === "cancelled") return "cancelled";
    return "pending";
  }
  if (provider === "trx") {
    if (record.status === "paid") return record.balanceCredited ? "fulfilled" : "recovery-required";
    if (record.status === "rejected") return "failed";
    return "pending";
  }
  if (record.status === "completed") return "fulfilled";
  if (record.status === "failed") return "failed";
  if (record.status === "refunded") return "refunded";
  if (record.status === "cancelled") return "cancelled";
  if (PURCHASE_RECOVERY.includes(record.status) || record.recoveryStatus === "required") return "recovery-required";
  return PURCHASE_PENDING.includes(record.status) ? "pending" : "recovery-required";
}

function normalizePayment(provider, record) {
  const id = provider === "hooshpay" ? record.uid
    : provider === "bank" ? record.paymentId
    : provider === "trx" ? record.invoiceId
    : record.purchaseId;
  const status = normalizeStatus(provider, record);
  return {
    key: `${provider}:${id}`,
    id: String(id),
    provider,
    providerLabel: provider === "hooshpay" ? "HooshPay" : provider === "bank" ? "Bank transfer" : provider === "trx" ? "TRX" : "Wallet",
    type: provider === "wallet" ? "order" : "top-up",
    userId: String(record.userId ?? record.telegramId),
    amount: Number(record.amount || 0),
    currency: provider === "trx" ? "Toman" : "Toman",
    product: provider === "wallet" ? (record.planName || record.planId || "VPN service") : "Wallet top-up",
    trackingCode: record.trackingCode || record.transactionHash || null,
    status,
    rawStatus: String(record.status || "unknown"),
    createdAt: record.createdAt || null,
    paidAt: record.paidAt || record.confirmedAt || record.balanceCreditedAt || null,
    fulfilledAt: record.completedAt || record.balanceCreditedAt || record.fulfilledAt || null,
    retryCount: Number(record.retryCount || 0),
    lastRetryAt: record.lastRetryAt || null,
    nextRetryAt: record.nextRetryAt || null,
    lastError: record.lastErrorCode || record.errorCode || null,
    recoveryStatus: record.recoveryStatus || "none",
    recoveryReason: record.recoveryReason || null,
  };
}

function appendAnd(filters) {
  const present = filters.filter(Boolean);
  return present.length > 1 ? { $and: present } : (present[0] || {});
}

function statusFilter(provider, status) {
  if (!status || status === "all") return null;
  if (provider === "hooshpay") {
    if (status === "pending") return { status: "pending" };
    if (status === "paid") return { status: "paid" };
    if (status === "fulfilled") return { status: "paid", balanceCredited: true };
    if (status === "recovery-required") return { $or: [{ recoveryStatus: "required" }, { status: "paid", balanceCredited: false }] };
    if (status === "failed") return { status: "failed" };
    if (status === "cancelled") return { status: { $in: ["expired", "cancelled"] } };
    if (status === "refunded") return { status: "reversed" };
  }
  if (provider === "bank") {
    if (status === "pending") return { status: { $in: ["unpaid", "pending", "waiting_for_approval"] } };
    if (status === "fulfilled") return { status: { $in: ["confirmed", "paid"] }, balanceCredited: true };
    if (status === "paid") return { status: { $in: ["confirmed", "paid"] } };
    if (status === "recovery-required") return { $or: [{ recoveryStatus: "required" }, { status: { $in: ["confirmed", "paid"] }, balanceCredited: false }] };
    if (status === "failed") return { status: "rejected" };
    if (status === "cancelled") return { status: "cancelled" };
  }
  if (provider === "trx") {
    if (status === "pending") return { status: "unpaid" };
    if (status === "fulfilled") return { status: "paid", balanceCredited: true };
    if (status === "paid") return { status: "paid" };
    if (status === "recovery-required") return { $or: [{ recoveryStatus: "required" }, { status: "paid", balanceCredited: false }] };
    if (status === "failed") return { status: "rejected" };
  }
  if (provider === "wallet") {
    if (status === "pending") return { status: { $in: PURCHASE_PENDING } };
    if (status === "fulfilled") return { status: "completed" };
    if (status === "failed") return { status: "failed" };
    if (status === "refunded") return { status: "refunded" };
    if (status === "recovery-required") return { $or: [{ recoveryStatus: "required" }, { status: { $in: PURCHASE_RECOVERY } }] };
  }
  return { _id: { $exists: false } };
}

function searchFilter(provider, term) {
  if (!term) return null;
  if (/^[1-9]\d{0,19}$/.test(term)) {
    if (provider === "wallet") return { telegramId: term };
    return { userId: Number(term) };
  }
  const regex = new RegExp(escapeRegex(term), "i");
  if (provider === "hooshpay") return { $or: [{ uid: regex }, { orderId: regex }, { trackingCode: regex }] };
  if (provider === "bank") return { $or: [{ paymentId: regex }, { trackingCode: regex }] };
  if (provider === "trx") return { $or: [{ invoiceId: regex }, { transactionHash: regex }] };
  return { $or: [{ purchaseId: regex }, { planName: regex }, { serviceUsername: regex }] };
}

const sources = [
  { provider: "hooshpay", model: HooshPayInvoice },
  { provider: "bank", model: bankInvoice },
  { provider: "trx", model: CryptoInvoice },
  { provider: "wallet", model: WalletPurchase },
];

export async function listPayments({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePagination(query);
  const requestedStatus = NORMALIZED_STATUSES.includes(query.status) ? query.status : "all";
  const search = String(query.search || "").trim().slice(0, 120);
  const fetchCount = Math.min(2_500, page * pageSize);
  const responses = await Promise.all(sources.map(async ({ provider, model }) => {
    const filter = appendAnd([statusFilter(provider, requestedStatus), searchFilter(provider, search)]);
    const [records, total] = await Promise.all([
      model.find(filter).sort({ createdAt: -1, _id: -1 }).limit(fetchCount).lean().maxTimeMS(8_000),
      model.countDocuments(filter).maxTimeMS(8_000),
    ]);
    return { provider, records, total };
  }));
  const all = responses.flatMap(({ provider, records }) => records.map((record) => normalizePayment(provider, record)))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const filtered = requestedStatus === "all" ? all : all.filter((item) => item.status === requestedStatus);
  const offset = (page - 1) * pageSize;
  const items = filtered.slice(offset, offset + pageSize);
  const total = requestedStatus === "all" ? responses.reduce((sum, item) => sum + item.total, 0) : filtered.length;
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize), statuses: NORMALIZED_STATUSES };
}

function parsePaymentKey(key) {
  if (typeof key !== "string" || key.length > 180) throw new AdminServiceError("Invalid payment ID.", { status: 400, code: "invalid_payment_id" });
  const separator = key.indexOf(":");
  const provider = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator < 1 || !["hooshpay", "bank", "trx", "wallet"].includes(provider) || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) {
    throw new AdminServiceError("Invalid payment ID.", { status: 400, code: "invalid_payment_id" });
  }
  return { provider, id };
}

async function findPayment(key) {
  const { provider, id } = parsePaymentKey(key);
  const model = { hooshpay: HooshPayInvoice, bank: bankInvoice, trx: CryptoInvoice, wallet: WalletPurchase }[provider];
  const field = { hooshpay: "uid", bank: "paymentId", trx: "invoiceId", wallet: "purchaseId" }[provider];
  const record = await model.findOne({ [field]: id }).lean();
  if (!record) throw new AdminServiceError("Payment or order not found.", { status: 404, code: "payment_not_found" });
  return { provider, record, normalized: normalizePayment(provider, record) };
}

function timelineFor(provider, record) {
  const events = [];
  const add = (name, at, status = "done", detail = null) => { if (at) events.push({ name, at, status, detail }); };
  add("Order created", record.createdAt);
  if (provider === "wallet") {
    add("Wallet balance reserved", record.reservedAt);
    add("WizardXray provisioning started", record.provisioningStartedAt, record.status === "manual_review" || record.status === "uncertain" ? "warning" : "done");
    add("VPN created on WizardXray", record.provisionedAt);
    add("Service delivered to account", record.completedAt);
    add("Wallet reservation refunded", record.refundedAt);
    if (record.status === "provisioning" && !record.provisionedAt) events.push({ name: "VPN creation result", at: null, status: "pending", detail: "The panel result may require reconciliation; do not submit another create request." });
  } else {
    add("Payment initiated", record.createdAt);
    if (provider === "hooshpay") {
      for (const item of (record.webhookLog || []).slice(-20)) {
        add("Webhook received", item.receivedAt, item.payload?.status === "paid" ? "success" : "done", item.payload?.status ? `Status: ${String(item.payload.status).slice(0, 40)}` : null);
      }
    }
    add("Payment verified", record.paidAt || record.confirmedAt);
    add("Wallet credited", record.balanceCreditedAt, record.balanceCredited ? "success" : (record.status === "paid" || record.status === "confirmed" ? "warning" : "pending"));
  }
  return events.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

export async function getPaymentDetail({ actorId, key } = {}) {
  assertAdminUser(actorId);
  const { provider, record, normalized } = await findPayment(key);
  const details = {
    ...normalized,
    timeline: timelineFor(provider, record),
    rawStatus: record.status,
    fulfilled: provider === "hooshpay" ? Boolean(record.balanceCredited) : provider === "wallet" ? record.status === "completed" : Boolean(record.balanceCredited),
    webhookEvents: provider === "hooshpay" ? (record.webhookLog || []).slice(-20).map((entry) => ({
      receivedAt: entry.receivedAt,
      event: typeof entry.payload?.event === "string" ? entry.payload.event.slice(0, 80) : null,
      status: typeof entry.payload?.status === "string" ? entry.payload.status.slice(0, 40) : null,
      amount: Number.isFinite(Number(entry.payload?.amount)) ? Number(entry.payload.amount) : null,
      trackingCode: typeof entry.payload?.tracking_code === "string" ? entry.payload.tracking_code.slice(0, 128) : null,
    })) : [],
    purchase: provider === "wallet" ? {
      serviceUsername: record.serviceUsername || null,
      productId: record.planId || null,
      product: record.planName || record.planId || null,
      trafficGb: Number(record.gig || 0),
      durationDays: Number(record.days || 0),
      expiresAt: record.expiresAt || null,
      errorCode: record.errorCode || null,
    } : null,
    actions: {
      retryVerification: provider === "hooshpay" && ["pending", "expired", "cancelled", "failed"].includes(record.status),
      retryFulfillment: (provider === "hooshpay" && record.status === "paid" && !record.balanceCredited)
        || (provider === "bank" && record.status === "confirmed" && !record.balanceCredited && record.creditLedgerVersion === 2)
        || (provider === "trx" && record.status === "paid" && !record.balanceCredited && record.creditLedgerVersion === 2)
        || (provider === "wallet" && ["provisioned", "completed"].includes(record.status)),
      manualResolve: normalized.status === "recovery-required" || record.recoveryStatus === "required",
    },
  };
  return details;
}

async function stampRetry(provider, id, operationId) {
  const fields = { hooshpay: [HooshPayInvoice, "uid"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = fields[provider];
  const now = new Date();
  const result = await model.updateOne(
    { [field]: id, lastRetryOperationId: { $ne: operationId } },
    { $inc: { retryCount: 1 }, $set: { lastRetryAt: now, lastRetryOperationId: operationId, nextRetryAt: new Date(now.getTime() + 5 * 60_000), lastErrorCode: null } }
  );
  return Number(result.modifiedCount || 0) > 0;
}

async function updateRetryResult(provider, id, { ok, errorCode = null, recoveryRequired = false } = {}) {
  const fields = { hooshpay: [HooshPayInvoice, "uid"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = fields[provider];
  await model.updateOne({ [field]: id }, {
    $set: {
      nextRetryAt: ok ? null : new Date(Date.now() + 5 * 60_000),
      lastErrorCode: ok ? null : String(errorCode || "RETRY_FAILED").slice(0, 80),
      ...(recoveryRequired ? { recoveryStatus: "required" } : {}),
    },
  });
}

async function safeRetry({ provider, id, record, actorId, operationId }) {
  await stampRetry(provider, id, operationId);
  const bot = botInstance.bot;
  if (provider === "hooshpay") {
    if (record.status === "pending") {
      const result = await verifyHooshPayment(record.uid, bot, record.userId);
      if (result.locked) throw new AdminServiceError("Another verification of this payment is already running.", { status: 409, code: "payment_processing" });
      if (result.notPaid) return { ok: true, status: "not-paid", auditSummary: { status: "not-paid" } };
      if (!result.success && !result.alreadyCredited && !result.notified) {
        throw new AdminServiceError(result.error || "HooshPay verification did not complete.", { status: 503, code: "hooshpay_verification_incomplete" });
      }
      return { ok: true, status: result.alreadyCredited ? "already-fulfilled" : "verified", auditSummary: { status: result.alreadyCredited ? "already-fulfilled" : "verified" } };
    }
    if (record.status === "paid" && !record.balanceCredited) {
      const result = await fulfillHooshOrder({ invoice: record, bot, chatId: record.userId });
      if (result.manualReviewRequired) throw new AdminServiceError("Legacy payment requires manual ledger reconciliation; no credit was issued.", { status: 409, code: "legacy_payment_manual_review" });
      if (!(result.credited || result.alreadyCredited || result.notified)) throw new AdminServiceError("HooshPay fulfillment remains incomplete.", { status: 503, code: "hooshpay_fulfillment_incomplete" });
      await HooshPayInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
      return { ok: true, status: "fulfilled", auditSummary: { status: "fulfilled" } };
    }
    throw new AdminServiceError("Only a pending verification or a paid uncredited HooshPay invoice can be retried.", { status: 409, code: "payment_not_retryable" });
  }
  if (provider === "bank") {
    if (record.status === "confirmed" && !record.balanceCredited && record.creditLedgerVersion === 2) {
      const result = await confirmBankPayment({ paymentId: record.paymentId, adminId: actorId, bot });
      if (!["credited", "recovered", "already_confirmed"].includes(result.status)) throw new AdminServiceError("Bank payment recovery did not complete.", { status: 409, code: `bank_${result.status}` });
      await bankInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
      return { ok: true, status: result.status, auditSummary: { status: result.status } };
    }
    throw new AdminServiceError("Bank transfers cannot be auto-verified; confirm the receipt through the existing approval workflow.", { status: 409, code: "bank_auto_verify_unavailable" });
  }
  if (provider === "trx") {
    if (record.status === "paid" && !record.balanceCredited && record.creditLedgerVersion === 2) {
      const recovered = await trxScanner.recoverInvoice(record.invoiceId);
      if (!recovered) throw new AdminServiceError("TRX recovery did not complete.", { status: 503, code: "trx_recovery_incomplete" });
      await CryptoInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
      return { ok: true, status: "fulfilled", auditSummary: { status: "fulfilled" } };
    }
    throw new AdminServiceError("Only a paid TRX invoice with the versioned wallet ledger can be retried.", { status: 409, code: "payment_not_retryable" });
  }
  if (provider === "wallet") {
    if (record.status === "provisioned") {
      const result = await commitProvisionedPurchase(record, bot);
      await WalletPurchase.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
      return { ok: true, status: "fulfilled", notified: Boolean(result?.notified), auditSummary: { status: "fulfilled" } };
    }
    if (record.status === "completed" && record.notificationPending) {
      const notified = await deliverPurchaseNotification(record, bot);
      return { ok: true, status: notified ? "notification-sent" : "notification-pending", auditSummary: { status: notified ? "notification-sent" : "notification-pending" } };
    }
    throw new AdminServiceError("WizardXray create requests are not replayed automatically. Inspect the panel and resolve uncertain provisioning manually.", { status: 409, code: "non_idempotent_provisioning_blocked" });
  }
  throw new AdminServiceError("Unsupported payment provider.", { status: 400, code: "invalid_payment_provider" });
}

export async function retryPayment({ actorId, operationId, key, ipAddress } = {}) {
  assertAdminUser(actorId);
  const { provider, id } = parsePaymentKey(key);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PAYMENT_RETRIED",
    targetType: provider === "wallet" ? "order" : "payment",
    targetId: id,
    ipAddress,
    metadata: { provider },
    resumeStarted: true,
    execute: async () => {
      const { record } = await findPayment(key);
      try {
        const result = await safeRetry({ provider, id, record, actorId, operationId });
        await updateRetryResult(provider, id, { ok: true });
        return result;
      } catch (error) {
        await updateRetryResult(provider, id, { ok: false, errorCode: error?.code || "RETRY_FAILED", recoveryRequired: true }).catch(() => {});
        throw error;
      }
    },
  });
  return result;
}

export async function markPaymentRecoveryRequired({ actorId, operationId, key, reason, ipAddress } = {}) {
  assertAdminUser(actorId);
  const { provider, id } = parsePaymentKey(key);
  const safeReason = requireReason(reason);
  const modelMap = { hooshpay: [HooshPayInvoice, "uid"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = modelMap[provider];
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "PAYMENT_MARKED_RECOVERY_REQUIRED",
    targetType: provider === "wallet" ? "order" : "payment", targetId: id, ipAddress,
    metadata: { provider, reason: safeReason }, resumeStarted: true,
    execute: async () => {
      const updated = await model.findOneAndUpdate({ [field]: id }, { $set: { recoveryStatus: "required", recoveryReason: safeReason } }, { new: true }).select(field).lean();
      if (!updated) throw new AdminServiceError("Payment or order not found.", { status: 404, code: "payment_not_found" });
      return { ok: true, recoveryStatus: "required", auditSummary: { recoveryStatus: "required" } };
    },
  });
  return result;
}

export async function resolvePaymentRecovery({ actorId, operationId, key, reason, ipAddress } = {}) {
  assertAdminUser(actorId);
  const { provider, id } = parsePaymentKey(key);
  const safeReason = requireReason(reason, { min: 10, max: 500 });
  const modelMap = { hooshpay: [HooshPayInvoice, "uid"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = modelMap[provider];
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "PAYMENT_MANUALLY_RESOLVED",
    targetType: provider === "wallet" ? "order" : "payment", targetId: id, ipAddress,
    metadata: { provider, resolution: safeReason }, resumeStarted: true,
    execute: async () => {
      const current = await model.findOne({ [field]: id }).select("recoveryStatus status balanceCredited").lean();
      if (!current) throw new AdminServiceError("Payment or order not found.", { status: 404, code: "payment_not_found" });
      if (current.recoveryStatus !== "required" && !["manual_review", "uncertain"].includes(current.status) && !(current.status === "paid" && current.balanceCredited === false)) {
        throw new AdminServiceError("This payment is not waiting for manual recovery.", { status: 409, code: "not_recovery_required" });
      }
      await model.updateOne({ [field]: id }, { $set: { recoveryStatus: "resolved", recoveryReason: safeReason, recoveryResolvedAt: new Date(), recoveryResolvedBy: String(actorId) } });
      // This is a disposition record only. It deliberately does not credit a
      // wallet or replay a non-idempotent VPN create call.
      return { ok: true, recoveryStatus: "resolved", financialMutation: false, auditSummary: { recoveryStatus: "resolved", financialMutation: false } };
    },
  });
  return result;
}

export async function confirmBankInvoice({ actorId, operationId, paymentId, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = String(paymentId ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminServiceError("Invalid bank payment ID.", { status: 400, code: "invalid_payment_id" });
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "BANK_PAYMENT_CONFIRMED", targetType: "payment", targetId: id, ipAddress,
    execute: async () => {
      const out = await confirmBankPayment({ paymentId: id, adminId: actorId, bot: botInstance.bot });
      if (!["credited", "recovered", "already_confirmed"].includes(out.status)) throw new AdminServiceError(`Bank payment was not confirmed (${out.status}).`, { status: 409, code: `bank_${out.status}` });
      return { ok: true, status: out.status, auditSummary: { status: out.status } };
    },
  });
  return result;
}

export async function rejectBankInvoice({ actorId, operationId, paymentId, reason, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = String(paymentId ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminServiceError("Invalid bank payment ID.", { status: 400, code: "invalid_payment_id" });
  const safeReason = requireReason(reason);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "BANK_PAYMENT_REJECTED", targetType: "payment", targetId: id, targetUserId: null, ipAddress,
    metadata: { reason: safeReason },
    execute: async () => {
      const payment = await bankInvoice.findOneAndUpdate(
        { paymentId: id, paymentType: "bank", status: "waiting_for_approval", balanceCredited: false },
        { $set: { status: "rejected", rejectedAt: new Date(), rejectedBy: String(actorId) } },
        { new: true }
      );
      if (!payment) throw new AdminServiceError("This bank payment is no longer awaiting approval.", { status: 409, code: "bank_payment_not_pending" });
      try { await botInstance.bot?.sendMessage(String(payment.userId), "❌ رسید پرداخت شما بررسی شد. در صورت نیاز با پشتیبانی تماس بگیرید."); } catch { /* Notification failure does not undo a rejected receipt. */ }
      return { ok: true, status: "rejected", auditSummary: { status: "rejected" } };
    },
  });
  return result;
}

export function paymentKeyParts(key) { return parsePaymentKey(key); }
export { NORMALIZED_STATUSES, normalizeStatus, normalizePayment };
