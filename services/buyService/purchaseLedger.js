import User from "../../models/User.js";
import { observeDelivery } from "../reliability/telemetry.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { getSuccessServiceMessage, guideButtons } from "../../messages/staticMessages.js";
import escapeHtml from "../../utils/escapeHtml.js";
import { scheduleUserSpendRecompute } from "../users/userSpend.js";
import { subscriptionLink } from "../subscriptionLink.js";
import { sendWithQrCode } from "../qrCode.js";
import { retryPendingReservedAlerts, retryPendingReservedNotices } from "./reservedAlerts.js";

const NOTIFICATION_CLAIM_MS = 5 * 60_000;
const RECOVERY_STALE_MS = 5 * 60_000;
export const NOTIFICATION_MAX_ATTEMPTS = 30;
const NOTIFICATION_BACKOFF_BASE_MS = 5 * 60_000;
const NOTIFICATION_BACKOFF_MAX_MS = 24 * 60 * 60_000;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "buy-service", level, message, ...meta })
  );
}

function validateWalletOperation({ telegramId, amount, purchaseId }) {
  const normalizedId = String(telegramId ?? "").trim();
  if (!/^\d{1,32}$/.test(normalizedId)) throw new TypeError("telegramId must be a numeric Telegram ID");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError("amount must be a positive safe integer");
  if (typeof purchaseId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(purchaseId)) {
    throw new TypeError("purchaseId must be a safe order identifier");
  }
  return normalizedId;
}

/**
 * Atomically reserve one customer-price amount. The conditional balance check
 * and decrement are a single MongoDB document operation, so concurrent orders
 * cannot spend the same funds. The per-user purchase key also makes retries
 * idempotent if the balance write succeeded but its response was lost.
 */
export async function reserveBalance(telegramId, amount, purchaseId, { userModel = User } = {}) {
  const normalizedId = validateWalletOperation({ telegramId, amount, purchaseId });
  const user = await userModel.findOneAndUpdate(
    {
      telegramId: normalizedId,
      balance: { $gte: amount },
      appliedPurchaseReservations: { $ne: purchaseId },
    },
    {
      $inc: { balance: -amount },
      $addToSet: { appliedPurchaseReservations: purchaseId },
    },
    { new: true }
  );

  if (user) return { user, reserved: true, alreadyReserved: false, exists: true };

  const alreadyReserved = await userModel.findOne({
    telegramId: normalizedId,
    appliedPurchaseReservations: purchaseId,
  }).select("_id balance appliedPurchaseReservations refundedPurchaseIds").lean();
  if (alreadyReserved) return { user: alreadyReserved, reserved: true, alreadyReserved: true, exists: true };

  const existingUser = await userModel.findOne({ telegramId: normalizedId }).select("_id balance").lean();
  return {
    user: existingUser,
    reserved: false,
    alreadyReserved: false,
    exists: Boolean(existingUser),
  };
}

/**
 * Refund a prior reservation exactly once. Refund metadata is written to the
 * existing WalletPurchase record before crediting the wallet; the User ledger
 * key and increment then change atomically. A retry after any crash resumes
 * from refund_pending without issuing a second credit.
 */
export async function refundPurchaseReservation(
  purchase,
  { allowProvisioning = false, allowAwaitingProvider = false, reason, errorCode, userModel = User, purchaseModel = WalletPurchase } = {}
) {
  const purchaseId = String(purchase?.purchaseId ?? "");
  const telegramId = String(purchase?.telegramId ?? "");
  const amount = Number(purchase?.amount);
  validateWalletOperation({ telegramId, amount, purchaseId });

  const safeReason = String(reason || purchase?.errorCode || "PURCHASE_FAILED")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 80) || "PURCHASE_FAILED";
  const allowedStates = ["reserving", "reserved", "refund_pending"];
  if (allowProvisioning) allowedStates.push("provisioning");
  // Only an explicit admin cancellation may refund an order that is waiting for provider funds.
  if (allowAwaitingProvider) allowedStates.push("awaiting_provider");

  let refundIntent;
  try {
    refundIntent = await purchaseModel.findOneAndUpdate(
      { purchaseId, status: { $in: allowedStates } },
      {
        $set: {
          status: "refund_pending",
          refundStatus: "pending",
          refundAmount: amount,
          refundReason: safeReason,
          ...(typeof errorCode === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(errorCode)
            ? { errorCode }
            : {}),
        },
      },
      { new: true }
    );
  } catch (error) {
    error.code = error.code || "REFUND_INTENT_WRITE_FAILED";
    throw error;
  }

  if (!refundIntent) {
    const current = await purchaseModel.findOne({ purchaseId }).lean();
    if (current?.status === "refunded" && current.refundStatus === "completed") {
      return { refunded: true, alreadyRefunded: true, purchase: current };
    }
    if (current?.status === "refund_pending" && current.refundStatus === "pending") {
      refundIntent = current;
    } else {
      const error = new Error("Purchase is not in a refundable state");
      error.code = "PURCHASE_NOT_REFUNDABLE";
      throw error;
    }
  }

  // First write wins: a refund's age is measured from its FIRST request, so retries (recovery re-enters this function every
  // cycle) never reset it. A purchase has exactly one refund lifecycle (refund_pending -> refunded is terminal, see
  // models/WalletPurchase.js), so there is no second lifecycle that would need a fresh timestamp. Best effort: if this write
  // is lost, System Health falls back to createdAt and the next retry sets it.
  await purchaseModel.updateOne(
    { purchaseId, status: "refund_pending", refundRequestedAt: null },
    { $set: { refundRequestedAt: new Date() } }
  ).catch(() => {});

  const refundAmount = Number(refundIntent.refundAmount ?? amount);
  if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0 || refundAmount !== amount) {
    const error = new Error("Purchase refund amount does not match its original wallet debit");
    error.code = "REFUND_AMOUNT_MISMATCH";
    throw error;
  }

  const creditedUser = await userModel.findOneAndUpdate(
    {
      telegramId,
      appliedPurchaseReservations: purchaseId,
      refundedPurchaseIds: { $ne: purchaseId },
    },
    {
      $inc: { balance: refundAmount },
      $addToSet: { refundedPurchaseIds: purchaseId },
    },
    { new: true }
  );

  let alreadyCredited = false;
  if (!creditedUser) {
    alreadyCredited = Boolean(await userModel.exists({ telegramId, refundedPurchaseIds: purchaseId }));
    if (!alreadyCredited) {
      await purchaseModel.updateOne(
        { purchaseId, status: "refund_pending" },
        { $set: { recoveryStatus: "required", recoveryReason: "REFUND_LEDGER_NOT_APPLIED" } }
      ).catch(() => {});
      const error = new Error("Purchase refund is pending financial recovery");
      error.code = "REFUND_NOT_APPLIED";
      throw error;
    }
  }

  const completed = await purchaseModel.findOneAndUpdate(
    { purchaseId, status: "refund_pending", refundStatus: "pending" },
    {
      $set: {
        status: "refunded",
        refundStatus: "completed",
        refundAmount,
        refundReason: safeReason,
        refundedAt: new Date(),
        walletDebitStatus: "refunded",
        recoveryStatus: "none",
        recoveryReason: null,
      },
      $unset: { recoveryClaimedAt: 1 },
    },
    { new: true }
  );

  if (!completed) {
    const current = await purchaseModel.findOne({ purchaseId }).lean();
    if (current?.status !== "refunded" || current.refundStatus !== "completed") {
      const error = new Error("Refund was credited but its purchase ledger needs recovery");
      error.code = "REFUND_LEDGER_PENDING";
      throw error;
    }
    return { refunded: true, alreadyRefunded: true, purchase: current };
  }

  return { refunded: true, alreadyRefunded: alreadyCredited, purchase: completed, user: creditedUser || null };
}

/** Persist provider fulfillment to the owning user and finalize the debit. */
export async function commitProvisionedPurchase(
  purchase,
  bot,
  { userModel = User, purchaseModel = WalletPurchase } = {}
) {
  if (!purchase?.purchaseId || typeof purchase.serviceUsername !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(purchase.serviceUsername)) {
    throw new Error("Provisioned purchase is missing a valid service username");
  }

  const provisionedAt = purchase.provisionedAt || purchase.completedAt || new Date();
  const expiresAt = purchase.expiresAt || new Date(provisionedAt.getTime() + Number(purchase.days) * 24 * 60 * 60 * 1000);
  const user = await userModel.findOneAndUpdate(
    {
      telegramId: String(purchase.telegramId),
      completedPurchaseIds: { $ne: purchase.purchaseId },
      "services.purchaseId": { $ne: purchase.purchaseId },
    },
    {
      $push: {
        services: {
          username: purchase.serviceUsername,
          sub_link: purchase.serviceLink || null,
          purchaseId: purchase.purchaseId,
          productId: purchase.planId,
          trafficGb: Number(purchase.gig),
          createdAt: provisionedAt,
          expiresAt,
        },
      },
      $addToSet: { completedPurchaseIds: purchase.purchaseId },
      $inc: { totalServices: 1 },
    },
    { new: true }
  );

  let owner = user;
  if (!owner) {
    owner = await userModel.findOne({
      telegramId: String(purchase.telegramId),
      completedPurchaseIds: purchase.purchaseId,
      "services.purchaseId": purchase.purchaseId,
    });
    if (!owner) throw new Error("Could not persist provisioned service to its wallet owner");
  }

  let completed = await purchaseModel.findOneAndUpdate(
    { purchaseId: purchase.purchaseId, status: "provisioned" },
    {
      $set: {
        status: "completed",
        walletDebitStatus: "finalized",
        completedAt: purchase.completedAt || new Date(),
        provisionedAt,
        expiresAt,
        notificationPending: true,
        recoveryStatus: "none",
        recoveryReason: null,
      },
      $unset: { recoveryClaimedAt: 1 },
    },
    { new: true }
  );

  if (!completed) {
    completed = await purchaseModel.findOne({ purchaseId: purchase.purchaseId, status: "completed" });
    if (!completed) throw new Error("Purchase was committed to the user but its ledger needs recovery");
    // Additive for legacy completed records. Never re-open or re-notify a settled purchase.
    await purchaseModel.updateOne(
      { purchaseId: purchase.purchaseId, status: "completed" },
      { $set: { walletDebitStatus: "finalized" } }
    );
  }

  // Derived reporting counters only. Fire-and-forget: never awaited, never throws, cannot change this result;
  // a lost update is repaired by the user-spend sweeper (services/users/userSpendSweeper.js).
  scheduleUserSpendRecompute(completed.telegramId ?? purchase.telegramId, { userModel, purchaseModel });

  const notified = await notifyPurchaseOnce(completed, bot, owner);
  return { purchase: completed, notified };
}

async function notifyPurchaseOnce(purchase, bot, user) {
  if (!purchase?.notificationPending || !bot?.sendPhoto) return false;
  const now = new Date();
  const stale = new Date(now.getTime() - NOTIFICATION_CLAIM_MS);
  const claim = await WalletPurchase.findOneAndUpdate(
    {
      _id: purchase._id,
      status: "completed",
      notificationPending: true,
      $or: [{ notificationClaimedAt: null }, { notificationClaimedAt: { $lt: stale } }],
    },
    { $set: { notificationClaimedAt: now } },
    { new: true }
  );
  if (!claim) return false;

  try {
    const smartLink = subscriptionLink({ link: claim.serviceLink, hash: claim.serviceHash }) || "";
    const caption = getSuccessServiceMessage({
      username: escapeHtml(claim.serviceUsername),
      smartLink: escapeHtml(smartLink),
      singleLink: escapeHtml(claim.singleLink),
    });
    await sendWithQrCode(bot, String(claim.telegramId), smartLink, caption, { parse_mode: "HTML", disable_web_page_preview: true, ...guideButtons });
    await WalletPurchase.findOneAndUpdate(
      { _id: claim._id, notificationClaimedAt: now, notificationPending: true },
      { $set: { notificationPending: false, notifiedAt: new Date() }, $unset: { notificationClaimedAt: 1 } }
    );
    observeDelivery({ orderKey: `wallet:${claim.purchaseId}`, ok: true, ms: Date.now() - now.getTime() });
    return true;
  } catch (error) {
    observeDelivery({ orderKey: `wallet:${claim.purchaseId}`, ok: false, code: error?.name });
    // Bounded retries with exponential backoff: delivery stays eventual (the service already exists and is never
    // recreated), but a blocked chat cannot be hammered every recovery cycle. After the cap it stays visible in the
    // admin recovery queue as "delivery-notification-pending".
    const attempts = Number(claim.notificationAttempts || 0) + 1;
    const delay = Math.min(NOTIFICATION_BACKOFF_BASE_MS * 2 ** (attempts - 1), NOTIFICATION_BACKOFF_MAX_MS);
    await WalletPurchase.updateOne(
      { _id: claim._id, notificationClaimedAt: now },
      { $set: { notificationAttempts: attempts, notificationNextAt: new Date(Date.now() + delay) } }
    ).catch(() => {});
    log("warn", "Purchase delivery notification failed", {
      purchaseId: claim.purchaseId,
      attempts,
      errorType: error?.name || "TelegramError",
    });
    return false;
  }
}

async function alertAdmin(bot, purchase, reason) {
  const updated = purchase?._id
    ? await WalletPurchase.findOneAndUpdate(
        { _id: purchase._id, adminAlertedAt: null },
        { $set: { adminAlertedAt: new Date() } },
        { new: true }
      )
    : purchase;
  if (!updated) return;
  const groupId = process.env.GROUP_ID;
  if (!groupId || !bot?.sendMessage) return;
  try {
    await bot.sendMessage(
      groupId,
      `🚨 <b>خرید کیف پول نیاز به بررسی دستی دارد</b>\n\n` +
        `شناسه: <code>${escapeHtml(purchase.purchaseId)}</code>\n` +
        `کاربر: <code>${escapeHtml(purchase.telegramId)}</code>\n` +
        `مبلغ رزرو‌شده: <code>${Number(purchase.amount).toLocaleString("en-US")}</code> تومان\n` +
        `پلن: <code>${escapeHtml(purchase.planName || purchase.planId)}</code>\n` +
        `وضعیت: <code>${escapeHtml(purchase.status)}</code>\n` +
        `علت: <code>${escapeHtml(reason)}</code>\n\n` +
        `تا زمان تطبیق با پنل، کاربر را برای خرید مجدد راهنمایی نکنید.`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    log("error", "Admin alert delivery failed", {
      purchaseId: purchase.purchaseId,
      errorType: error?.name || "TelegramError",
    });
  }
}

export async function notifyPurchaseRecovery(purchase, bot) {
  return notifyPurchaseOnce(purchase, bot, await User.findOne({ telegramId: String(purchase.telegramId) }));
}

/**
 * Recovery never replays a non-idempotent WizardXray create request. An
 * in-flight request found after a restart keeps its reservation for
 * reconciliation; a reservation that never reached the provider is refunded.
 */
export async function recoverWalletPurchases(bot) {
  // Orders parked for provider funds are never auto-refunded or auto-created: only their admin alert is retried.
  await retryPendingReservedAlerts(bot).catch((error) => {
    log("error", "Reserved-order alert retry failed", { errorType: error?.name || "Error" });
  });
  await retryPendingReservedNotices(bot).catch((error) => {
    log("error", "Reserved-order customer notice retry failed", { errorType: error?.name || "Error" });
  });
  const now = new Date();
  const staleAt = new Date(now.getTime() - RECOVERY_STALE_MS);
  const candidates = await WalletPurchase.find({
    $or: [
      { status: { $in: ["reserving", "reserved", "refund_pending", "provisioned"] }, createdAt: { $lt: staleAt } },
      { status: { $in: ["provisioning", "uncertain"] }, provisioningStartedAt: { $lt: staleAt } },
      // manual_review waits for a human and is not terminal. Recovery's only action on it is a one-time admin alert, so once
      // an alert exists the order is a no-op here; re-selecting it every cycle would let 50+ unresolved orders fill the
      // whole oldest-first batch and starve newer recoverable work. They stay in the admin recovery queue untouched.
      { status: "manual_review", adminAlertedAt: null, provisioningStartedAt: { $lt: staleAt } },
      {
        status: "completed",
        notificationPending: true,
        // A missing counter/time (orders completed before these fields existed) counts as 0 / due, never as "skip".
        $and: [
          { $or: [{ notificationAttempts: null }, { notificationAttempts: { $lt: NOTIFICATION_MAX_ATTEMPTS } }] },
          { $or: [{ notificationNextAt: null }, { notificationNextAt: { $lte: now } }] },
        ],
      },
    ],
  }).sort({ createdAt: 1, _id: 1 }).limit(50).lean(); // oldest first; _id breaks ties so the batch is deterministic

  for (const candidate of candidates) {
    const claimNow = new Date();
    const staleClaimAt = new Date(claimNow.getTime() - RECOVERY_STALE_MS);
    const claimed = await WalletPurchase.findOneAndUpdate(
      {
        _id: candidate._id,
        status: candidate.status,
        $or: [{ recoveryClaimedAt: null }, { recoveryClaimedAt: { $lt: staleClaimAt } }],
      },
      { $set: { recoveryClaimedAt: claimNow } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      if (["reserving", "reserved", "refund_pending"].includes(claimed.status)) {
        const user = await User.exists({
          telegramId: String(claimed.telegramId),
          appliedPurchaseReservations: claimed.purchaseId,
        });
        if (user) {
          await refundPurchaseReservation(claimed, { reason: "RECOVERED_UNFULFILLED_ORDER" });
        } else {
          await WalletPurchase.findOneAndUpdate(
            { _id: claimed._id, status: { $in: ["reserving", "reserved"] } },
            {
              $set: { status: "failed", errorCode: "RESERVATION_NOT_APPLIED", walletDebitStatus: "not_debited" },
              $unset: { recoveryClaimedAt: 1 },
            }
          );
        }
      } else if (claimed.status === "provisioned") {
        await commitProvisionedPurchase(claimed, bot);
      } else if (claimed.status === "completed") {
        await notifyPurchaseRecovery(claimed, bot);
        await WalletPurchase.updateOne({ _id: claimed._id }, { $unset: { recoveryClaimedAt: 1 } });
      } else {
        const manual = await WalletPurchase.findOneAndUpdate(
          { _id: claimed._id, status: { $in: ["provisioning", "uncertain", "manual_review"] } },
          { $set: { status: "manual_review", errorCode: claimed.errorCode || "PANEL_RESULT_UNKNOWN" }, $unset: { recoveryClaimedAt: 1 } },
          { new: true }
        );
        if (manual) await alertAdmin(bot, manual, manual.errorCode || "PANEL_RESULT_UNKNOWN");
      }
    } catch (error) {
      await WalletPurchase.updateOne({ _id: claimed._id }, { $unset: { recoveryClaimedAt: 1 } }).catch(() => {});
      log("error", "Wallet purchase recovery step failed", {
        purchaseId: claimed.purchaseId,
        status: claimed.status,
        errorType: error?.name || "RecoveryError",
      });
      if (["provisioning", "uncertain", "manual_review"].includes(claimed.status)) {
        await alertAdmin(bot, claimed, "RECOVERY_ERROR");
      }
    }
  }
}

export async function deliverPurchaseNotification(purchase, bot) {
  return notifyPurchaseOnce(purchase, bot, await User.findOne({ telegramId: String(purchase.telegramId) }));
}

export async function deliverPurchaseNotificationById(purchaseId, bot) {
  const purchase = await WalletPurchase.findOne({ purchaseId, status: "completed" });
  if (!purchase) return false;
  return deliverPurchaseNotification(purchase, bot);
}
