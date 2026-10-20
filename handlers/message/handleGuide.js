// * This function handles the "guide" section of the bot
import { renderInterface } from "../../services/messaging/messageManager.js";

export const guideButtons = {
  reply_markup: {
    inline_keyboard: [
      [
        // * Android connection guide
        { text: "📲 اتصال در اندروید", url: "https://t.me/swift_shield/7" },
        // * iOS connection guide
        { text: "📱 اتصال در آیفون", url: "https://t.me/swift_shield/6" },
      ],
      [
        // * Windows connection guide
        { text: "💻 اتصال در ویندوز", url: "https://t.me/swift_shield/8" },
      ],
      [
        // * Guide for purchasing from the bot
        { text: "🛒 آموزش خرید از ربات", url: "https://t.me/swift_shield/6" },
      ],
    ],
  },
};

const handleGuide = async (bot, chatId) => {
  // * Main message shown to the user
  const guideMessage = `📕 به بخش راهنمای ربات خوش آمدید

📱 اتصال به سرویس‌ها در همه نوع دیوایس‌ها (آیفون، اندروید، ویندوز) امکان‌پذیر است
🔗 نحوه اتصال به سرویس‌ها را از طریق لینک‌های زیر مطالعه بفرمایید:
(برنامه مورد نیاز + آموزش قدم به قدم)`;

  // Guide has no callback_data of its own (every button below is a plain
  // URL, handled client-side by Telegram) and no "back" entry point, so
  // there is no message id to trust from the current update. It only edits
  // the chat's existing tracked interface message when one is known safe —
  // i.e. it was itself put there by renderInterface — and otherwise sends
  // fresh, exactly as before.
  await renderInterface(bot, { chatId, text: guideMessage, options: guideButtons });
};

export default handleGuide;
