import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { createVpnService } from "../../api/wizardApi.js";
import { isAdminUser } from "../../utils/auth.js";
import { runProviderCreation } from "./purchaseService.js";
import { deliverPurchaseNotificationById, refundPurchaseReservation } from "./purchaseLedger.js";

/**
 * Admin actions on wallet purchases parked in `awaiting_provider` (provider wallet short of funds).
 *
 * State machine (forward-only, enforced by models/WalletPurchase.js and by filtering every write on its source state):
 *
 *   provisioning --(provider proved short of funds)--> awaiting_provider
 *   awaiting_provider --(admin approve, atomic claim)--> provisioning --> provisioned --> completed
 *                                                          |-- short again --> awaiting_provider
 *                                                          |-- ambiguous    --> manual_review (never replayed)
 *   awaiting_provider --(admin cancel)--> refund_pending --> refunded
 *
 * Financial invariants: the customer debit made at reservation time is never repeated (the claim re-enters the same
 * provider step with the same purchaseId/ledger keys); the provider is charged by WizardXray's own `create` and the bot
 * never debits it separately; an approve click is only a request to *attempt* creation, the order becomes `completed`
 * solely after a validated provider response is persisted; approve and cancel race on the same `awaiting_provider`
 * filter so exactly one wins; a create already in flight (`provisioning`) can be neither re-claimed nor cancelled.
 */

const OBJECT_ID = /^[a-f0-9]{24}$/;
const EVENT_LIMIT = 50;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "reserved-orders", level, message, ...meta })
  );
}

const event = (type, actor, from, to) => ({
  $push: { events: { $each: [{ at: new Date(), type, actor: actor == null ? null : String(actor), from, to }], $slice: -EVENT_LIMIT } },
});

export function isValidOrderRef(ref) {
  return typeof ref === "string" && OBJECT_ID.test(ref);
}

export async function loadReservedOrder(orderRef, { purchaseModel = WalletPurchase } = {}) {
  if (!isValidOrderRef(orderRef)) return null;
  return purchaseModel.findOne({ _id: orderRef }).lean();
}

/** Pure status read for the "recheck" button. Does not contact the provider. */
export async function refreshReservedOrder({ orderRef, adminId, purchaseModel = WalletPurchase }) {
  if (!isAdminUser(adminId)) return { outcome: "forbidden" };
  const purchase = await loadReservedOrder(orderRef, { purchaseModel });
  return purchase ? { outcome: "status", purchase } : { outcome: "not_found" };
}

/**
 * Admin approval. Returns { outcome, purchase, notified }:
 *  forbidden | not_found | not_claimable (current state returned) | invalid_reservation |
 *  fulfilled | still_short | unknown_outcome | refunded | pending
 */
export async function approveReservedOrder({
  orderRef,
  adminId,
  bot,
  createService = createVpnService,
  deliver = deliverPurchaseNotificationById,
  purchaseModel = WalletPurchase,
  userModel = User,
}) {
  if (!isAdminUser(adminId)) return { outcome: "forbidden" };
  const existing = await loadReservedOrder(orderRef, { purchaseModel });
  if (!existing) return { outcome: "not_found" };
  const { purchaseId, telegramId } = existing;

  if (existing.status !== "awaiting_provider") {
    return { outcome: "not_claimable", purchase: existing };
  }

  // The customer's debit must still be a live reservation (applied and not refunded) before provider spend is attempted.
  const reservationLive = existing.walletDebitStatus === "reserved" && await userModel.exists({
    telegramId: String(telegramId),
    appliedPurchaseReservations: purchaseId,
    refundedPurchaseIds: { $ne: purchaseId },
  });
  if (!reservationLive) {
    await purchaseModel.updateOne(
      { _id: orderRef, status: "awaiting_provider" },
      { $set: { recoveryStatus: "required", recoveryReason: "RESERVATION_NOT_VERIFIED" } }
    ).catch(() => {});
    log("error", "Reserved order has no live customer reservation; fulfillment refused", { purchaseId });
    return { outcome: "invalid_reservation", purchase: existing };
  }

  // Atomic single-claimant transition: of any number of concurrent/repeated approvals only one matches this filter.
  const claimed = await purchaseModel.findOneAndUpdate(
    { _id: orderRef, status: "awaiting_provider" },
    {
      $set: {
        status: "provisioning",
        provisioningStartedAt: new Date(),
        fulfillmentClaimedBy: String(adminId),
        errorCode: null,
        adminAlertPending: false,
        recoveryStatus: "none",
        recoveryReason: null,
      },
      $inc: { fulfillmentAttempts: 1 },
      ...event("admin_approved", adminId, "awaiting_provider", "provisioning"),
    },
    { new: true }
  );
  if (!claimed) {
    return { outcome: "not_claimable", purchase: await loadReservedOrder(orderRef, { purchaseModel }) };
  }
  log("info", "Reserved order claimed for fulfillment", { purchaseId, adminId: String(adminId) });

  // Terms come from the persisted order (what the customer was charged for), never from callback data.
  const plan = { id: claimed.planId, name: claimed.planName, days: claimed.days, gig: claimed.gig, price: claimed.amount };
  let result;
  try {
    result = await runProviderCreation({
      purchaseModel,
      userModel,
      createService,
      provisioning: claimed,
      plan,
      purchaseId,
      telegramId: String(telegramId),
    });
  } catch (error) {
    // Unexpected failure after the claim: the order stays `provisioning` and the recovery cycle converts a stale one to
    // manual_review. It is never replayed against the provider.
    log("error", "Reserved order fulfillment threw after claim", { purchaseId, errorType: error?.name || "Error" });
    return { outcome: "unknown_outcome", purchase: await loadReservedOrder(orderRef, { purchaseModel }) };
  }

  const purchase = await loadReservedOrder(orderRef, { purchaseModel });
  const transition = (type, to) => purchaseModel.updateOne({ _id: orderRef }, event(type, adminId, "provisioning", to)).catch(() => {});

  if (result.status === "completed") {
    await transition("provider_created", "completed");
    let notified = false;
    try {
      notified = await deliver(purchaseId, bot);
    } catch {
      // Delivery stays pending in the durable outbox (notificationPending) and is retried by the recovery cycle.
    }
    log(notified ? "info" : "warn", notified ? "Reserved order fulfilled and delivered" : "Reserved order fulfilled; delivery pending retry", { purchaseId });
    return { outcome: "fulfilled", purchase: await loadReservedOrder(orderRef, { purchaseModel }), notified };
  }
  if (result.status === "awaiting_provider") {
    await transition("provider_still_short", "awaiting_provider");
    return { outcome: "still_short", purchase };
  }
  if (result.status === "refunded") {
    // The provider definitively refused for a reason other than missing funds: the debit was refunded exactly once.
    try {
      await bot?.sendMessage?.(String(telegramId), "❌ ایجاد سرویس انجام نشد و مبلغ سفارش به کیف پول شما بازگشت.");
    } catch {
      // The refund is already recorded.
    }
    return { outcome: "refunded", purchase };
  }
  if (["manual_review", "uncertain"].includes(result.status)) {
    await transition("provider_outcome_unknown", "manual_review");
    return { outcome: "unknown_outcome", purchase };
  }
  return { outcome: "pending", purchase };
}

/**
 * Admin cancellation with refund. Allowed only from `awaiting_provider` (no provider request possible) or to resume an
 * interrupted admin cancellation. A `provisioning` order is refused: a create may be in flight.
 * Returns { outcome: forbidden | not_found | not_cancellable | cancelled | already_cancelled | refund_pending, purchase }.
 */
export async function cancelReservedOrder({
  orderRef,
  adminId,
  bot,
  purchaseModel = WalletPurchase,
  userModel = User,
}) {
  if (!isAdminUser(adminId)) return { outcome: "forbidden" };
  const existing = await loadReservedOrder(orderRef, { purchaseModel });
  if (!existing) return { outcome: "not_found" };

  const resumingAdminCancel = existing.status === "refund_pending" && existing.refundReason === "ADMIN_CANCELLED_RESERVED";
  if (existing.status === "refunded" && existing.refundReason === "ADMIN_CANCELLED_RESERVED") {
    return { outcome: "already_cancelled", purchase: existing };
  }
  if (existing.status !== "awaiting_provider" && !resumingAdminCancel) {
    return { outcome: "not_cancellable", purchase: existing };
  }

  let refund;
  try {
    refund = await refundPurchaseReservation(existing, {
      allowAwaitingProvider: true,
      reason: "ADMIN_CANCELLED_RESERVED",
      errorCode: "ADMIN_CANCELLED_RESERVED",
      userModel,
      purchaseModel,
    });
  } catch (error) {
    if (error?.code === "PURCHASE_NOT_REFUNDABLE") {
      // Lost the race to a concurrent approve (now provisioning) or another terminal transition.
      return { outcome: "not_cancellable", purchase: await loadReservedOrder(orderRef, { purchaseModel }) };
    }
    log("error", "Reserved order cancellation refund is pending recovery", { purchaseId: existing.purchaseId, code: error?.code });
    return { outcome: "refund_pending", purchase: await loadReservedOrder(orderRef, { purchaseModel }) };
  }

  const purchase = await loadReservedOrder(orderRef, { purchaseModel });
  if (refund.alreadyRefunded) return { outcome: "already_cancelled", purchase };

  await purchaseModel.updateOne({ _id: orderRef }, event("admin_cancelled", adminId, "awaiting_provider", "refunded")).catch(() => {});
  log("info", "Reserved order cancelled and refunded", { purchaseId: existing.purchaseId, adminId: String(adminId) });
  if (bot?.sendMessage) {
    try {
      await bot.sendMessage(
        String(existing.telegramId),
        "ℹ️ سفارش شما لغو شد و مبلغ آن به کیف پولتان بازگشت. در صورت تمایل می‌توانید دوباره سفارش ثبت کنید."
      );
    } catch {
      // The refund is already recorded; a blocked chat does not affect the money.
    }
  }
  return { outcome: "cancelled", purchase };
}
