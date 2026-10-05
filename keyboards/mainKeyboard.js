/**
 * Customer navigation is an inline, editable bot interface. This replaces the
 * old reply keyboard, so normal navigation no longer creates user messages.
 */
export const homeInlineKeyboard = {
  inline_keyboard: [
    [
      { text: "🛒 خرید سرویس", callback_data: "home_buy_service" },
      { text: "📦 سرویس‌های من", callback_data: "home_my_services" },
    ],
    [
      { text: "💰 افزایش موجودی", callback_data: "home_topup" },
      { text: "🎁 سرویس تست", callback_data: "home_test_service" },
    ],
    [
      { text: "👤 پروفایل من", callback_data: "home_profile" },
      { text: "📖 راهنما", callback_data: "home_guide" },
    ],
    [{ text: "🛠 پشتیبانی", callback_data: "home_support" }],
  ],
};

// Keep the historical import shape for payment notifications and other callers.
const keyboard = { reply_markup: homeInlineKeyboard };

export default keyboard;
