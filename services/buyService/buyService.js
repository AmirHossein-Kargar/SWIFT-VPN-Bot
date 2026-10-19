// Customer duration choices come from the fixed server-side subscription durations.
import { getDurationOptionByDays, getSubscriptionDurationOptions } from "../plans.js";

export const DURATION_SELECTION_MESSAGE = `🛡️ <b>خرید اشتراک اختصاصی SWIFT VPN</b>

لطفاً مدت زمان اشتراک موردنظر خود را انتخاب کنید تا پلن‌های متناسب با نیازتان نمایش داده شود:`;

export const buildDurationSelectionMarkup = () => {
  const options = getSubscriptionDurationOptions();
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        ...options.map(({ days, label }) => [
          { text: label, callback_data: `duration_${days}` },
        ]),
        [{ text: "🔙 بازگشت", callback_data: "buy_service_back_to_main" }],
      ],
    },
  };
};

export const buildDurationPlansMessage = (durationDays, plans = []) => {
  const option = getDurationOptionByDays(durationDays);
  const durationTitle = option ? `${option.title} (${durationDays} روز)` : `${durationDays} روزه`;
  const planLines = plans
    .map((plan) => `• 🔹 ${plan.gig} گیگابایت — ${plan.price.toLocaleString("en-US")} تومان`)
    .join("\n");

  return [
    "🛡️ <b>پلن‌های اختصاصی SWIFT VPN</b>",
    "",
    `مدت اشتراک: <b>${durationTitle}</b>`,
    "",
    "حجم موردنظرت رو انتخاب کن و با خیال راحت از سرویس استفاده کن.",
    "",
    planLines,
    "",
    "🔻 برای ادامه، یکی از پلن‌های زیر را انتخاب کنید:",
  ].join("\n");
};

const handleBuyService = async (bot, chatId) => {
  await bot.sendMessage(chatId, DURATION_SELECTION_MESSAGE, buildDurationSelectionMarkup());
};

export default handleBuyService;
