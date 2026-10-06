import { createHash } from "node:crypto";
import { purchasePlan, PurchaseServiceError } from "./purchaseService.js";
import { deliverPurchaseNotificationById } from "./purchaseLedger.js";

/** Stable Telegram request ID: duplicate callbacks on one confirmation message share one order. */
export function telegramPurchaseId({ chatId, userId, messageId, planId } = {}) {
  if (chatId == null || userId == null || messageId == null || typeof planId !== "string") return null;
  const source = JSON.stringify([String(chatId), String(userId), String(messageId), planId]);
  return `tg_${createHash("sha256").update(source).digest("hex")}`;
}

async function send(bot, chatId, text) {
  if (!bot?.sendMessage) return;
  try { await bot.sendMessage(chatId, text); } catch { /* user chat may be unavailable */ }
}

/** Presentation adapter kept for Telegram; the purchase rules live in purchasePlan. */
export default async function handlePlanOrder(bot, chatId, userId, planId, context = {}) {
  const purchaseId = context.purchaseId || telegramPurchaseId({
    chatId,
    userId,
    messageId: context.messageId,
    planId,
  }) || undefined;

  let outcome;
  try {
    outcome = await purchasePlan(userId, planId, { purchaseId });
  } catch (error) {
    if (error instanceof PurchaseServiceError && error.code === "INVALID_PLAN") {
      await send(bot, chatId, "❌ این پلن در حال حاضر فعال نیست یا حذف شده است. لطفاً از منوی خرید دوباره انتخاب کنید.");
      return { status: "failed", failure: "invalid_plan" };
    }
    if (error instanceof PurchaseServiceError && error.code === "PURCHASE_ID_CONFLICT") {
      await send(bot, chatId, "❌ شناسه این سفارش با درخواست دیگری مطابقت دارد. لطفاً خرید تازه‌ای را از منوی پلن‌ها آغاز کنید.");
      return { status: "failed", failure: "purchase_id_conflict" };
    }
    await send(bot, chatId, "⏳ وضعیت خرید شما در حال بررسی است؛ لطفاً برای جلوگیری از کسر دوباره، سفارش را تکرار نکنید.");
    return { status: "processing", failure: "purchase_processing" };
  }

  if (outcome.status === "completed") {
    let notified = false;
    try {
      notified = await deliverPurchaseNotificationById(outcome.purchaseId, bot);
    } catch {
      // The durable notification outbox is retried by the existing recovery job.
    }
    if (!notified && !outcome.replayed) {
      await send(bot, chatId, "✅ سرویس ساخته و به حساب شما اضافه شد. لینک‌های سرویس در پیام بعدی ارسال می‌شوند.");
    }
    return outcome;
  }

  if (outcome.failure === "insufficient_balance") {
    await send(bot, chatId, "⚠️ موجودی شما کافی نیست. لطفاً ابتدا حساب خود را شارژ کنید.");
    return outcome;
  }
  if (outcome.failure === "user_not_found") {
    await send(bot, chatId, "❌ حساب کاربری شما پیدا نشد. لطفاً دوباره از ربات شروع کنید.");
    return outcome;
  }
  if (outcome.status === "refunded") {
    await send(bot, chatId, "❌ ایجاد سرویس انجام نشد و مبلغ رزروشده به کیف پول شما بازگشت.");
    return outcome;
  }
  if (outcome.status === "refund_pending") {
    await send(bot, chatId, "❌ درخواست پنل انجام نشد، اما بازپرداخت هنوز در حال پردازش است. لطفاً سفارش دیگری ثبت نکنید تا موجودی نهایی شود.");
    return outcome;
  }
  if (["manual_review", "uncertain"].includes(outcome.status)) {
    await send(bot, chatId, "⏳ وضعیت ساخت سرویس از پنل مشخص نیست و مبلغ شما موقتاً رزرو شده است. برای جلوگیری از ساخت تکراری، لطفاً دوباره خرید نکنید.");
    return outcome;
  }

  await send(bot, chatId, "⏳ درخواست خرید شما در حال ثبت است؛ لطفاً سفارش را تکرار نکنید.");
  return outcome;
}
