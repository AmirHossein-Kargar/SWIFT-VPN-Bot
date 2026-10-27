import { isAdmin } from "../utils/auth.js";
import {
  RESERVED_CALLBACK_PREFIX,
  reservedCancelConfirmKeyboard,
  reservedOrderKeyboard,
  reservedOrderText,
} from "../services/buyService/reservedAlerts.js";
import {
  approveReservedOrder,
  cancelReservedOrder,
  isValidOrderRef,
  refreshReservedOrder,
} from "../services/buyService/reservedFulfillment.js";

const ACTIONS = new Set(["ok", "rf", "no", "nc"]);

async function answer(bot, queryId, text, alert = false) {
  try {
    await bot.answerCallbackQuery(queryId, text ? { text, show_alert: alert } : undefined);
  } catch {
    // The callback may have expired; the admin message edit below still shows the outcome.
  }
}

async function render(bot, query, purchase, { confirmCancel = false } = {}) {
  const message = query.message;
  if (!purchase || !message) return;
  try {
    await bot.editMessageText(reservedOrderText(purchase), {
      chat_id: message.chat.id,
      message_id: message.message_id,
      parse_mode: "HTML",
      reply_markup: confirmCancel ? reservedCancelConfirmKeyboard(purchase) : reservedOrderKeyboard(purchase),
    });
  } catch {
    // "message is not modified" / deleted message: nothing to fix, state lives in the database.
  }
}

/**
 * Admin-group buttons on a reserved (awaiting provider funds) order: rsv:<ok|rf|no|nc>:<order _id>.
 * Authorization is checked here and again inside the service; callback data carries only an opaque order reference, so
 * a stale or forged button can never supply a price, plan or user — and any stale tap is evaluated against the order's
 * current persisted state, not the state the button was rendered with.
 * @returns {Promise<boolean>} true when the callback was handled.
 */
export async function handleReservedOrderCallback(bot, query, deps = {}) {
  try {
    return await dispatch(bot, query, deps);
  } catch (error) {
    // A database/Telegram failure must neither leave the admin on an endless spinner nor leak internals. The order
    // state is persisted atomically, so pressing "recheck" shows what actually happened.
    console.error(JSON.stringify({ service: "reserved-orders", level: "error", message: "Reserved-order callback failed", errorType: error?.name || "Error" }));
    await answer(bot, query?.id, "⚠️ خطا در پردازش. وضعیت سفارش را با «بررسی مجدد» ببینید.", true);
    return true;
  }
}

async function dispatch(bot, query, deps) {
  const data = String(query?.data ?? "");
  if (!data.startsWith(RESERVED_CALLBACK_PREFIX)) return false;

  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  if (!isAdmin(chatId, userId)) {
    await answer(bot, query.id, "⛔ دسترسی ندارید.", true);
    return true;
  }

  const [, action, orderRef] = data.split(":");
  if (!ACTIONS.has(action) || !isValidOrderRef(orderRef)) {
    await answer(bot, query.id, "⚠️ دکمه نامعتبر است.", true);
    return true;
  }

  if (action === "rf") {
    const result = await refreshReservedOrder({ orderRef, adminId: userId, ...deps });
    if (result.outcome === "not_found") {
      await answer(bot, query.id, "⚠️ سفارش پیدا نشد.", true);
      return true;
    }
    await answer(bot, query.id, "🔄 وضعیت به‌روز شد.");
    await render(bot, query, result.purchase);
    return true;
  }

  if (action === "no") {
    const result = await refreshReservedOrder({ orderRef, adminId: userId, ...deps });
    if (result.outcome !== "status") {
      await answer(bot, query.id, "⚠️ سفارش پیدا نشد.", true);
      return true;
    }
    if (result.purchase.status !== "awaiting_provider") {
      await answer(bot, query.id, "⚠️ این سفارش دیگر قابل لغو نیست.", true);
      await render(bot, query, result.purchase);
      return true;
    }
    await answer(bot, query.id, "برای لغو و بازپرداخت، تأیید کنید.");
    await render(bot, query, result.purchase, { confirmCancel: true });
    return true;
  }

  if (action === "nc") {
    await answer(bot, query.id, "⏳ در حال لغو و بازپرداخت…");
    const result = await cancelReservedOrder({ orderRef, adminId: userId, bot, ...deps });
    await render(bot, query, result.purchase);
    if (result.outcome === "not_cancellable") {
      await bot.sendMessage(chatId, "⚠️ این سفارش قابل لغو نیست (در حال پردازش یا قبلاً نهایی شده است).").catch(() => {});
    } else if (result.outcome === "refund_pending") {
      await bot.sendMessage(chatId, "⚠️ بازپرداخت کامل نشد و در صف بررسی ثبت شد. دوباره دکمه «بررسی مجدد» را بزنید.").catch(() => {});
    }
    return true;
  }

  // action === "ok"
  await answer(bot, query.id, "⏳ در حال ایجاد سرویس…");
  const result = await approveReservedOrder({ orderRef, adminId: userId, bot, ...deps });
  await render(bot, query, result.purchase);
  const notice = {
    not_found: "⚠️ سفارش پیدا نشد.",
    not_claimable: "⚠️ این سفارش در حال حاضر قابل تأیید نیست؛ وضعیت فعلی در پیام به‌روز شد.",
    invalid_reservation: "⛔ رزرو کیف پول این سفارش تأیید نشد؛ سفارش برای بررسی دستی علامت‌گذاری شد.",
    still_short: "⚠️ موجودی کیف پول WizardXray هنوز کافی نیست. پس از شارژ، دوباره تأیید کنید.",
    unknown_outcome: "⛔ نتیجه ساخت در پنل نامشخص است. برای جلوگیری از ساخت تکراری، ابتدا پنل را بررسی کنید.",
    refunded: "ℹ️ پنل درخواست را رد کرد و مبلغ به کاربر بازگشت.",
    pending: "⏳ سفارش هنوز در حال پردازش است.",
  }[result.outcome];
  if (result.outcome === "fulfilled") {
    await bot.sendMessage(
      chatId,
      result.notified
        ? "✅ سرویس ایجاد و برای کاربر ارسال شد."
        : "✅ سرویس ایجاد شد؛ ارسال به کاربر ناموفق بود و به‌صورت خودکار دوباره تلاش می‌شود."
    ).catch(() => {});
  } else if (notice) {
    await bot.sendMessage(chatId, notice).catch(() => {});
  }
  return true;
}
