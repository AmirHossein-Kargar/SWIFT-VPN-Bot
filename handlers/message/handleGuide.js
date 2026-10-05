import { renderUiScreen } from "../../utils/telegramUi.js";

export const guideButtons = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "📲 اتصال در اندروید", url: "https://t.me/swift_shield/7" },
        { text: "📱 اتصال در آیفون", url: "https://t.me/swift_shield/6" },
      ],
      [{ text: "💻 اتصال در ویندوز", url: "https://t.me/swift_shield/8" }],
      [{ text: "🛒 آموزش خرید از ربات", url: "https://t.me/swift_shield/6" }],
      [{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }],
    ],
  },
};

const handleGuide = async (bot, chatId, messageId) => {
  const guideMessage = `📕 <b>راهنمای سویفت</b>

📱 اتصال به سرویس‌ها در اندروید، آیفون و ویندوز امکان‌پذیر است.
🔗 راهنمای دستگاه خود را از دکمه‌های زیر باز کنید.`;

  return renderUiScreen(
    bot,
    chatId,
    messageId,
    guideMessage,
    { parse_mode: "HTML", ...guideButtons },
    { step: null, support: false, supportMessageId: null }
  );
};

export default handleGuide;
