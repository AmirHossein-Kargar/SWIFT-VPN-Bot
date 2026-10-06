// Customer duration choices come from the fixed server-side selling plans.
import { getCustomerDurations } from "../plans.js";

const DURATION_ICONS = { 1: "🎁", 7: "🔹", 15: "🔸", 30: "🔷" };

const handleBuyService = async (bot, chatId) => {
  const message = `🛒 در 2 مرحله سرویس اختصاصی بگیرید ..

🔻 ابتدا مدت زمان سرویس را انتخاب کنید:`;

  const durations = getCustomerDurations();
  const durationButtons = {
    reply_markup: {
      inline_keyboard: [
        ...durations.map((days) => [
          { text: `${DURATION_ICONS[days] || "▫️"} ${days} روزه`, callback_data: `duration_${days}` },
        ]),
        [{ text: "🔙 بازگشت", callback_data: "buy_service_back_to_main" }],
      ],
    },
  };

  await bot.sendMessage(chatId, message, durationButtons);
};

export default handleBuyService;
