import { createHash } from "node:crypto";
import WalletPurchase from "../../models/WalletPurchase.js";
import { purchasePlan, PurchaseServiceError } from "./purchaseService.js";
import { deliverPurchaseNotificationById } from "./purchaseLedger.js";
import { deliverReservedNotice, notifyReservedOrder } from "./reservedAlerts.js";
import { updateStatusMessage } from "../messaging/messageManager.js";

const PROCESSING_TEXT = "⏳ <b>در حال ثبت سفارش شما...</b>";

// One order at a time per purchaseId in this process (the bot runs as one replica). This only keeps a duplicate
// callback from racing the status message; MongoDB's unique purchaseId still decides what is charged and created.
const ordersInFlight = new Set();

/** Stable Telegram request ID: duplicate callbacks on one confirmation message share one order. */
export function telegramPurchaseId({ chatId, userId, messageId, planId } = {}) {
  if (chatId == null || userId == null || messageId == null || typeof planId !== "string") return null;
  const source = JSON.stringify([String(chatId), String(userId), String(messageId), planId]);
  return `tg_${createHash("sha256").update(source).digest("hex")}`;
}

/**
 * `messageId` is the tapped confirmation screen; it becomes the order's status message. A retry reuses it as it stands:
 * its order exists, so the message may already show the outcome, and a "⏳" that then failed to clear would hide that.
 */
async function openStatusMessage(bot, chatId, messageId, purchaseId) {
  const retried = purchaseId ? await WalletPurchase.exists({ purchaseId }).catch(() => null) : null;
  if (retried) return messageId;
  const { messageId: statusMessageId } = await updateStatusMessage(bot, {
    chatId,
    messageId,
    text: PROCESSING_TEXT,
    options: { parse_mode: "HTML" },
  });
  return statusMessageId;
}

async function placeOrder(bot, chatId, userId, planId, purchaseId, messageId) {
  const statusMessageId = await openStatusMessage(bot, chatId, messageId, purchaseId);
  const report = (text, { fallback = true } = {}) =>
    updateStatusMessage(bot, { chatId, messageId: statusMessageId, text, fallback });

  let outcome;
  try {
    outcome = await purchasePlan(userId, planId, { purchaseId });
  } catch (error) {
    if (error instanceof PurchaseServiceError && error.code === "INVALID_PLAN") {
      await report("❌ این پلن در حال حاضر فعال نیست یا حذف شده است. لطفاً از منوی خرید دوباره انتخاب کنید.");
      return { status: "failed", failure: "invalid_plan" };
    }
    if (error instanceof PurchaseServiceError && error.code === "CATALOG_UNAVAILABLE") {
      await report("⚠️ فروشگاه موقتاً در دسترس نیست و مبلغی کسر نشد. لطفاً چند دقیقه دیگر دوباره تلاش کنید.");
      return { status: "failed", failure: "catalog_unavailable" };
    }
    if (error instanceof PurchaseServiceError && error.code === "PURCHASE_ID_CONFLICT") {
      await report("❌ شناسه این سفارش با درخواست دیگری مطابقت دارد. لطفاً خرید تازه‌ای را از منوی پلن‌ها آغاز کنید.");
      return { status: "failed", failure: "purchase_id_conflict" };
    }
    await report("⏳ وضعیت خرید شما در حال بررسی است؛ لطفاً برای جلوگیری از کسر دوباره، سفارش را تکرار نکنید.");
    return { status: "processing", failure: "purchase_processing" };
  }

  if (outcome.status === "completed") {
    let notified = false;
    try {
      notified = await deliverPurchaseNotificationById(outcome.purchaseId, bot);
    } catch {
      // The durable notification outbox is retried by the existing recovery job.
    }
    // The links are their own durable message; this only closes the status message above them.
    await report("✅ سرویس ساخته و به حساب شما اضافه شد. لینک‌های سرویس در پیام بعدی ارسال می‌شوند.", {
      fallback: !notified && !outcome.replayed,
    });
    return outcome;
  }

  if (outcome.failure === "insufficient_balance") {
    await report("⚠️ موجودی شما کافی نیست. لطفاً ابتدا حساب خود را شارژ کنید.");
    return outcome;
  }
  if (outcome.failure === "user_not_found") {
    await report("❌ حساب کاربری شما پیدا نشد. لطفاً دوباره از ربات شروع کنید.");
    return outcome;
  }
  if (outcome.status === "refunded") {
    await report("❌ ایجاد سرویس انجام نشد و مبلغ رزروشده به کیف پول شما بازگشت.");
    return outcome;
  }
  if (outcome.status === "refund_pending") {
    await report("❌ درخواست پنل انجام نشد، اما بازپرداخت هنوز در حال پردازش است. لطفاً سفارش دیگری ثبت نکنید تا موجودی نهایی شود.");
    return outcome;
  }
  if (outcome.status === "awaiting_provider") {
    // The order and its outbox flags are already persisted; both notifications below are best effort and are retried
    // by the recovery cycle, so a failure here cannot lose the order or the customer's notice.
    if (!outcome.replayed) {
      try { await notifyReservedOrder(bot, outcome.purchaseId); } catch { /* outbox retries */ }
    }
    await deliverReservedNotice(bot, outcome.purchaseId, { chatId, messageId: statusMessageId });
    return outcome;
  }
  if (["manual_review", "uncertain"].includes(outcome.status)) {
    await report("⏳ وضعیت ساخت سرویس از پنل مشخص نیست و مبلغ شما موقتاً رزرو شده است. برای جلوگیری از ساخت تکراری، لطفاً دوباره خرید نکنید.");
    return outcome;
  }

  await report("⏳ درخواست خرید شما در حال ثبت است؛ لطفاً سفارش را تکرار نکنید.");
  return outcome;
}

/** Presentation adapter kept for Telegram; the purchase rules live in purchasePlan. */
export default async function handlePlanOrder(bot, chatId, userId, planId, context = {}) {
  const purchaseId = context.purchaseId || telegramPurchaseId({
    chatId,
    userId,
    messageId: context.messageId,
    planId,
  }) || undefined;

  if (purchaseId && ordersInFlight.has(purchaseId)) {
    return { purchaseId, status: "processing", replayed: true, failure: "already_in_flight" };
  }
  if (purchaseId) ordersInFlight.add(purchaseId);
  try {
    return await placeOrder(bot, chatId, userId, planId, purchaseId, context.messageId);
  } finally {
    ordersInFlight.delete(purchaseId);
  }
}
