import User from "../../models/User.js";

async function sendServiceSelectionMenu(bot, chatId, userId) {
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user || !Array.isArray(user.services) || user.services.length === 0) {
      await bot.sendMessage(chatId, "⚠️ شما هیچ سرویسی ندارید.");
      return;
    }

    // * create buttons for services (each button should be an array for inline_keyboard)
    const serviceButtons = user.services.map((service) => [
      {
        text: service.username || "بدون نام",
        callback_data: `show_service_${service.username || ""}`,
      },
    ]);

    await bot.sendMessage(chatId, "📌 یکی از اشتراک‌های زیر را انتخاب کنید:", {
      reply_markup: {
        inline_keyboard: serviceButtons,
      },
    });
  } catch (error) {
    console.error("Error sending service selection menu:", error);
    await bot.sendMessage(chatId, "❌ خطایی رخ داد، لطفا دوباره تلاش کنید.");
  }
}

export default sendServiceSelectionMenu;
