import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { default as botInstance } from "../../config/botInstance.js";
import { verifyHooshPayment } from "../hooshpay/verifyHooshPayment.js";
import { fulfillHooshOrder } from "../hooshpay/fulfillHooshOrder.js";
import { reconcileNowPaymentsPayment } from "../nowpayments/recovery.js";
import { lookupCreationUnknown } from "../nowpayments/creationLookup.js";
import { MIN_RELEASE_AGE_MS } from "./creationUnknown.js";
import { readNowPaymentsConfig } from "../nowpayments/money.js";
import { createNowPaymentsClient } from "../nowpayments/nowpaymentsClient.js";
import { confirmBankPayment } from "../payments/confirmBankPayment.js";
import { commitProvisionedPurchase, deliverPurchaseNotification } from "../buyService/purchaseLedger.js";
import trxScanner from "../trxWalletScanner.js";
import { explainDeletion } from "./paymentDeletion.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { escapeRegex, parsePagination, requireReason } from "./validation.js";

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
  if (provider === "nowpayments") {
    if (record.status === "finished") return record.balanceCredited ? "fulfilled" : "recovery-required";
    if (["expired", "creation_failed"].includes(record.status)) return "cancelled";
    if (record.status === "failed") return "failed";
    if (record.status === "refunded") return "refunded";
    if (record.status === "creation_unknown") return "recovery-required";
    return "pending";
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
    : provider === "nowpayments" ? record.orderId
    : provider === "bank" ? record.paymentId
    : provider === "trx" ? record.invoiceId
    : record.purchaseId;
  const status = normalizeStatus(provider, record);
  return {
    key: `${provider}:${id}`,
    id: String(id),
    provider,
    providerLabel: provider === "hooshpay" ? "HooshPay" : provider === "nowpayments" ? "NOWPayments" : provider === "bank" ? "Bank transfer" : provider === "trx" ? "TRX" : "Wallet",
    type: provider === "wallet" ? "order" : "top-up",
    userId: String(record.userId ?? record.telegramId),
    amount: Number(provider === "nowpayments" ? record.amountToman : record.amount || 0),
    currency: provider === "trx" ? "Toman" : "Toman",
    product: provider === "wallet" ? (record.planName || record.planId || "VPN service") : "Wallet top-up",
    trackingCode: record.trackingCode || record.transactionHash || (provider === "nowpayments" ? record.paymentId : null) || null,
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
    deletion: (() => {
      if (provider === "wallet") return { eligible: false, code: "wallet_order", reason: null };
      const verdict = explainDeletion(provider, record);
      return { eligible: verdict.eligible, code: verdict.code, reason: verdict.reason };
    })(),
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
  if (provider === "nowpayments") {
    if (status === "pending") return { status: { $in: ["creating", "pending", "waiting", "confirming", "confirmed", "sending", "partially_paid"] } };
    if (status === "paid") return { status: "finished" };
    if (status === "fulfilled") return { status: "finished", balanceCredited: true };
    if (status === "recovery-required") return { $or: [{ recoveryStatus: "required" }, { status: { $in: ["creation_unknown", "finished"] }, balanceCredited: false }] };
    if (status === "failed") return { status: "failed" };
    if (status === "cancelled") return { status: { $in: ["expired", "creation_failed"] } };
    if (status === "refunded") return { status: "refunded" };
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
  if (provider === "nowpayments") return { $or: [{ orderId: regex }, { invoiceId: regex }, { paymentId: regex }] };
  if (provider === "bank") return { $or: [{ paymentId: regex }, { trackingCode: regex }] };
  if (provider === "trx") return { $or: [{ invoiceId: regex }, { transactionHash: regex }] };
  return { $or: [{ purchaseId: regex }, { planName: regex }, { serviceUsername: regex }] };
}

const sources = [
  { provider: "hooshpay", model: HooshPayInvoice },
  { provider: "nowpayments", model: NowPaymentsInvoice },
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
  if (typeof key !== "string" || key.length > 180) throw new AdminServiceError("شناسه پرداخت نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  const separator = key.indexOf(":");
  const provider = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator < 1 || !["hooshpay", "nowpayments", "bank", "trx", "wallet"].includes(provider) || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) {
    throw new AdminServiceError("شناسه پرداخت نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  }
  return { provider, id };
}

async function findPayment(key) {
  const { provider, id } = parsePaymentKey(key);
  const model = { hooshpay: HooshPayInvoice, nowpayments: NowPaymentsInvoice, bank: bankInvoice, trx: CryptoInvoice, wallet: WalletPurchase }[provider];
  const field = { hooshpay: "uid", nowpayments: "orderId", bank: "paymentId", trx: "invoiceId", wallet: "purchaseId" }[provider];
  const record = await model.findOne({ [field]: id }).lean();
  if (!record) throw new AdminServiceError("پرداخت یا سفارش یافت نشد.", { status: 404, code: "payment_not_found" });
  return { provider, record, normalized: normalizePayment(provider, record) };
}

function lookupConfigured() {
  try { return Boolean(readNowPaymentsConfig(process.env)?.hasCustodyAuth); } catch { return false; }
}

function timelineFor(provider, record) {
  const events = [];
  const add = (name, at, status = "done", detail = null) => { if (at) events.push({ name, at, status, detail }); };
  add("Order created", record.createdAt);
  if (provider === "wallet") {
    add("Wallet balance reserved", record.walletDebitedAt || record.reservedAt, "done", record.amount != null ? `${Number(record.amount).toLocaleString("en-US")} Toman (${record.walletDebitStatus || "reserved"})` : null);
    add("WizardXray provisioning started", record.provisioningStartedAt, record.status === "manual_review" || record.status === "uncertain" ? "warning" : "done");
    add("VPN created on WizardXray", record.provisionedAt);
    add("Service delivered to account", record.completedAt);
    add("Wallet reservation refunded", record.refundedAt, record.refundStatus === "completed" ? "success" : "warning", record.refundAmount != null ? `${Number(record.refundAmount).toLocaleString("en-US")} Toman · ${String(record.refundReason || "refund")}` : null);
    if (record.status === "provisioning" && !record.provisionedAt) events.push({ name: "VPN creation result", at: null, status: "pending", detail: "The panel result may require reconciliation; do not submit another create request." });
    if (record.refundStatus === "pending" && !record.refundedAt) events.push({ name: "Wallet refund pending", at: null, status: "pending", detail: `${Number(record.refundAmount || record.amount || 0).toLocaleString("en-US")} Toman · ${String(record.refundReason || "refund recovery")}` });
  } else {
    add("Payment initiated", record.createdAt);
    if (provider === "hooshpay") {
      for (const item of (record.webhookLog || []).slice(-20)) {
        add("Webhook received", item.receivedAt, item.payload?.status === "paid" ? "success" : "done", item.payload?.status ? `Status: ${String(item.payload.status).slice(0, 40)}` : null);
      }
    } else if (provider === "nowpayments") {
      for (const item of (record.ipnLog || []).slice(-20)) {
        add("IPN received", item.receivedAt, item.paymentStatus === "finished" ? "success" : "done", item.paymentStatus ? `Status: ${String(item.paymentStatus).slice(0, 40)}` : null);
      }
    }
    if (provider === "nowpayments" && record.status === "creation_unknown") {
      const lookedAt = record.lastRetryAt ? new Date(record.lastRetryAt).toISOString() : null;
      events.push({
        name: "Invoice creation result unknown",
        at: null,
        status: "warning",
        detail: "The provider may hold an invoice for this order. The customer cannot open another crypto invoice until this is settled by a payment or released by an administrator.",
      });
      if (lookedAt) events.push({ name: "Provider payment lookup", at: lookedAt, status: "done", detail: `Last result: ${String(record.lastErrorCode || "payment bound").slice(0, 80)} · attempts: ${Number(record.retryCount || 0)}` });
    }
    add("Payment verified", record.paidAt || record.confirmedAt);
    add("Wallet credited", record.balanceCreditedAt, record.balanceCredited ? "success" : (["paid", "confirmed", "finished"].includes(record.status) ? "warning" : "pending"));
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
    })) : provider === "nowpayments" ? (record.ipnLog || []).slice(-20).map((entry) => ({
      receivedAt: entry.receivedAt,
      event: "payment.status",
      status: typeof entry.paymentStatus === "string" ? entry.paymentStatus.slice(0, 40) : null,
      amount: Number.isFinite(Number(entry.priceAmount)) ? Number(entry.priceAmount) : null,
      trackingCode: entry.paymentId || null,
    })) : [],
    purchase: provider === "wallet" ? {
      serviceUsername: record.serviceUsername || null,
      productId: record.planId || null,
      product: record.planName || record.planId || null,
      trafficGb: Number(record.gig || 0),
      durationDays: Number(record.days || 0),
      expiresAt: record.expiresAt || null,
      errorCode: record.errorCode || null,
      walletDebitStatus: record.walletDebitStatus
        || (record.status === "completed" ? "finalized" : record.status === "refunded" ? "refunded" : record.reservedAt ? "reserved" : "not_debited"),
      walletDebitedAt: record.walletDebitedAt || record.reservedAt || null,
      refundStatus: record.refundStatus || "none",
      refundAmount: record.refundAmount != null && Number.isSafeInteger(Number(record.refundAmount)) ? Number(record.refundAmount) : null,
      refundReason: record.refundReason || null,
      refundedAt: record.refundedAt || null,
    } : null,
    actions: {
      // Derived from retryPlan(), the exact rule retryPayment() enforces, so the UI never offers a retry that is refused.
      retryVerification: retryPlan(provider, record).action === "verify",
      retryFulfillment: (() => { const plan = retryPlan(provider, record); return plan.kind === "attempt" && plan.action !== "verify" && plan.action !== "lookup"; })(),
      // The generic disposition must not be offered where it is refused: these orders have their own audited release.
      manualResolve: (normalized.status === "recovery-required" || record.recoveryStatus === "required")
        && !(provider === "nowpayments" && ["creation_unknown", "creating"].includes(record.status)),
      // NOWPayments orders with an unknown invoice outcome only (other providers' payloads keep their exact shape):
      // a read-only provider lookup (never releases the lock) and the audited release of the customer's create-lock.
      ...(provider === "nowpayments" && record.status === "creation_unknown" ? {
        checkProvider: retryPlan(provider, record).action === "lookup",
        releaseCreationLock: !record.paymentId && !record.balanceCredited,
        releaseAvailableAt: new Date(new Date(record.updatedAt || record.createdAt || 0).getTime() + MIN_RELEASE_AGE_MS).toISOString(),
        providerLookupConfigured: lookupConfigured(),
      } : {}),
    },
  };
  return details;
}

async function stampRetry(provider, id, operationId) {
  const fields = { hooshpay: [HooshPayInvoice, "uid"], nowpayments: [NowPaymentsInvoice, "orderId"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = fields[provider];
  const now = new Date();
  const result = await model.updateOne(
    { [field]: id, lastRetryOperationId: { $ne: operationId } },
    { $inc: { retryCount: 1 }, $set: { lastRetryAt: now, lastRetryOperationId: operationId, nextRetryAt: new Date(now.getTime() + 5 * 60_000), lastErrorCode: null } }
  );
  return Number(result.modifiedCount || 0) > 0;
}

async function updateRetryResult(provider, id, { ok, errorCode = null, recoveryRequired = false } = {}) {
  const fields = { hooshpay: [HooshPayInvoice, "uid"], nowpayments: [NowPaymentsInvoice, "orderId"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = fields[provider];
  await model.updateOne({ [field]: id }, {
    $set: {
      nextRetryAt: ok ? null : new Date(Date.now() + 5 * 60_000),
      lastErrorCode: ok ? null : String(errorCode || "RETRY_FAILED").slice(0, 80),
      ...(recoveryRequired ? { recoveryStatus: "required" } : {}),
    },
  });
}

/**
 * What may a retry do to this record? A pure function of the record, evaluated BEFORE any write:
 *   settled  - the money/order is already settled; a retry is an idempotent no-op (no stamp, no flag, no provider call);
 *   refuse   - the record is not in a state a retry can act on; the established conflict response, again with no writes;
 *   attempt  - a genuine recovery attempt is possible.
 * Only an attempt may stamp retry bookkeeping or (on a real failure) mark recovery as required.
 */
const SETTLED_RETRY_STATUS = Object.freeze({
  hooshpay: "already-fulfilled",
  nowpayments: "already_credited",
  bank: "already_confirmed",
  trx: "already-fulfilled",
  wallet: "already-completed",
});

export function retryPlan(provider, record) {
  const settled = () => ({ kind: "settled", status: SETTLED_RETRY_STATUS[provider] });
  const refuse = (message, code, status = 409) => ({ kind: "refuse", error: { message, status, code } });
  const attempt = (action) => ({ kind: "attempt", action });
  if (provider === "hooshpay") {
    if (record.balanceCredited) return settled();
    if (record.status === "pending") return attempt("verify");
    if (record.status === "paid") return attempt("fulfill");
    return refuse("فقط فاکتور HooshPay در انتظار بررسی یا پرداخت‌شده بدون شارژ قابل تلاش مجدد است.", "payment_not_retryable");
  }
  if (provider === "nowpayments") {
    if (record.balanceCredited) return settled();
    if (record.paymentId && !["failed", "expired", "refunded"].includes(record.status)) return attempt("reconcile");
    // The provider may hold a payment for an order whose invoice was never recorded: ask it (read-only).
    if (!record.paymentId && record.status === "creation_unknown") return attempt("lookup");
    return refuse("این پرداخت NOWPayments شناسه قابل بررسی ندارد یا در وضعیت پایانی ناموفق است.", "payment_not_retryable");
  }
  if (provider === "bank") {
    if (record.balanceCredited) return settled();
    if (record.status === "confirmed" && record.creditLedgerVersion === 2) return attempt("recover");
    return refuse("پرداخت بانکی به صورت خودکار تأیید نمی‌شود؛ رسید را از مسیر تأیید موجود بررسی کنید.", "bank_auto_verify_unavailable");
  }
  if (provider === "trx") {
    if (record.balanceCredited) return settled();
    if (record.status === "paid" && record.creditLedgerVersion === 2) return attempt("recover");
    return refuse("فقط فاکتور TRX پرداخت‌شده با دفتر نسخه‌دار قابل تلاش مجدد است.", "payment_not_retryable");
  }
  if (provider === "wallet") {
    if (record.status === "provisioned") return attempt("commit");
    if (record.status === "completed") return record.notificationPending ? attempt("deliver") : settled();
    return refuse("درخواست‌های ساخت در WizardXray به صورت خودکار تکرار نمی‌شوند. وضعیت پنل را بررسی و ساخت نامشخص را دستی تعیین تکلیف کنید.", "non_idempotent_provisioning_blocked");
  }
  return refuse("درگاه پرداخت پشتیبانی نشده است.", "invalid_payment_provider", 400);
}

/** Failures of an eligible attempt that say nothing about the payment itself must not flag it for manual recovery. */
const BENIGN_RETRY_FAILURES = new Set(["payment_processing", "nowpayments_lookup_unavailable"]);

async function attemptRetry({ provider, plan, record, actorId }) {
  const bot = botInstance.bot;
  if (provider === "hooshpay") {
    if (plan.action === "verify") {
      const result = await verifyHooshPayment(record.uid, bot, record.userId);
      if (result.locked) throw new AdminServiceError("بررسی دیگری برای این پرداخت در حال انجام است.", { status: 409, code: "payment_processing" });
      if (result.notPaid) return { ok: true, status: "not-paid", auditSummary: { status: "not-paid" } };
      if (!result.success && !result.alreadyCredited && !result.notified) {
        throw new AdminServiceError(result.error || "HooshPay verification did not complete.", { status: 503, code: "hooshpay_verification_incomplete" });
      }
      return { ok: true, status: result.alreadyCredited ? "already-fulfilled" : "verified", auditSummary: { status: result.alreadyCredited ? "already-fulfilled" : "verified" } };
    }
    const result = await fulfillHooshOrder({ invoice: record, bot, chatId: record.userId });
    if (result.manualReviewRequired) throw new AdminServiceError("این پرداخت قدیمی نیاز به تطبیق دستی دفتر دارد؛ موجودی اعمال نشد.", { status: 409, code: "legacy_payment_manual_review" });
    if (!(result.credited || result.alreadyCredited || result.notified)) throw new AdminServiceError("تسویه HooshPay همچنان ناقص است.", { status: 503, code: "hooshpay_fulfillment_incomplete" });
    await HooshPayInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
    return { ok: true, status: "fulfilled", auditSummary: { status: "fulfilled" } };
  }
  if (provider === "nowpayments" && plan.action === "lookup") {
    const config = readNowPaymentsConfig(process.env);
    if (!config?.hasCustodyAuth) throw new AdminServiceError("بررسی در درگاه نیازمند NOWPAYMENTS_EMAIL و NOWPAYMENTS_PASSWORD است.", { status: 503, code: "nowpayments_lookup_unavailable" });
    const client = createNowPaymentsClient({ apiKey: config.apiKey, baseURL: config.baseURL, email: config.email, password: config.password });
    const found = await lookupCreationUnknown({ invoice: record, client });
    if (found.outcome === "lookup_unavailable") throw new AdminServiceError("پاسخ درگاه در دسترس نیست؛ بعداً دوباره تلاش کنید.", { status: 503, code: "nowpayments_lookup_unavailable" });
    if (["lookup_ambiguous", "lookup_mismatch", "lookup_unconfirmed"].includes(found.outcome)) throw new AdminServiceError("داده‌های درگاه مبهم یا ناسازگار است؛ در پنل NOWPayments بررسی کنید.", { status: 409, code: "nowpayments_lookup_inconclusive" });
    const status = found.outcome === "no_payment_found" ? (found.conclusive === false ? "no-payment-found-unverifiable" : "no-payment-found") : String(found.appliedOutcome || "payment-applied");
    return { ok: true, status, auditSummary: { status } };
  }
  if (provider === "nowpayments") {
    const result = await reconcileNowPaymentsPayment({ invoice: record });
    if (["finished", "already_credited"].includes(result.outcome)) {
      await NowPaymentsInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
      return { ok: true, status: result.outcome, auditSummary: { status: result.outcome } };
    }
    if (["waiting", "pending", "confirming", "confirmed", "sending", "partially_paid"].includes(result.outcome)) {
      return { ok: true, status: result.outcome, auditSummary: { status: result.outcome } };
    }
    throw new AdminServiceError("بازیابی NOWPayments کامل نشد.", { status: 503, code: `nowpayments_${result.outcome}` });
  }
  if (provider === "bank") {
    const result = await confirmBankPayment({ paymentId: record.paymentId, adminId: actorId, bot });
    if (!["credited", "recovered", "already_confirmed"].includes(result.status)) throw new AdminServiceError("بازیابی پرداخت بانکی کامل نشد.", { status: 409, code: `bank_${result.status}` });
    await bankInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
    return { ok: true, status: result.status, auditSummary: { status: result.status } };
  }
  if (provider === "trx") {
    const recovered = await trxScanner.recoverInvoice(record.invoiceId);
    if (!recovered) throw new AdminServiceError("بازیابی TRX کامل نشد.", { status: 503, code: "trx_recovery_incomplete" });
    await CryptoInvoice.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
    return { ok: true, status: "fulfilled", auditSummary: { status: "fulfilled" } };
  }
  // wallet
  if (plan.action === "commit") {
    const result = await commitProvisionedPurchase(record, bot);
    await WalletPurchase.updateOne({ _id: record._id }, { $set: { recoveryStatus: "none", recoveryReason: null } });
    return { ok: true, status: "fulfilled", notified: Boolean(result?.notified), auditSummary: { status: "fulfilled" } };
  }
  const notified = await deliverPurchaseNotification(record, bot);
  return { ok: true, status: notified ? "notification-sent" : "notification-pending", auditSummary: { status: notified ? "notification-sent" : "notification-pending" } };
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
      // Decide BEFORE touching anything. A settled record is an idempotent no-op and an ineligible one is refused with the
      // established conflict response; neither stamps retry bookkeeping, calls a provider, or flags the record for recovery.
      const plan = retryPlan(provider, record);
      if (plan.kind === "settled") return { ok: true, status: plan.status, noop: true, auditSummary: { status: plan.status, noop: true } };
      if (plan.kind === "refuse") throw new AdminServiceError(plan.error.message, { status: plan.error.status, code: plan.error.code });

      await stampRetry(provider, id, operationId);
      try {
        const result = await attemptRetry({ provider, plan, record, actorId });
        await updateRetryResult(provider, id, { ok: true });
        return result;
      } catch (error) {
        // Only a genuine, eligible attempt that failed in a way that concerns the payment itself warrants manual recovery.
        const recoveryRequired = !BENIGN_RETRY_FAILURES.has(error?.code);
        await updateRetryResult(provider, id, { ok: false, errorCode: error?.code || "RETRY_FAILED", recoveryRequired }).catch(() => {});
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
  const modelMap = { hooshpay: [HooshPayInvoice, "uid"], nowpayments: [NowPaymentsInvoice, "orderId"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = modelMap[provider];
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "PAYMENT_MARKED_RECOVERY_REQUIRED",
    targetType: provider === "wallet" ? "order" : "payment", targetId: id, ipAddress,
    metadata: { provider, reason: safeReason }, resumeStarted: true,
    execute: async () => {
      const updated = await model.findOneAndUpdate({ [field]: id }, { $set: { recoveryStatus: "required", recoveryReason: safeReason } }, { new: true }).select(field).lean();
      if (!updated) throw new AdminServiceError("پرداخت یا سفارش یافت نشد.", { status: 404, code: "payment_not_found" });
      return { ok: true, recoveryStatus: "required", auditSummary: { recoveryStatus: "required" } };
    },
  });
  return result;
}

export async function resolvePaymentRecovery({ actorId, operationId, key, reason, ipAddress } = {}) {
  assertAdminUser(actorId);
  const { provider, id } = parsePaymentKey(key);
  const safeReason = requireReason(reason, { min: 10, max: 500 });
  const modelMap = { hooshpay: [HooshPayInvoice, "uid"], nowpayments: [NowPaymentsInvoice, "orderId"], bank: [bankInvoice, "paymentId"], trx: [CryptoInvoice, "invoiceId"], wallet: [WalletPurchase, "purchaseId"] };
  const [model, field] = modelMap[provider];
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "PAYMENT_MANUALLY_RESOLVED",
    targetType: provider === "wallet" ? "order" : "payment", targetId: id, ipAddress,
    metadata: { provider, resolution: safeReason }, resumeStarted: true,
    execute: async () => {
      const current = await model.findOne({ [field]: id }).select("recoveryStatus status balanceCredited").lean();
      if (!current) throw new AdminServiceError("پرداخت یا سفارش یافت نشد.", { status: 404, code: "payment_not_found" });
      // A generic disposition must never leave (or hide) an unreleased create-lock: this case has its own audited workflow.
      if (provider === "nowpayments" && ["creation_unknown", "creating"].includes(current.status)) {
        throw new AdminServiceError("این سفارش NOWPayments هنوز قفل ایجاد فاکتور دارد؛ از «آزادسازی قفل ایجاد» استفاده کنید.", { status: 409, code: "use_creation_lock_release" });
      }
      if (current.recoveryStatus !== "required" && !["manual_review", "uncertain"].includes(current.status) && !(["paid", "finished"].includes(current.status) && current.balanceCredited === false)) {
        throw new AdminServiceError("این پرداخت در انتظار بازیابی دستی نیست.", { status: 409, code: "not_recovery_required" });
      }
      await model.updateOne({ [field]: id }, { $set: { recoveryStatus: "resolved", recoveryReason: safeReason, recoveryResolvedAt: new Date(), recoveryResolvedBy: String(actorId) } });
      // This is a disposition record only. It deliberately does not credit a
      // wallet or replay a non-idempotent VPN create call.
      return { ok: true, recoveryStatus: "resolved", financialMutation: false, auditSummary: { recoveryStatus: "resolved", financialMutation: false } };
    },
  });
  return result;
}

/**
 * bankModel/userModel/auditModel/bot are injection seams used only by the
 * isolated mock-test harness; production callers rely on the defaults.
 */
export async function confirmBankInvoice({ actorId, operationId, paymentId, ipAddress, bankModel = bankInvoice, userModel, auditModel, bot = botInstance.bot } = {}) {
  assertAdminUser(actorId);
  const id = String(paymentId ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminServiceError("شناسه پرداخت بانکی نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "BANK_PAYMENT_CONFIRMED", targetType: "payment", targetId: id, ipAddress,
    ...(auditModel ? { auditModel } : {}),
    execute: async () => {
      const out = await confirmBankPayment({ paymentId: id, adminId: actorId, bot, invoiceModel: bankModel, ...(userModel ? { userModel } : {}) });
      if (!["credited", "recovered", "already_confirmed"].includes(out.status)) throw new AdminServiceError(`Bank payment was not confirmed (${out.status}).`, { status: 409, code: `bank_${out.status}` });
      return { ok: true, status: out.status, auditSummary: { status: out.status } };
    },
  });
  return result;
}

export async function rejectBankInvoice({ actorId, operationId, paymentId, reason, ipAddress, bankModel = bankInvoice, auditModel, bot = botInstance.bot } = {}) {
  assertAdminUser(actorId);
  const id = String(paymentId ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminServiceError("شناسه پرداخت بانکی نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  const safeReason = requireReason(reason);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId, operationId, action: "BANK_PAYMENT_REJECTED", targetType: "payment", targetId: id, targetUserId: null, ipAddress,
    metadata: { reason: safeReason },
    ...(auditModel ? { auditModel } : {}),
    execute: async () => {
      const payment = await bankModel.findOneAndUpdate(
        { paymentId: id, paymentType: "bank", status: "waiting_for_approval", balanceCredited: false },
        { $set: { status: "rejected", rejectedAt: new Date(), rejectedBy: String(actorId) } },
        { new: true }
      );
      if (!payment) throw new AdminServiceError("این پرداخت بانکی دیگر در انتظار تأیید نیست.", { status: 409, code: "bank_payment_not_pending" });
      try { await bot?.sendMessage(String(payment.userId), "❌ رسید پرداخت شما بررسی شد. در صورت نیاز با پشتیبانی تماس بگیرید."); } catch { /* Notification failure does not undo a rejected receipt. */ }
      return { ok: true, status: "rejected", auditSummary: { status: "rejected" } };
    },
  });
  return result;
}

export function paymentKeyParts(key) { return parsePaymentKey(key); }
export { NORMALIZED_STATUSES, normalizeStatus, normalizePayment };
