import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import PaymentTombstone from "../../models/PaymentTombstone.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";

/**
 * Admin deletion of payment records (top-up invoices only).
 *
 * Invariants this module protects:
 *  - Wallet purchases (WalletPurchase), balances, the admin audit log and the
 *    user's idempotency ledgers (User.appliedPaymentKeys ...) are NEVER touched.
 *  - A record is deletable only when it provably moved no money: not credited,
 *    not fulfilled, no tracking code / transaction hash / received amount, not
 *    flagged for recovery, and (for manual bank receipts) no receipt submitted.
 *    Eligibility is decided by the same conditional filter that performs the
 *    delete, so a status that changes between preview and delete (a webhook
 *    marking it paid, a scanner claiming it) makes the delete a no-op instead
 *    of removing a live record. Nothing from the browser is trusted.
 *  - Two classes qualify:
 *      rejected — the provider/admin already ended it without payment.
 *      stale    — still pending/expired but older than PENDING_MIN_AGE (default
 *                 72h, floor 24h, ADMIN_PENDING_DELETE_MIN_HOURS) and past the
 *                 provider expiry when one is stored.
 *    Funds-in-flight states (NOWPayments confirming/confirmed/sending/
 *    partially_paid/finished, creation_unknown, paid) never qualify.
 *  - Every deletion first writes an immutable PaymentTombstone (provider,
 *    reference, user, amount, final status). HooshPay/NOWPayments webhook
 *    handlers look tombstones up and record a late event instead of crediting,
 *    so a late notification can never credit twice.
 *
 * Known limitation (documented in docs/admin.md): if a customer really pays a
 * stale-pending invoice AFTER it was deleted, the provider notification is
 * recorded on the tombstone but does not credit automatically; it needs manual
 * reconciliation. The age floor and provider-expiry check exist to make that
 * very unlikely.
 */
export const MAX_DELETE_BATCH = 100;
const DEFAULT_MIN_PENDING_HOURS = 72;
const FLOOR_MIN_PENDING_HOURS = 24;

export function pendingMinAgeMs(env = process.env) {
  const configured = Number(env.ADMIN_PENDING_DELETE_MIN_HOURS);
  const hours = Number.isFinite(configured) && configured > 0 ? Math.max(FLOOR_MIN_PENDING_HOURS, configured) : DEFAULT_MIN_PENDING_HOURS;
  return hours * 60 * 60 * 1000;
}

const NOT_CREDITED = { balanceCredited: { $ne: true }, recoveryStatus: { $ne: "required" } };

export const DELETION_SOURCES = Object.freeze({
  hooshpay: {
    model: HooshPayInvoice,
    idField: "uid",
    orderField: "orderId",
    rejected: ["failed", "cancelled"],
    stale: ["pending", "expired"],
    guard: { ...NOT_CREDITED, fulfilled: { $ne: true }, paidAt: null, trackingCode: null },
    staleExtras: (now) => ({ $or: [{ expiresAt: null }, { expiresAt: { $lte: now } }] }),
    tombstone: (doc) => ({ uid: doc.uid || null, amountToman: Number.isFinite(doc.amount) ? doc.amount : null }),
  },
  nowpayments: {
    model: NowPaymentsInvoice,
    idField: "orderId",
    orderField: "orderId",
    rejected: ["failed"],
    stale: ["creating", "creation_failed", "pending", "waiting", "expired"],
    guard: { ...NOT_CREDITED, actuallyPaid: { $in: [null, 0] }, paidAt: null },
    staleExtras: () => ({}),
    tombstone: (doc) => ({
      invoiceId: doc.invoiceId || null,
      paymentId: doc.paymentId || null,
      amountToman: Number.isFinite(doc.amountToman) ? doc.amountToman : null,
    }),
  },
  bank: {
    model: bankInvoice,
    idField: "paymentId",
    orderField: "paymentId",
    rejected: ["rejected"],
    stale: ["unpaid", "pending", "waiting_for_approval"],
    guard: { ...NOT_CREDITED, confirmedAt: null, trackingCode: null },
    // A submitted receipt may represent real money: the admin must decide it, never a cleanup.
    staleExtras: () => ({ receiptFileId: null }),
    tombstone: (doc) => ({ paymentId: doc.paymentId || null, amountToman: Number.isFinite(doc.amount) ? doc.amount : null }),
  },
  trx: {
    model: CryptoInvoice,
    idField: "invoiceId",
    orderField: "invoiceId",
    rejected: ["rejected"],
    stale: ["unpaid"],
    guard: { ...NOT_CREDITED, transactionHash: null, confirmedAt: null },
    staleExtras: () => ({}),
    tombstone: (doc) => ({ invoiceId: doc.invoiceId || null, amountToman: Number.isFinite(doc.amount) ? doc.amount : null }),
  },
});

const REASONS = {
  not_found: "این پرداخت دیگر وجود ندارد.",
  wallet_order: "سفارش‌های کیف پول قابل حذف نیستند.",
  credited: "این پرداخت اعتبار کیف پول را تغییر داده و قابل حذف نیست.",
  recovery: "این پرداخت در صف بازیابی است و قابل حذف نیست.",
  funds_seen: "برای این پرداخت وجه یا کد پیگیری ثبت شده است.",
  receipt: "رسید ارسال شده و باید توسط مدیر بررسی شود.",
  status: "وضعیت این پرداخت برای حذف مجاز نیست.",
  too_new: "این پرداخت هنوز به حداقل سن حذف نرسیده است.",
  not_expired: "مهلت این پرداخت هنوز تمام نشده است.",
  changed: "وضعیت پرداخت هم‌زمان تغییر کرد و حذف نشد.",
};

/** Conditional filter that is the single authority for "may be deleted now". */
export function deletionFilter(provider, doc, { now = new Date(), minAgeMs = pendingMinAgeMs() } = {}) {
  const source = DELETION_SOURCES[provider];
  if (!source) return null;
  if (source.rejected.includes(doc.status)) {
    return { status: { $in: source.rejected }, ...source.guard };
  }
  if (source.stale.includes(doc.status)) {
    const cutoff = new Date(now.getTime() - minAgeMs);
    return { status: { $in: source.stale }, createdAt: { $lte: cutoff }, ...source.guard, ...source.staleExtras(now) };
  }
  return null;
}

/** Human explanation of the same rules, for the UI and for tests. The filter still decides. */
export function explainDeletion(provider, doc, { now = new Date(), minAgeMs = pendingMinAgeMs() } = {}) {
  const source = DELETION_SOURCES[provider];
  if (!source) return { eligible: false, code: "wallet_order", reason: REASONS.wallet_order };
  if (!doc) return { eligible: false, code: "not_found", reason: REASONS.not_found };
  const no = (code) => ({ eligible: false, code, reason: REASONS[code] });
  if (doc.balanceCredited === true || doc.fulfilled === true) return no("credited");
  if (doc.recoveryStatus === "required") return no("recovery");
  const rejected = source.rejected.includes(doc.status);
  const stale = source.stale.includes(doc.status);
  if (!rejected && !stale) return no("status");
  if (doc.paidAt || doc.trackingCode || doc.transactionHash || doc.confirmedAt || Number(doc.actuallyPaid) > 0) return no("funds_seen");
  if (rejected) return { eligible: true, code: "rejected", reason: null, class: "rejected" };
  if (provider === "bank" && doc.receiptFileId) return no("receipt");
  const created = doc.createdAt ? new Date(doc.createdAt).getTime() : NaN;
  if (!Number.isFinite(created) || now.getTime() - created < minAgeMs) return no("too_new");
  if (provider === "hooshpay" && doc.expiresAt && new Date(doc.expiresAt).getTime() > now.getTime()) return no("not_expired");
  return { eligible: true, code: "stale", reason: null, class: "stale" };
}

export function parseDeletionKey(key) {
  if (typeof key !== "string" || key.length > 180) throw new AdminServiceError("شناسه پرداخت نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  const separator = key.indexOf(":");
  const provider = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator < 1 || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new AdminServiceError("شناسه پرداخت نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  if (provider === "wallet") throw new AdminServiceError("سفارش‌های کیف پول قابل حذف نیستند.", { status: 400, code: "wallet_order_not_deletable" });
  if (!DELETION_SOURCES[provider]) throw new AdminServiceError("شناسه پرداخت نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  return { provider, id };
}

function parseKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_DELETE_BATCH) {
    throw new AdminServiceError(`بین ۱ تا ${MAX_DELETE_BATCH} پرداخت انتخاب کنید.`, { status: 400, code: "invalid_selection" });
  }
  const unique = [...new Set(keys)];
  return unique.map((key) => ({ key, ...parseDeletionKey(key) }));
}

async function loadAndEvaluate(entries, opts) {
  const results = [];
  for (const entry of entries) {
    const source = DELETION_SOURCES[entry.provider];
    const query = source.model.findOne({ [source.idField]: entry.id });
    const doc = typeof query?.lean === "function" ? await query.lean() : await query;
    results.push({ ...entry, doc, verdict: explainDeletion(entry.provider, doc, opts) });
  }
  return results;
}

/** Read-only: which of the selected records could be deleted right now. */
export async function previewPaymentDeletion({ actorId, keys, now = new Date(), minAgeMs = pendingMinAgeMs() } = {}) {
  assertAdminUser(actorId);
  const entries = parseKeys(keys);
  const evaluated = await loadAndEvaluate(entries, { now, minAgeMs });
  const items = evaluated.map(({ key, verdict }) => ({ key, eligible: verdict.eligible, class: verdict.class || null, code: verdict.code, reason: verdict.reason }));
  return {
    requested: items.length,
    eligible: items.filter((item) => item.eligible).length,
    ineligible: items.filter((item) => !item.eligible).length,
    minPendingAgeHours: Math.round(minAgeMs / 3_600_000),
    items,
  };
}

/**
 * Delete eligible payment records.
 *
 * All-or-nothing preflight: if ANY selected record is ineligible, nothing is
 * deleted and the ineligible ones are reported. After preflight each delete is
 * individually conditional, so a record that becomes ineligible in the window
 * is skipped (and reported) rather than removed.
 */
export async function deletePayments({ actorId, operationId, keys, confirmCount, ipAddress, now = new Date(), minAgeMs = pendingMinAgeMs(), tombstoneModel = PaymentTombstone, auditModel } = {}) {
  assertAdminUser(actorId);
  const entries = parseKeys(keys);
  if (Number(confirmCount) !== entries.length) {
    throw new AdminServiceError("تعداد تأییدشده با تعداد انتخاب‌شده برابر نیست.", { status: 400, code: "confirm_count_mismatch" });
  }

  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PAYMENTS_DELETED",
    targetType: "payment",
    targetId: `${entries.length} records`,
    ipAddress,
    metadata: { count: entries.length, keys: entries.slice(0, 20).map((entry) => entry.key) },
    ...(auditModel ? { auditModel } : {}),
    execute: async () => {
      const evaluated = await loadAndEvaluate(entries, { now, minAgeMs });
      const blocked = evaluated.filter((item) => !item.verdict.eligible);
      if (blocked.length) {
        throw new AdminServiceError("برخی پرداخت‌های انتخاب‌شده قابل حذف نیستند؛ هیچ موردی حذف نشد.", {
          status: 409,
          code: "payments_not_deletable",
          details: blocked.slice(0, 50).map((item) => ({ key: item.key, code: item.verdict.code, reason: item.verdict.reason })),
        });
      }

      const deleted = [];
      const skipped = [];
      for (const item of evaluated) {
        const source = DELETION_SOURCES[item.provider];
        const filter = deletionFilter(item.provider, item.doc, { now, minAgeMs });
        const orderId = String(item.doc[source.orderField] || "");
        if (!filter || !orderId) { skipped.push({ key: item.key, code: "changed", reason: REASONS.changed }); continue; }

        // Tombstone first: if the delete then fails, the invoice still exists and
        // the unfinished tombstone (deletedAt null) is visible; the reverse order
        // could leave a deleted invoice with no tombstone.
        try {
          await tombstoneModel.updateOne(
            { provider: item.provider, orderId },
            {
              $setOnInsert: {
                provider: item.provider,
                orderId,
                userId: Number.isFinite(item.doc.userId) ? item.doc.userId : null,
                finalStatus: String(item.doc.status).slice(0, 40),
                invoiceCreatedAt: item.doc.createdAt || null,
                terminalStatusAt: item.doc.terminalStatusAt || now,
                ...source.tombstone(item.doc),
              },
            },
            { upsert: true },
          );
        } catch (error) {
          if (error?.code !== 11000) throw error;
        }

        const removed = await source.model.deleteOne({ _id: item.doc._id, ...filter });
        if (Number(removed?.deletedCount || 0) > 0) {
          deleted.push(item.key);
          await tombstoneModel.updateOne({ provider: item.provider, orderId, deletedAt: null }, { $set: { deletedAt: now } });
        } else {
          skipped.push({ key: item.key, code: "changed", reason: REASONS.changed });
        }
      }
      return {
        requested: entries.length,
        deleted: deleted.length,
        skipped,
        deletedKeys: deleted,
        auditSummary: { requested: entries.length, deleted: deleted.length, skipped: skipped.length },
      };
    },
  });
  return result;
}
