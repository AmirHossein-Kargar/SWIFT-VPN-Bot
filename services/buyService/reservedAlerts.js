import WalletPurchase from "../../models/WalletPurchase.js";
import escapeHtml from "../../utils/escapeHtml.js";
import { getDurationOptionByDays } from "../plans.js";
import { trafficTextFa } from "../../utils/serviceTerms.js";
import { updateStatusMessage } from "../messaging/messageManager.js";

/**
 * Notifications for wallet purchases parked in `awaiting_provider`: the admin-group alert and the customer's notice.
 *
 * Reliability model: the order and its `adminAlertPending` / `customerNoticePending` flags are persisted by the same
 * atomic update that parks the order, so a lost Telegram message never loses the order. Delivery is claimed (stale-claim
 * expiry), retried with bounded exponential backoff by the existing wallet recovery cycle, and an admin can always find
 * the order through the recovery queue even after the attempts are exhausted.
 */

export const RESERVED_CALLBACK_PREFIX = "rsv:";

export const RESERVED_ORDER_NOTICE = "✅ سفارش شما ثبت و مبلغ آن از کیف پولتان رزرو شد.\nسرویس در انتظار تأمین موجودی ارائه‌دهنده است و پس از آماده‌شدن، لینک اتصال برای شما ارسال می‌شود.\nنیازی به ثبت سفارش مجدد نیست.";

const CLAIM_TTL_MS = 2 * 60_000;
const MAX_ALERT_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const SWEEP_LIMIT = 25;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "reserved-orders", level, message, ...meta })
  );
}

const STATUS_LABELS = Object.freeze({
  awaiting_provider: "در انتظار تأمین موجودی WizardXray",
  provisioning: "در حال ایجاد سرویس",
  provisioned: "سرویس ساخته شد؛ در حال ثبت نهایی",
  completed: "انجام شد",
  manual_review: "نتیجه پنل نامشخص؛ نیازمند بررسی دستی",
  uncertain: "نتیجه پنل نامشخص؛ نیازمند بررسی دستی",
  refund_pending: "در حال بازپرداخت",
  refunded: "لغو و بازپرداخت شد",
  failed: "ناموفق",
});

function durationLabel(days) {
  const option = getDurationOptionByDays(days);
  return option ? `${option.title} (${days} روز)` : `${days} روز`;
}

/** Admin-facing order card. Contains no links, credentials or personal data beyond the Telegram numeric ID. */
export function reservedOrderText(purchase) {
  const awaiting = purchase.status === "awaiting_provider";
  const headline = awaiting
    ? "⚠️ <b>سفارش رزروشده — نیاز به شارژ کیف پول ارائه‌دهنده</b>"
    : "📦 <b>سفارش رزروشده</b>";
  const lines = [
    headline,
    "",
    `شناسه سفارش: <code>${escapeHtml(purchase.purchaseId)}</code>`,
    `شناسه کاربر: <code>${escapeHtml(purchase.telegramId)}</code>`,
    `پلن: <code>${escapeHtml(purchase.planName || purchase.planId)}</code>`,
    `حجم: <code>${escapeHtml(trafficTextFa(purchase.gig))}</code>`,
    `مدت: <code>${escapeHtml(durationLabel(Number(purchase.days)))}</code>`,
    `مبلغ سفارش: <code>${Number(purchase.amount).toLocaleString("en-US")} تومان</code>`,
    `وضعیت: ${STATUS_LABELS[purchase.status] || escapeHtml(purchase.status)}`,
  ];
  if (awaiting) {
    lines.push("ℹ️ موجودی کیف پول WizardXray را در پنل وب (سرویس‌ها ← ارائه‌دهنده) ببینید؛ پس از شارژ، «تأیید» را بزنید. اگر هنوز ناکافی باشد سفارش رزرو می‌ماند.");
  }
  if (purchase.status === "completed" && purchase.notificationPending) {
    lines.push("ℹ️ سرویس ساخته شده؛ ارسال به کاربر در صف تلاش مجدد است.");
  }
  if (purchase.status === "manual_review" || purchase.status === "uncertain") {
    lines.push("⛔ برای جلوگیری از ساخت تکراری، این سفارش را دوباره تأیید نکنید؛ ابتدا وضعیت پنل را بررسی کنید.");
  }
  return lines.join("\n");
}

export function reservedOrderKeyboard(purchase) {
  const ref = String(purchase._id);
  if (purchase.status === "awaiting_provider") {
    return {
      inline_keyboard: [
        [{ text: "✅ تأیید و ایجاد سرویس", callback_data: `${RESERVED_CALLBACK_PREFIX}ok:${ref}` }],
        [
          { text: "🔄 بررسی مجدد وضعیت", callback_data: `${RESERVED_CALLBACK_PREFIX}rf:${ref}` },
          { text: "❌ لغو سفارش", callback_data: `${RESERVED_CALLBACK_PREFIX}no:${ref}` },
        ],
      ],
    };
  }
  if (["provisioning", "manual_review", "uncertain", "provisioned", "refund_pending"].includes(purchase.status)
      || (purchase.status === "completed" && purchase.notificationPending)) {
    return { inline_keyboard: [[{ text: "🔄 بررسی مجدد وضعیت", callback_data: `${RESERVED_CALLBACK_PREFIX}rf:${ref}` }]] };
  }
  return { inline_keyboard: [] };
}

export function reservedCancelConfirmKeyboard(purchase) {
  const ref = String(purchase._id);
  return {
    inline_keyboard: [
      [{ text: "✅ بله، لغو و بازپرداخت", callback_data: `${RESERVED_CALLBACK_PREFIX}nc:${ref}` }],
      [{ text: "↩️ انصراف", callback_data: `${RESERVED_CALLBACK_PREFIX}rf:${ref}` }],
    ],
  };
}

const REPLACEABLE_EDIT_DESCRIPTION = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i;

/**
 * True only for Telegram's explicit "the message I was asked to edit is gone / cannot be edited" answers (HTTP 400 from the
 * Bot API), which a retry of the same edit can never fix. Network errors, 429s, 403/permission errors, "chat not found",
 * formatting errors, 5xx and anything that merely contains similar words are NOT replaceable and keep the normal retry.
 * node-telegram-bot-api exposes the answer as `error.response.body` and as an `ETELEGRAM: <status> <description>` message.
 */
export function isReplaceableEditError(error) {
  if (!error || typeof error !== "object") return false;
  const body = error.response?.body;
  const fromMessage = /^ETELEGRAM:\s*(\d{3})\s+([\s\S]*)$/.exec(String(error.message ?? ""));
  const status = Number(error.response?.statusCode ?? body?.error_code ?? fromMessage?.[1]);
  const description = String(body?.description ?? fromMessage?.[2] ?? "");
  return status === 400 && REPLACEABLE_EDIT_DESCRIPTION.test(description);
}

function backoffMs(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/**
 * Deliver (or re-render) the admin alert for one order. Idempotent: the outbox claim guarantees one in-flight sender, and
 * a delivered alert clears `adminAlertPending`. Never throws; failures are persisted for retry.
 */
export async function notifyReservedOrder(bot, purchaseId, { purchaseModel = WalletPurchase, groupId = process.env.GROUP_ID } = {}) {
  const now = new Date();
  const claimed = await purchaseModel.findOneAndUpdate(
    {
      purchaseId,
      status: "awaiting_provider",
      adminAlertPending: true,
      $or: [{ adminAlertClaimedAt: null }, { adminAlertClaimedAt: { $lt: new Date(now.getTime() - CLAIM_TTL_MS) } }],
    },
    { $set: { adminAlertClaimedAt: now }, $inc: { adminAlertAttempts: 1 } },
    { new: true }
  ).catch(() => null);
  if (!claimed) return false;

  const fail = async (reason) => {
    const attempts = Number(claimed.adminAlertAttempts) || 1;
    await purchaseModel.updateOne(
      { purchaseId, adminAlertClaimedAt: now },
      { $set: { adminAlertNextAt: new Date(Date.now() + backoffMs(attempts)), adminAlertClaimedAt: null } }
    ).catch(() => {});
    log("error", "Reserved-order admin alert delivery failed", { purchaseId, attempts, reason });
    return false;
  };

  if (!groupId || !bot?.sendMessage) return fail("ADMIN_GROUP_UNAVAILABLE");

  const options = { parse_mode: "HTML", reply_markup: reservedOrderKeyboard(claimed) };
  let messageId = claimed.adminAlertMessageId ?? null;
  try {
    if (messageId != null) {
      try {
        await bot.editMessageText(reservedOrderText(claimed), { ...options, chat_id: groupId, message_id: messageId });
      } catch (editError) {
        // Anything else (including "message is not modified") is handled by the outer catch exactly as before.
        if (!isReplaceableEditError(editError)) throw editError;
        // The original alert was deleted or can no longer be edited. We still hold the outbox claim, so only this worker sends
        // the replacement; if the send fails, `messageId` is untouched and the normal backoff-and-retry applies.
        log("warn", "Reserved-order alert message is gone; sending a replacement", { purchaseId });
        const replacement = await bot.sendMessage(groupId, reservedOrderText(claimed), options);
        messageId = Number.isSafeInteger(replacement?.message_id) ? replacement.message_id : null;
      }
    } else {
      const sent = await bot.sendMessage(groupId, reservedOrderText(claimed), options);
      messageId = Number.isSafeInteger(sent?.message_id) ? sent.message_id : null;
    }
  } catch (error) {
    if (!/message is not modified/i.test(String(error?.response?.body?.description || error?.message))) {
      return fail(error?.name || "TelegramError");
    }
  }

  // If this write is lost the alert is simply retried later (a duplicate message at worst, never a duplicate order).
  await purchaseModel.updateOne(
    { purchaseId, adminAlertClaimedAt: now },
    {
      $set: { adminAlertPending: false, adminAlertedAt: new Date(), adminAlertMessageId: messageId, adminAlertNextAt: null, adminAlertAttempts: 0 },
      $unset: { adminAlertClaimedAt: 1 },
    }
  ).catch((error) => log("error", "Reserved-order admin alert sent but its delivery state was not saved", {
    purchaseId,
    errorType: error?.name || "DatabaseError",
  }));
  log("info", "Reserved-order admin alert delivered", { purchaseId });
  return true;
}

/** Recovery-cycle sweep: re-send alerts that failed or were interrupted (bounded attempts, exponential backoff). */
export async function retryPendingReservedAlerts(bot, { purchaseModel = WalletPurchase, now = new Date() } = {}) {
  const pending = await purchaseModel.find({
    status: "awaiting_provider",
    adminAlertPending: true,
    adminAlertAttempts: { $lt: MAX_ALERT_ATTEMPTS },
  }).limit(SWEEP_LIMIT).lean();
  let delivered = 0;
  for (const item of pending) {
    if (item.adminAlertNextAt && new Date(item.adminAlertNextAt) > now) continue;
    if (await notifyReservedOrder(bot, item.purchaseId, { purchaseModel })) delivered += 1;
  }
  return delivered;
}

/**
 * Tell the customer their order is reserved, exactly once per order, by editing `messageId` when one is given. Only the
 * claim holder may add a message; a caller that loses the claim (a retry of a delivered notice, or a concurrent worker)
 * can only bring its own message up to date. Never throws; failures are persisted for retry.
 */
export async function deliverReservedNotice(bot, purchaseId, { chatId, messageId, purchaseModel = WalletPurchase } = {}) {
  const now = new Date();
  const claimed = await purchaseModel.findOneAndUpdate(
    {
      purchaseId,
      status: "awaiting_provider",
      customerNoticePending: true,
      $or: [{ customerNoticeClaimedAt: null }, { customerNoticeClaimedAt: { $lt: new Date(now.getTime() - CLAIM_TTL_MS) } }],
    },
    { $set: { customerNoticeClaimedAt: now }, $inc: { customerNoticeAttempts: 1 } },
    { new: true }
  ).catch(() => null);
  if (!claimed) {
    await updateStatusMessage(bot, { chatId, messageId, text: RESERVED_ORDER_NOTICE, fallback: false });
    return false;
  }

  const { delivered } = await updateStatusMessage(bot, {
    chatId: chatId ?? claimed.telegramId,
    messageId,
    text: RESERVED_ORDER_NOTICE,
  });
  if (!delivered) {
    const attempts = Number(claimed.customerNoticeAttempts) || 1;
    await purchaseModel.updateOne(
      { purchaseId, customerNoticeClaimedAt: now },
      { $set: { customerNoticeNextAt: new Date(Date.now() + backoffMs(attempts)), customerNoticeClaimedAt: null } }
    ).catch(() => {});
    log("warn", "Reserved-order customer notice delivery failed", { purchaseId, attempts });
    return false;
  }

  // If this write is lost the notice is retried later (a duplicate message at worst, never a duplicate order).
  await purchaseModel.updateOne(
    { purchaseId, customerNoticeClaimedAt: now },
    {
      $set: { customerNoticePending: false, customerNotifiedAt: new Date(), customerNoticeNextAt: null },
      $unset: { customerNoticeClaimedAt: 1 },
    }
  ).catch((error) => log("error", "Reserved-order customer notice sent but its delivery state was not saved", {
    purchaseId,
    errorType: error?.name || "DatabaseError",
  }));
  return true;
}

/**
 * Recovery-cycle sweep for notices that failed or were interrupted (bounded attempts, exponential backoff). The live
 * flow gets one claim TTL to finish first, so a sweep cannot race a purchase that is still reporting its own outcome.
 * The status message id is not persisted, so a recovered notice is always a new message to the customer.
 */
export async function retryPendingReservedNotices(bot, { purchaseModel = WalletPurchase, now = new Date() } = {}) {
  const pending = await purchaseModel.find({
    status: "awaiting_provider",
    customerNoticePending: true,
    customerNoticeAttempts: { $lt: MAX_ALERT_ATTEMPTS },
    awaitingProviderSince: { $lt: new Date(now.getTime() - CLAIM_TTL_MS) },
  }).limit(SWEEP_LIMIT).lean();
  let delivered = 0;
  for (const item of pending) {
    if (item.customerNoticeNextAt && new Date(item.customerNoticeNextAt) > now) continue;
    if (await deliverReservedNotice(bot, item.purchaseId, { purchaseModel })) delivered += 1;
  }
  return delivered;
}
