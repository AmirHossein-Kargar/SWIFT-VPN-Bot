import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import { readNowPaymentsConfig } from "../nowpayments/money.js";
import { createNowPaymentsClient } from "../nowpayments/nowpaymentsClient.js";
import { lookupCreationUnknown } from "../nowpayments/creationLookup.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { requireReason } from "./validation.js";

const ORDER_ID = /^NP-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An IPN or the cron lookup gets this long to arrive before a human may give up on an order. */
export const MIN_RELEASE_AGE_MS = 10 * 60_000;

function orderIdFromKey(key) {
  const text = typeof key === "string" ? key : "";
  const orderId = text.startsWith("nowpayments:") ? text.slice("nowpayments:".length) : "";
  if (!ORDER_ID.test(orderId)) {
    throw new AdminServiceError("شناسه پرداخت NOWPayments نامعتبر است.", { status: 400, code: "invalid_payment_id" });
  }
  return orderId;
}

function conflict(message, code) {
  return new AdminServiceError(message, { status: 409, code });
}

function defaultClient(env) {
  const config = readNowPaymentsConfig(env);
  if (!config?.hasCustodyAuth) return null;
  return createNowPaymentsClient({ apiKey: config.apiKey, baseURL: config.baseURL, email: config.email, password: config.password });
}

/**
 * Admin decision for a NOWPayments order stuck in `creation_unknown`: give up on it so the
 * customer's create-lock is released. This is NOT the generic "resolve" (which only records a
 * disposition and never touches the lock) and it moves no money.
 *
 * What it will and will not do:
 *  - Refused unless the order is still `creation_unknown`, uncredited, with no provider payment
 *    bound, and at least MIN_RELEASE_AGE_MS old.
 *  - Runs a fresh authenticated provider lookup when JWT credentials exist. A payment found is
 *    handed to the normal verifier and the lock is NOT released (the order is then settled by the
 *    usual path). Ambiguous or mismatched provider data refuses the release.
 *  - Without a usable lookup (not configured / provider down) the release needs the explicit
 *    `acceptUnverified: true` attestation, recorded in the audit log.
 *  - The release itself is one compare-and-set to `creation_failed` (+ recovery "resolved", who and
 *    why), clearing both lock mechanisms. A later signed IPN for that order is then never credited
 *    automatically: it is flagged for review (existing `ipn_after_rejected_create` behaviour).
 */
export async function releaseCreationUnknownLock({
  actorId,
  operationId,
  key,
  reason,
  acceptUnverified = false,
  ipAddress,
  invoiceModel = NowPaymentsInvoice,
  env = process.env,
  client = undefined,
  now = () => new Date(),
  auditModel,
} = {}) {
  assertAdminUser(actorId);
  const orderId = orderIdFromKey(key);
  // Only a real string counts as a reason (a number would be coerced to digits and pass the length check).
  const safeReason = requireReason(typeof reason === "string" ? reason : "", { min: 10, max: 400 });
  const attested = acceptUnverified === true;

  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "NOWPAYMENTS_CREATION_LOCK_RELEASED",
    targetType: "payment",
    targetId: orderId,
    ipAddress,
    // The audit sanitizer redacts any 32+ character id, so a searchable suffix is kept explicitly.
    metadata: { provider: "nowpayments", orderRef: orderId.slice(-12), reason: safeReason, acceptUnverified: attested },
    resumeStarted: true,
    ...(auditModel ? { auditModel } : {}),
    execute: async ({ resumed } = {}) => {
      const current = await invoiceModel.findOne({ orderId }).lean();
      if (!current) throw new AdminServiceError("پرداخت یا سفارش یافت نشد.", { status: 404, code: "payment_not_found" });

      // The SAME operation resumed after a crash between the update and the audit write. A new operation on an
      // already-released order is not a replay and is refused below.
      if (resumed && current.status === "creation_failed" && current.recoveryStatus === "resolved" && current.recoveryResolvedBy === String(actorId)) {
        return { ok: true, released: true, replayed: true, auditSummary: { released: true, replayed: true } };
      }
      if (current.status !== "creation_unknown") throw conflict("این سفارش در وضعیت «نتیجه ایجاد نامشخص» نیست.", "not_creation_unknown");
      if (current.balanceCredited) throw conflict("این پرداخت قبلاً اعتبار داده شده است.", "already_credited");
      if (current.paymentId) throw conflict("برای این سفارش پرداخت ثبت شده است؛ از بازیابی (تلاش مجدد) استفاده کنید.", "payment_bound");
      const ageMs = now().getTime() - new Date(current.updatedAt || current.createdAt || 0).getTime();
      if (!(ageMs >= MIN_RELEASE_AGE_MS)) throw conflict("هنوز زمان کافی برای دریافت اعلان درگاه نگذشته است؛ بعداً تلاش کنید.", "too_recent");

      let verifiedWithProvider = false;
      const lookupClient = client === undefined ? defaultClient(env) : client;
      if (lookupClient) {
        const found = await lookupCreationUnknown({ invoice: current, client: lookupClient, invoiceModel, now: now() });
        if (found.outcome === "payment_applied") {
          return {
            ok: true,
            released: false,
            reason: "payment_found",
            outcome: found.appliedOutcome || null,
            auditSummary: { released: false, reason: "payment_found" },
          };
        }
        if (["lookup_ambiguous", "lookup_mismatch", "lookup_unconfirmed"].includes(found.outcome)) {
          throw conflict("داده‌های درگاه مبهم یا ناسازگار است؛ قبل از هر اقدامی وضعیت را در پنل NOWPayments بررسی کنید.", "provider_lookup_inconclusive");
        }
        // "Nothing found" only counts when the documented invoiceId filter was the key (conclusive); a date-window
        // scan matched on order_id (not guaranteed to be returned) proves nothing and needs the attestation.
        verifiedWithProvider = found.outcome === "no_payment_found" && found.conclusive !== false;
      }
      if (!verifiedWithProvider && !attested) {
        throw conflict("بررسی خودکار درگاه ممکن نیست؛ پس از بررسی دستی در پنل NOWPayments، تأیید صریح لازم است.", "provider_lookup_required");
      }

      const at = now();
      const moved = await invoiceModel.updateOne(
        { orderId, status: "creation_unknown", balanceCredited: false, paymentId: { $in: [null, ""] } },
        {
          $set: {
            status: "creation_failed",
            recoveryStatus: "resolved",
            recoveryReason: safeReason,
            recoveryResolvedAt: at,
            recoveryResolvedBy: String(actorId),
            updatedAt: at,
          },
          $unset: { openCreateKey: 1, nextRetryAt: 1 },
        },
      );
      if (!(Number(moved?.modifiedCount ?? moved?.nModified ?? 0) > 0)) {
        throw conflict("وضعیت سفارش هم‌زمان تغییر کرد؛ دوباره بررسی کنید.", "state_changed");
      }
      return {
        ok: true,
        released: true,
        verifiedWithProvider,
        financialMutation: false,
        auditSummary: { released: true, verifiedWithProvider, financialMutation: false },
      };
    },
  });
  return result;
}
