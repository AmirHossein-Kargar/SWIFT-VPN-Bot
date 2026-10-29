import User from "../../models/User.js";
import { renderInterface } from "../messaging/messageManager.js";

/**
 * @param {object} [options]
 * @param {number} [options.messageId] - edit this exact message (e.g. the
 *   profile screen's message id, when reached via my_services_from_profile)
 *   instead of sending a new one, when that is still possible.
 * @param {object} [options.userModel] - test-only override for User (see
 *   handlers/message/handleProfile.js for the same convention).
 */
async function sendServiceSelectionMenu(bot, chatId, userId, { messageId, userModel = User } = {}) {
  try {
    const user = await userModel.findOne({ telegramId: userId });
    if (!user || !Array.isArray(user.services) || user.services.length === 0) {
      await renderInterface(bot, { chatId, text: "⚠️ شما هیچ سرویسی ندارید.", messageId, options: { reply_markup: { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]] } } });
      return;
    }

    // * create buttons for services (each button should be an array for inline_keyboard)
    const serviceButtons = user.services.map((service) => [
      {
        text: service.username || "بدون نام",
        callback_data: `show_service_${service.username || ""}`,
      },
    ]);

    await renderInterface(bot, {
      chatId,
      text: "📌 یکی از اشتراک‌های زیر را انتخاب کنید:",
      options: { reply_markup: { inline_keyboard: [...serviceButtons, [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]] } },
      messageId,
    });
  } catch (error) {
    console.error("Error sending service selection menu:", error);
    await renderInterface(bot, {
      chatId,
      text: "❌ خطایی رخ داد، لطفا دوباره تلاش کنید.",
      options: { reply_markup: { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]] } },
      messageId,
    });
  }
}

export default sendServiceSelectionMenu;
