import { createVpnService, StatusApi } from "../../api/wizardApi.js";
import { setSession } from "../../config/sessionStore.js";
import { isAdmin } from "../../utils/auth.js";

const apiServicePurchase = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;

  // بررسی دسترسی ادمین (fail-closed via utils/auth.js)
  if (!isAdmin(chatId, userId)) {
    await bot.answerCallbackQuery(query.id, {
      text: "⛔️ شما دسترسی انجام این عملیات را ندارید",
      show_alert: true,
    });
    return;
  }

  try {
    // دریافت قیمت‌های API
    const statusData = await StatusApi();
    if (!statusData.ok) {
      await bot.answerCallbackQuery(query.id, {
        text: "❌ خطا در دریافت قیمت‌های API",
        show_alert: true,
      });
      return;
    }

    const { per_gb, per_day } = statusData.result;

    const message =
      `🛒 <b>خرید سرویس از API</b>\n\n` +
      `💰 <b>قیمت‌های فعلی:</b>\n` +
      `• هر گیگ: <code>${per_gb.toLocaleString()}</code> تومان\n` +
      `• هر روز: <code>${per_day.toLocaleString()}</code> تومان\n\n` +
      `📝 <b>لطفاً مشخصات سرویس را وارد کنید:</b>\n\n` +
      `برای شروع، تعداد گیگ مورد نیاز را ارسال کنید (مثال: 10)`;

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "❌ لغو", callback_data: "admin_cancel_api_purchase" },
            { text: "🏠 بازگشت", callback_data: "admin_panel" },
          ],
        ],
      },
    });

    // تنظیم session برای دریافت گیگ
    await setSession(chatId, {
      step: "waiting_for_api_gig",
      per_gb,
      per_day,
      messageId,
    });

    await bot.answerCallbackQuery(query.id, {
      text: "✅ لطفاً تعداد گیگ را وارد کنید",
    });
  } catch (error) {
    console.error("Error in apiServicePurchase:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "❌ خطا در شروع فرآیند خرید",
      show_alert: true,
    });
  }
};

// Handler برای دریافت تعداد گیگ
const handleApiGigInput = async (bot, msg, session) => {
  const chatId = msg.chat.id;
  const gigText = msg.text?.trim();
  const messageId = session.messageId;

  if (!gigText || isNaN(gigText) || parseInt(gigText) <= 0) {
    await bot.sendMessage(
      chatId,
      "❌ لطفاً یک عدد معتبر برای گیگ وارد کنید (مثال: 10)"
    );
    return;
  }

  const gig = parseInt(gigText);
  const per_gb = session.per_gb;
  const per_day = session.per_day;

  const gigPrice = gig * per_gb;

  const message =
    `📊 <b>مشخصات سرویس:</b>\n\n` +
    `💾 حجم: <code>${gig}</code> گیگ\n` +
    `💰 قیمت حجم: <code>${gigPrice.toLocaleString()}</code> تومان\n\n` +
    `📝 حالا تعداد روز مورد نیاز را وارد کنید (مثال: 30)`;

  try {
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "❌ لغو", callback_data: "admin_cancel_api_purchase" },
            { text: "🏠 بازگشت", callback_data: "admin_panel" },
          ],
        ],
      },
    });

    // به‌روزرسانی session
    await setSession(chatId, {
      step: "waiting_for_api_days",
      per_gb,
      per_day,
      gig,
      gigPrice,
      messageId,
    });

    // حذف پیام کاربر
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  } catch (error) {
    console.error("Error in handleApiGigInput:", error);
    await bot.sendMessage(chatId, "❌ خطا در پردازش اطلاعات");
  }
};

// Handler برای دریافت تعداد روز
const handleApiDaysInput = async (bot, msg, session) => {
  const chatId = msg.chat.id;
  const daysText = msg.text?.trim();
  const messageId = session.messageId;

  if (!daysText || isNaN(daysText) || parseInt(daysText) <= 0) {
    await bot.sendMessage(
      chatId,
      "❌ لطفاً یک عدد معتبر برای روز وارد کنید (مثال: 30)"
    );
    return;
  }

  const days = parseInt(daysText);
  const { per_gb, per_day, gig, gigPrice } = session;

  const daysPrice = days * per_day;
  const totalPrice = gigPrice + daysPrice;

  const message =
    `📋 <b>خلاصه سفارش:</b>\n\n` +
    `💾 حجم: <code>${gig}</code> گیگ\n` +
    `📅 مدت: <code>${days}</code> روز\n\n` +
    `💰 <b>محاسبه قیمت:</b>\n` +
    `• قیمت حجم: <code>${gigPrice.toLocaleString()}</code> تومان\n` +
    `• قیمت زمان: <code>${daysPrice.toLocaleString()}</code> تومان\n` +
    `• <b>مجموع: <code>${totalPrice.toLocaleString()}</code> تومان</b>\n\n` +
    `✅ آیا می‌خواهید این سرویس را ایجاد کنید؟`;

  try {
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ ایجاد سرویس",
              callback_data: "admin_create_api_service",
            },
            { text: "❌ لغو", callback_data: "admin_cancel_api_purchase" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_panel" }],
        ],
      },
    });

    // به‌روزرسانی session
    await setSession(chatId, {
      step: "waiting_for_api_confirmation",
      per_gb,
      per_day,
      gig,
      days,
      totalPrice,
      messageId,
    });

    // حذف پیام کاربر
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  } catch (error) {
    console.error("Error in handleApiDaysInput:", error);
    await bot.sendMessage(chatId, "❌ خطا در پردازش اطلاعات");
  }
};

// Handler برای ایجاد سرویس
const createApiService = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const { gig, days } = session;

  try {
    // نمایش پیام در حال ساخت
    await bot.editMessageText("⏳ در حال ساخت سرویس از API...", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
    });

    // ایجاد سرویس از API
    const apiResponse = await createVpnService(gig, days, 0);

    if (apiResponse && apiResponse.ok && apiResponse.result) {
      const result = apiResponse.result;
      const username = result.username || "نامشخص";
      const hash = result.hash;

      // ساخت لینک‌ها
      const smartLink = hash
        ? `https://iranisystem.com/bot/sub/?hash=${hash}`
        : "";
      const singleLink =
        Array.isArray(result.tak_links) && result.tak_links.length > 0
          ? result.tak_links[0]
          : "";

      // ساخت QR Code
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
        smartLink
      )}&size=200x200&margin=20`;

      // پیام موفقیت
      const successMessage =
        `✅ <b>سرویس شما با موفقیت ساخته شد!</b>\n\n` +
        `🆔 <b>آیدی سرویس:</b> <code>${username}</code>\n\n` +
        `🔗 <b>لینک اتصال (Subscription):</b>\n` +
        `<code>${smartLink}</code>\n\n`;

      let finalMessage = successMessage;

      if (singleLink) {
        finalMessage +=
          `👈 <b>لینک تکی از لوکیشن پیشنهادی:</b>\n` +
          `<code>${singleLink}</code>\n\n`;
      }

      finalMessage +=
        `📌 برای کپی لینک، روی آن لمس طولانی کنید یا راست‌ کلیک کنید.\n\n` +
        `⚠️ این سرویس از نوع Subscription است. برای اتصال، از راهنمای زیر استفاده کنید.`;

      // ارسال QR Code و پیام
      await bot.sendPhoto(chatId, qrUrl, {
        caption: finalMessage,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📱 راهنمای اتصال",
                callback_data: "admin_show_connection_guide",
              },
              {
                text: "🔄 تغییر لینک",
                callback_data: `admin_change_link_${username}`,
              },
            ],
            [
              {
                text: "❌ حذف سرویس",
                callback_data: `admin_delete_service_${username}`,
              },
              { text: "🏠 بازگشت", callback_data: "admin_panel" },
            ],
          ],
        },
      });

      // پاک کردن session
      await setSession(chatId, { step: null });

      await bot.answerCallbackQuery(query.id, {
        text: "✅ سرویس با موفقیت ایجاد شد",
      });
    } else {
      const errorMessage = apiResponse?.error || "خطای نامشخص در API";
      await bot.editMessageText(
        `❌ خطا در ایجاد سرویس:\n\n<code>${errorMessage}</code>`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 تلاش مجدد",
                  callback_data: "admin_api_service_purchase",
                },
                { text: "🏠 بازگشت", callback_data: "admin_panel" },
              ],
            ],
          },
        }
      );

      await bot.answerCallbackQuery(query.id, {
        text: "❌ خطا در ایجاد سرویس",
        show_alert: true,
      });
    }
  } catch (error) {
    console.error("Error in createApiService:", error);
    await bot.editMessageText(
      `❌ خطا در ایجاد سرویس:\n\n<code>${error.message}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 تلاش مجدد",
                callback_data: "admin_api_service_purchase",
              },
              { text: "🏠 بازگشت", callback_data: "admin_panel" },
            ],
          ],
        },
      }
    );

    await bot.answerCallbackQuery(query.id, {
      text: "❌ خطا در ایجاد سرویس",
      show_alert: true,
    });
  }
};

// Handler برای لغو خرید
const cancelApiPurchase = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    await bot.editMessageText("❌ خرید سرویس لغو شد", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 بازگشت", callback_data: "admin_panel" }],
        ],
      },
    });

    // پاک کردن session
    await setSession(chatId, { step: null });

    await bot.answerCallbackQuery(query.id, {
      text: "❌ خرید لغو شد",
    });
  } catch (error) {
    console.error("Error in cancelApiPurchase:", error);
  }
};

export {
  apiServicePurchase,
  handleApiGigInput,
  handleApiDaysInput,
  createApiService,
  cancelApiPurchase,
};
