import User from "../../models/User.js";
import { renderUiScreen } from "../../utils/telegramUi.js";

async function sendServiceSelectionMenu(bot, chatId, userId, messageId) {
  try {
    const user = await User.findOne({ telegramId: String(userId) }).lean();
    const services = Array.isArray(user?.services) ? user.services : [];
    const serviceButtons = services.map((service) => [
      {
        text: service.username || "بدون نام",
        callback_data: `show_service_${service.username || ""}`,
      },
    ]);

    const reply_markup = services.length
      ? {
          inline_keyboard: [
            ...serviceButtons,
            [{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }],
          ],
        }
      : {
          inline_keyboard: [
            [{ text: "🛒 خرید سرویس", callback_data: "home_buy_service" }],
            [{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }],
          ],
        };

    return await renderUiScreen(
      bot,
      chatId,
      messageId,
      services.length
        ? "📌 یکی از اشتراک‌های خود را انتخاب کنید:"
        : "⚠️ هنوز سرویسی در حساب شما ثبت نشده است.",
      { reply_markup },
      { step: null, support: false, supportMessageId: null }
    );
  } catch (error) {
    console.error("Error sending service selection menu:", error?.name || "Error");
    return renderUiScreen(
      bot,
      chatId,
      messageId,
      "❌ خطایی رخ داد، لطفاً دوباره تلاش کنید.",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }]] } },
      { step: null, support: false, supportMessageId: null }
    ).catch(() => {});
  }
}

export default sendServiceSelectionMenu;
