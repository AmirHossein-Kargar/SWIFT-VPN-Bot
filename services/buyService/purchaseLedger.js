import { randomUUID } from "node:crypto";
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { getSuccessServiceMessage, guideButtons } from "../../messages/staticMessages.js";
import keyboard from "../../keyboards/mainKeyboard.js";

const NOTIFICATION_CLAIM_MS = 5 * 60_000;
const RECOVERY_STALE_MS = 5 * 60_000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "buy-service", level, message, ...meta })
  );
}

export async function reserveBalance(telegramId, amount, purchaseId) {
  return User.findOneAndUpdate(
    {
      telegramId: String(telegramId),
      balance: { $gte: amount },
      appliedPurchaseReservations: { $ne: purchaseId },
    },
    {
      $inc: { balance: -amount },
      $addToSet: { appliedPurchaseReservations: purchaseId },
    },
    { new: true }
  );
}

export async function refundPurchaseReservation(purchase, { allowProvisioning = false } = {}) {
  const allowedStates = ["reserving", "reserved", "refund_pending"];
  if (allowProvisioning) allowedStates.push("provisioning");
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

export async function commitProvisionedPurchase(purchase, bot) {
  if (!purchase.serviceUsername) throw new Error("Provisioned purchase is missing its service username");

  const provisionedAt = purchase.provisionedAt || purchase.completedAt || new Date();
  const expiresAt = purchase.expiresAt || new Date(provisionedAt.getTime() + Number(purchase.days) * 24 * 60 * 60 * 1000);
  const user = await User.findOneAndUpdate(
    {
      telegramId: String(purchase.telegramId),
      completedPurchaseIds: { $ne: purchase.purchaseId },
      "services.purchaseId": { $ne: purchase.purchaseId },
    },
    {
      $push: {
        services: {
          username: purchase.serviceUsername,
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

  if (!user) {
    const existing = await User.findOne({
      telegramId: String(purchase.telegramId),
      completedPurchaseIds: purchase.purchaseId,
      "services.purchaseId": purchase.purchaseId,
    });
    if (!existing) throw new Error("Could not persist provisioned service to its wallet owner");
  }

  const completed = await WalletPurchase.findOneAndUpdate(
    { _id: purchase._id, status: { $in: ["provisioned", "completed"] } },
    {
      $set: {
        status: "completed",
        completedAt: purchase.completedAt || new Date(),
        provisionedAt,
        expiresAt,
        notificationPending: true,
        recoveryStatus: "none",
      },
      $unset: { recoveryClaimedAt: 1 },
    },
    { new: true }
  );
  if (!completed) throw new Error("Purchase was committed to the user but its ledger needs recovery");

  const notified = await notifyPurchaseOnce(completed, bot, user || await User.findOne({ telegramId: String(purchase.telegramId) }));
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
    const smartLink = claim.serviceHash
      ? `https://iranisystem.com/bot/sub/?hash=${encodeURIComponent(claim.serviceHash)}`
      : claim.serviceLink || "";
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(smartLink)}&size=200x200&margin=20`;
    const caption = getSuccessServiceMessage({
      username: escapeHtml(claim.serviceUsername),
      smartLink: escapeHtml(smartLink),
      singleLink: escapeHtml(claim.singleLink),
    });
    await bot.sendPhoto(String(claim.telegramId), qrUrl, {
      caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...guideButtons,
    });
    await WalletPurchase.findOneAndUpdate(
      { _id: claim._id, notificationClaimedAt: now, notificationPending: true },
      { $set: { notificationPending: false, notifiedAt: new Date() }, $unset: { notificationClaimedAt: 1 } }
    );
    return true;
  } catch (error) {
    log("warn", "Purchase delivery notification failed", {
      purchaseId: claim.purchaseId,
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
 * Recovery never repeats a non-idempotent WizardXray create request. A worker
 * finding an in-flight request after a restart holds the reservation and asks
 * an admin to reconcile it against the panel.
 */
export async function recoverWalletPurchases(bot) {
  const now = new Date();
  const staleAt = new Date(now.getTime() - RECOVERY_STALE_MS);
  const candidates = await WalletPurchase.find({
    $or: [
      { status: { $in: ["reserving", "reserved", "refund_pending", "provisioned"] }, createdAt: { $lt: staleAt } },
      { status: { $in: ["provisioning", "uncertain", "manual_review"] }, provisioningStartedAt: { $lt: staleAt } },
      { status: "completed", notificationPending: true },
    ],
  }).sort({ createdAt: 1 }).limit(50).lean();

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
          await refundPurchaseReservation(claimed);
        } else {
          await WalletPurchase.findOneAndUpdate(
            { _id: claimed._id, status: { $in: ["reserving", "reserved"] } },
            { $set: { status: "failed", errorCode: "RESERVATION_NOT_APPLIED" }, $unset: { recoveryClaimedAt: 1 } }
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

export async function createWalletPurchase(bot, chatId, userId, plan) {
  const telegramId = String(userId);
  const purchaseId = randomUUID();
  const amount = Number(plan?.price);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(Number(plan?.gig)) || Number(plan.gig) <= 0 || !Number.isSafeInteger(Number(plan?.days)) || Number(plan.days) <= 0) {
    await bot.sendMessage(chatId, "❌ اطلاعات پلن نامعتبر است؛ لطفاً با پشتیبانی تماس بگیرید.");
    return;
  }

  let purchase;
  try {
    purchase = await WalletPurchase.create({
      purchaseId,
      telegramId,
      planId: String(plan.id || "unknown"),
      planName: String(plan.name || ""),
      gig: Number(plan.gig),
      days: Number(plan.days),
      amount,
      status: "reserving",
    });
  } catch (error) {
    log("error", "Could not create purchase ledger", { errorType: error?.name || "DatabaseError" });
    await bot.sendMessage(chatId, "❌ خرید در حال حاضر انجام نشد. موجودی شما تغییری نکرده است.");
    return;
  }

  let reserved;
  try {
    reserved = await reserveBalance(telegramId, amount, purchaseId);
  } catch (error) {
    log("error", "Wallet reservation failed", { purchaseId, errorType: error?.name || "DatabaseError" });
    await bot.sendMessage(chatId, "❌ وضعیت خرید مشخص نیست؛ لطفاً تا بررسی پشتیبانی دوباره تلاش نکنید.");
    await alertAdmin(bot, purchase, "RESERVATION_RESULT_UNKNOWN");
    return;
  }

  if (!reserved) {
    await WalletPurchase.updateOne({ _id: purchase._id, status: "reserving" }, { $set: { status: "failed", errorCode: "INSUFFICIENT_BALANCE" } });
    await bot.sendMessage(chatId, "⚠️ موجودی شما کافی نیست. لطفاً ابتدا حساب خود را شارژ کنید.");
    return;
  }

  try {
    purchase = await WalletPurchase.findOneAndUpdate(
      { _id: purchase._id, status: "reserving" },
      { $set: { status: "reserved", reservedAt: new Date() } },
      { new: true }
    );
    if (!purchase) throw new Error("Reservation ledger state changed unexpectedly");
  } catch (error) {
    log("error", "Wallet reservation recorded but purchase ledger needs recovery", {
      purchaseId,
      errorType: error?.name || "DatabaseError",
    });
    await bot.sendMessage(chatId, "⏳ خرید شما در حال بررسی است؛ لطفاً دوباره سفارش ثبت نکنید.");
    await alertAdmin(bot, { ...purchase?.toObject?.(), _id: purchase?._id, purchaseId, telegramId, amount, planName: plan.name, status: "reserving" }, "RESERVATION_LEDGER_RECOVERY");
    return;
  }

  try {
    purchase = await WalletPurchase.findOneAndUpdate(
      { _id: purchase._id, status: "reserved" },
      { $set: { status: "provisioning", provisioningStartedAt: new Date() } },
      { new: true }
    );
    if (!purchase) throw new Error("Provisioning claim failed");
  } catch (error) {
    log("error", "Wallet purchase provisioning was not started", { purchaseId, errorType: error?.name || "DatabaseError" });
    await bot.sendMessage(chatId, "⏳ خرید شما ثبت شده و در حال بازیابی است؛ لطفاً سفارش دیگری ثبت نکنید.");
    await alertAdmin(bot, { _id: purchase?._id, purchaseId, telegramId, amount, planName: plan.name, status: "reserved" }, "PROVISIONING_NOT_STARTED");
    return;
  }

  let apiResponse;
  try {
    const { createVpnService } = await import("../../api/wizardApi.js");
    apiResponse = await createVpnService(Number(plan.gig), Number(plan.days), 0);
  } catch (error) {
    if (error?.ambiguous) {
      const uncertain = await WalletPurchase.findOneAndUpdate(
        { _id: purchase._id, status: "provisioning" },
        { $set: { status: "manual_review", errorCode: error.code || "PANEL_RESULT_UNKNOWN" } },
        { new: true }
      );
      log("error", "Wizard panel outcome is ambiguous; reservation retained", {
        purchaseId, errorType: error?.name || "PanelError", code: error?.code || "UNKNOWN",
      });
      await bot.sendMessage(chatId, "⏳ وضعیت ساخت سرویس از پنل مشخص نیست و مبلغ شما موقتاً رزرو شده است. لطفاً برای جلوگیری از ساخت تکراری، دوباره خرید نکنید تا پشتیبانی نتیجه را بررسی کند.");
      if (uncertain) await alertAdmin(bot, uncertain, error.code || "PANEL_RESULT_UNKNOWN");
      return;
    }

    try {
      await refundPurchaseReservation(purchase, { allowProvisioning: true });
    } catch (refundError) {
      log("error", "Purchase refund requires recovery", {
        purchaseId,
        errorType: refundError?.name || "RefundError",
      });
      await alertAdmin(bot, purchase, "REFUND_PENDING");
      await bot.sendMessage(chatId, "❌ درخواست پنل انجام نشد، اما بازپرداخت هنوز در حال پردازش است. لطفاً دوباره خرید نکنید تا موجودی نهایی شود.");
      return;
    }
    log("warn", "Wizard panel definitively rejected purchase; reservation refunded", {
      purchaseId, errorType: error?.name || "PanelError", code: error?.code || "PANEL_REJECTED",
    });
    await bot.sendMessage(chatId, "❌ ایجاد سرویس انجام نشد و مبلغ رزروشده به کیف پول شما بازگشت.");
    return;
  }

  const result = apiResponse.result;
  const hash = typeof result.hash === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(result.hash) ? result.hash : null;
  const serviceLink = typeof result.sub_link === "string" && result.sub_link.length <= 4096 ? result.sub_link : null;
  const singleLink = Array.isArray(result.tak_links) && typeof result.tak_links[0] === "string" && result.tak_links[0].length <= 4096 ? result.tak_links[0] : "";

  const provisionedAt = new Date();
  const expiresAt = new Date(provisionedAt.getTime() + Number(plan.days) * 24 * 60 * 60 * 1000);
  try {
    purchase = await WalletPurchase.findOneAndUpdate(
      { _id: purchase._id, status: "provisioning" },
      {
        $set: {
          status: "provisioned",
          serviceUsername: result.username,
          serviceHash: hash,
          serviceLink,
          singleLink,
          provisionedAt,
          expiresAt,
        },
      },
      { new: true }
    );
    if (!purchase) throw new Error("Provisioned service could not be durably recorded");
  } catch (error) {
    log("error", "Panel created a service but its purchase record needs reconciliation", {
      purchaseId, errorType: error?.name || "DatabaseError",
    });
    await bot.sendMessage(chatId, "✅ پنل سرویس را ساخته است، اما ثبت نهایی در حال بازیابی است. مبلغ شما کسر شده و سرویس برای شما ثبت خواهد شد؛ لطفاً خرید را تکرار نکنید.");
    await alertAdmin(bot, { ...purchase?.toObject?.(), _id: purchase?._id, purchaseId, telegramId, amount, planName: plan.name, status: "provisioning" }, "PROVISIONED_RESULT_NEEDS_RECOVERY");
    return;
  }

  try {
    const finalized = await commitProvisionedPurchase(purchase, bot);
    log("info", "PURCHASE_COMPLETED", { purchaseId, userId: telegramId, planId: purchase.planId });
    if (!finalized.notified) {
      await bot.sendMessage(chatId, "✅ سرویس ساخته و به حساب شما اضافه شد. لینک‌های سرویس در پیام بعدی ارسال می‌شوند.").catch(() => {});
    }
  } catch (error) {
    log("error", "Provisioned purchase needs database recovery", {
      purchaseId, errorType: error?.name || "DatabaseError",
    });
    await alertAdmin(bot, purchase, "PROVISIONED_SERVICE_COMMIT_PENDING");
    await bot.sendMessage(chatId, "✅ سرویس ساخته شده است، اما ثبت نهایی آن در حال بازیابی است. لطفاً خرید را تکرار نکنید.").catch(() => {});
  }
}

export async function deliverPurchaseNotification(purchase, bot) {
  return notifyPurchaseOnce(purchase, bot, await User.findOne({ telegramId: String(purchase.telegramId) }));
}
