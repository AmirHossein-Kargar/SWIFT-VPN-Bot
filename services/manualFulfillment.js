import WalletPurchase from "../models/WalletPurchase.js";
import User from "../models/User.js";
import { deliverPurchaseNotification } from "./buyService/purchaseLedger.js";
import { runAuditedAction } from "./admin/audit.js";
import { randomUUID } from "node:crypto";
import escapeHtml from "../utils/escapeHtml.js";
import botInstance from "../config/botInstance.js";

/**
 * Notify admin about a purchase requiring manual fulfillment.
 * Uses idempotent adminAlertedAt to prevent duplicate alerts.
 * @param {object} bot - Bot instance
 * @param {object} purchase - Purchase document
 * @returns {Promise<void>}
 */
export async function notifyAdminManualFulfillment(bot, purchase) {
  // Ensure we only alert once per purchase
  const updated = purchase?._id
    ? await WalletPurchase.findOneAndUpdate(
        { _id: purchase._id, adminAlertedAt: null },
        { $set: { adminAlertedAt: new Date() } },
        { new: true }
      )
    : purchase;

  if (!updated) return;

  const botToUse = bot || botInstance.bot;
  if (!botToUse?.sendMessage) return;

  try {
    await botToUse.sendMessage(
      process.env.GROUP_ID,
      `🚨 <b>خرید نیاز به تأمین دستی دارد</b>\n\n` +
        `شناسه: <code>${escapeHtml(purchase.purchaseId)}</code>\n` +
        `کاربر: <code>${escapeHtml(purchase.telegramId)}</code>\n` +
        `مبلغ رزرو‌شده: <code>${Number(purchase.amount).toLocaleString("en-US")}</code> تومان\n` +
        `پلن: <code>${escapeHtml(purchase.planName || purchase.planId)}</code>\n` +
        `وضعیت: <code>${escapeHtml(purchase.status)}</code>\n` +
        `توضیح: <code>${escapeHtml(purchase.errorCode || "WizardXray provider issue requiring manual intervention")}</code>\n\n` +
        `لطفاً یکی از اقدامات زیر را انتخاب کنید:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ تأیید تأمین", callback_data: `manual_approve_${purchase.purchaseId}` },
              { text: "❌ لغو سفارش", callback_data: `manual_cancel_${purchase.purchaseId}` }
            ]
          ]
        }
      }
    );
  } catch (error) {
    console.error("Admin manual fulfillment alert delivery failed:", {
      purchaseId: purchase.purchaseId,
      errorType: error?.name || "TelegramError",
    });
  }
}

/**
 * Atomically approve a manual fulfillment purchase.
 * Claims the purchase for the admin and returns the claimed document.
 * @param {string} purchaseId - Purchase UUID
 * @param {string|number} adminId - Telegram ID of the approving admin
 * @returns {Promise<object|null>} Claimed purchase or null if already claimed/invalid state
 */
export async function approveManualFulfillment(purchaseId, adminId) {
  const adminIdNum = Number(adminId);
  if (!Number.isSafeInteger(adminIdNum)) {
    throw new Error("Invalid admin ID");
  }

  // Atomically claim the purchase if it's in pending_manual state and unclaimed.
  // Query by purchaseId (UUID string field), not _id (ObjectId).
  const claimed = await WalletPurchase.findOneAndUpdate(
    {
      purchaseId,
      status: "pending_manual",
      manualClaimedBy: null, // Only claim if not already claimed
    },
    {
      $set: {
        manualClaimedBy: adminIdNum,
        manualClaimedAt: new Date(),
      },
    },
    { new: true }
  );

  return claimed;
}

/**
 * Atomically cancel a manual fulfillment purchase and refund the user.
 * @param {string} purchaseId - Purchase UUID
 * @param {string|number} adminId - Telegram ID of the cancelling admin
 * @returns {Promise<{purchase: object, user: object}>} Result with purchase and refunded user
 */
export async function cancelManualFulfillment(purchaseId, adminId) {
  const adminIdNum = Number(adminId);
  if (!Number.isSafeInteger(adminIdNum)) {
    throw new Error("Invalid admin ID");
  }

  const operationId = `manual_cancel_${purchaseId}_${adminIdNum}`;

  const { result } = await runAuditedAction({
    actorTelegramId: adminIdNum,
    operationId,
    action: "MANUAL_PURCHASE_CANCELLED",
    targetType: "wallet_purchase",
    targetId: purchaseId,
    execute: async () => {
      // Find the purchase to cancel — query by purchaseId UUID, not _id
      const purchase = await WalletPurchase.findOne({
        purchaseId,
        status: "pending_manual",
        manualClaimedBy: adminIdNum, // Must be claimed by this admin
      });

      if (!purchase) {
        const err = new Error("Purchase not found or not claimed by admin");
        err.code = "NOT_FOUND";
        throw err;
      }

      // Refund the purchase
      const refundedUser = await refundPurchaseReservation(purchase, { allowProvisioning: true });

      // Update purchase status to cancelled
      const updatedPurchase = await WalletPurchase.findOneAndUpdate(
        { purchaseId },
        {
          $set: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: adminIdNum,
          },
          $unset: { manualClaimedBy: 1, manualClaimedAt: 1 },
        },
        { new: true }
      );

      return {
        purchase: updatedPurchase,
        user: refundedUser,
        auditSummary: {
          purchaseId: updatedPurchase.purchaseId,
          userId: updatedPurchase.telegramId,
          amount: Number(updatedPurchase.amount),
        },
      };
    },
  });

  return { purchase: result.purchase, user: result.user };
}

/**
 * Commit a manually fulfilled service to the user's account.
 * @param {string} purchaseId - Purchase UUID
 * @param {string|number} adminId - Telegram ID of the fulfilling admin
 * @param {object} serviceInfo - Service details from admin (username, subscription link, etc.)
 * @param {object} bot - Bot instance
 * @returns {Promise<{purchase: object, user: object, notified: boolean}>}
 */
export async function commitManualService(purchaseId, adminId, serviceInfo, bot) {
  const adminIdNum = Number(adminId);
  if (!Number.isSafeInteger(adminIdNum)) {
    throw new Error("Invalid admin ID");
  }

  const operationId = `manual_commit_${purchaseId}_${adminIdNum}`;

  const { result } = await runAuditedAction({
    actorTelegramId: adminIdNum,
    operationId,
    action: "MANUAL_SERVICE_COMMITTED",
    targetType: "wallet_purchase",
    targetId: purchaseId,
    execute: async () => {
      // Find the purchase to fulfill — query by purchaseId UUID, not _id
      const purchase = await WalletPurchase.findOne({
        purchaseId,
        status: "pending_manual",
        manualClaimedBy: adminIdNum, // Must be claimed by this admin
      });

      if (!purchase) {
        const err = new Error("Purchase not found or not claimed by admin");
        err.code = "NOT_FOUND";
        throw err;
      }

      // Validate serviceInfo
      if (!serviceInfo.username || !serviceInfo.subscriptionLink) {
        const err = new Error("Missing required service information (username and subscription link)");
        err.code = "INVALID_INPUT";
        throw err;
      }

      // Calculate expiration date (30 days from now if not provided)
      const expiresAt = serviceInfo.expiresAt
        ? new Date(serviceInfo.expiresAt)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // Persist service to user account — idempotent via completedPurchaseIds guard
      let user = await User.findOneAndUpdate(
        {
          telegramId: String(purchase.telegramId),
          completedPurchaseIds: { $ne: purchase.purchaseId },
          "services.purchaseId": { $ne: purchase.purchaseId },
        },
        {
          $push: {
            services: {
              username: serviceInfo.username,
              purchaseId: purchase.purchaseId,
              productId: purchase.planId,
              trafficGb: Number(purchase.gig),
              createdAt: new Date(),
              expiresAt,
            },
          },
          $addToSet: { completedPurchaseIds: purchase.purchaseId },
          $inc: { totalServices: 1 },
        },
        { new: true }
      );

      if (!user) {
        const existing = await User.findOne({
          telegramId: String(purchase.telegramId),
          completedPurchaseIds: purchase.purchaseId,
          "services.purchaseId": purchase.purchaseId,
        });
        if (!existing) {
          const err = new Error("Could not persist service to user");
          err.code = "DB_ERROR";
          throw err;
        }
        user = existing;
      }

      // Mark purchase as fulfilled — query by purchaseId UUID, not _id
      const completed = await WalletPurchase.findOneAndUpdate(
        { purchaseId },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            serviceUsername: serviceInfo.username,
            serviceLink: serviceInfo.subscriptionLink,
            singleLink: serviceInfo.singleLink || "",
            provisionedAt: new Date(),
            expiresAt,
            notificationPending: true,
            recoveryStatus: "none",
          },
          $unset: { manualClaimedBy: 1, manualClaimedAt: 1, recoveryClaimedAt: 1 },
        },
        { new: true }
      );

      if (!completed) {
        const err = new Error("Failed to mark purchase as completed");
        err.code = "DB_ERROR";
        throw err;
      }

      // Attempt to deliver notification to user (non-fatal on failure)
      let notified = false;
      try {
        notified = await deliverPurchaseNotification(completed, bot || botInstance.bot);
        await WalletPurchase.updateOne(
          { purchaseId },
          { $unset: { notificationClaimedAt: 1 } }
        );
      } catch (notifyError) {
        console.warn("Manual service delivery notification failed:", {
          purchaseId: purchase.purchaseId,
          errorType: notifyError?.name || "TelegramError",
        });
      }

      return {
        purchase: completed,
        user,
        notified,
        auditSummary: {
          purchaseId: completed.purchaseId,
          userId: completed.telegramId,
          serviceUsername: completed.serviceUsername,
          notified,
        },
      };
    },
  });

  return { purchase: result.purchase, user: result.user, notified: result.notified };
}

/**
 * Helper to refund a purchase reservation.
 * @param {object} purchase - Purchase document
 * @param {object} options - Options (allowProvisioning)
 * @returns {Promise<object>} Refunded user
 */
async function refundPurchaseReservation(purchase, { allowProvisioning = false } = {}) {
  const allowedStates = ["reserving", "reserved", "refund_pending"];
  if (allowProvisioning) allowedStates.push("provisioning", "pending_manual");
  await WalletPurchase.findOneAndUpdate(
    { _id: purchase._id, status: { $in: allowedStates } },
    { $set: { status: "refund_pending" } }
  );

  const refundedUser = await User.findOneAndUpdate(
    {
      telegramId: String(purchase.telegramId),
      appliedPurchaseReservations: purchase.purchaseId,
      refundedPurchaseIds: { $ne: purchase.purchaseId },
    },
    {
      $inc: { balance: Number(purchase.amount) },
      $addToSet: { refundedPurchaseIds: purchase.purchaseId },
    },
    { new: true }
  );

  if (!refundedUser) {
    const alreadyRefunded = await User.exists({
      telegramId: String(purchase.telegramId),
      refundedPurchaseIds: purchase.purchaseId,
    });
    if (!alreadyRefunded) {
      const error = new Error("Purchase refund is pending manual recovery");
      error.code = "REFUND_NOT_APPLIED";
      throw error;
    }
  }

  await WalletPurchase.findOneAndUpdate(
    { _id: purchase._id, status: "refund_pending" },
    { $set: { status: "refunded", refundedAt: new Date() }, $unset: { recoveryClaimedAt: 1 } }
  );
  return refundedUser;
}
