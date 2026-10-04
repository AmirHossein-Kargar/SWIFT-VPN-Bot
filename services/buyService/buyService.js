// * This function handles the "Buy Service" feature.
// * Duration groups are derived from the Admin Panel product catalog (the
// * authoritative source), with the shipped 30/60/90 groups as fallback.
import { getAvailableDurations } from "../plans.js";

const DURATION_ICONS = { 30: "🔹", 60: "🔸", 90: "🔷" };

const handleBuyService = async (bot, chatId) => {
  const message = `🛒 در 2 مرحله سرویس اختصاصی بگیرید ..

🔻 ابتدا مدت زمان سرویس را انتخاب کنید:`;

  const durations = await getAvailableDurations();
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
