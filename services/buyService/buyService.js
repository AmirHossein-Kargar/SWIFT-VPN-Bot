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

// The plan catalog is shown only as keyboard buttons (keyboards/generatePlanButtons.js); this message never repeats it.
export const buildDurationPlansMessage = (durationDays) => {
  const option = getDurationOptionByDays(durationDays);
  const durationTitle = option ? `${option.title} (${durationDays} روز)` : `${durationDays} روزه`;

  return [
    "🛡️ <b>پلن‌های اختصاصی SWIFT VPN</b>",
    "",
    `مدت اشتراک: <b>${durationTitle}</b>`,
    "",
    "حجم موردنظرت رو از دکمه‌های زیر انتخاب کن و با خیال راحت از سرویس استفاده کن.",
  ].join("\n");
};

const handleBuyService = async (bot, chatId, { messageId } = {}) => {
  const markup = buildDurationSelectionMarkup();
  if (messageId != null) {
    try {
      await bot.editMessageText(DURATION_SELECTION_MESSAGE, { ...markup, chat_id: chatId, message_id: messageId });
      return;
    } catch (error) {
      if (/message is not modified/i.test(String(error?.response?.body?.description || error?.message))) return;
      // Not editable (deleted / too old / media): fall back to one fresh menu.
    }
  }
  await bot.sendMessage(chatId, DURATION_SELECTION_MESSAGE, markup);
};

export default handleBuyService;
