// * Duration groups come from the Admin Panel product catalog (authoritative).
import { getAvailableDurations } from "../plans.js";
import { renderUiScreen } from "../../utils/telegramUi.js";

const DURATION_ICONS = { 30: "🔹", 60: "🔸", 90: "🔷" };

const handleBuyService = async (bot, chatId, messageId) => {
  const durations = await getAvailableDurations();
  const durationButtons = {
    inline_keyboard: [
      ...durations.map((days) => [
        { text: `${DURATION_ICONS[days] || "▫️"} ${days} روزه`, callback_data: `duration_${days}` },
      ]),
      [{ text: "🏠 منوی اصلی", callback_data: "buy_service_back_to_main" }],
    ],
  };

  return renderUiScreen(
    bot,
    chatId,
    messageId,
    `🛒 <b>خرید سرویس</b>\n\nمدت‌زمان سرویس را انتخاب کنید:`,
    { parse_mode: "HTML", reply_markup: durationButtons },
    { step: null, support: false, supportMessageId: null }
  );
};

export default handleBuyService;
