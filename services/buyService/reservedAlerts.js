import WalletPurchase from "../../models/WalletPurchase.js";
import escapeHtml from "../../utils/escapeHtml.js";
import { getDurationOptionByDays } from "../plans.js";

/**
 * Admin-group notifications for wallet purchases parked in `awaiting_provider`.
 *
 * Reliability model: the order and its `adminAlertPending` flag are persisted by the same atomic update that parks
 * the order, so a lost Telegram message never loses the order. Delivery is claimed (stale-claim expiry), retried with
 * bounded exponential backoff by the existing wallet recovery cycle, and an admin can always find the order through the
 * recovery queue even after the attempts are exhausted.
 */

export const RESERVED_CALLBACK_PREFIX = "rsv:";

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
    `حجم: <code>${escapeHtml(purchase.gig)} گیگابایت</code>`,
    `مدت: <code>${escapeHtml(durationLabel(Number(purchase.days)))}</code>`,
    `مبلغ سفارش: <code>${Number(purchase.amount).toLocaleString("en-US")} تومان</code>`,
    `وضعیت: ${STATUS_LABELS[purchase.status] || escapeHtml(purchase.status)}`,
  ];
  if (awaiting) {
    lines.push("ℹ️ موجودی کیف پول WizardXray از طریق ربات قابل بررسی نیست؛ پس از شارژ، «تأیید» را بزنید. اگر هنوز ناکافی باشد سفارش رزرو می‌ماند.");
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
      await bot.editMessageText(reservedOrderText(claimed), { ...options, chat_id: groupId, message_id: messageId });
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
