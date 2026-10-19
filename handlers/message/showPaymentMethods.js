import { setSession } from "../../config/sessionStore.js";

export const HOOSH_PAY_BUTTON = "💳 پرداخت آنلاین کارت به کارت";
export const NOWPAYMENTS_BUTTON = "🪙 پرداخت با کریپتو";

// HooshPay stays the first method and still uses its own provider.
// New TRON top-ups use NOWPayments. The older direct TRX callback remains
// routed so an already-open invoice can still be finished by the scanner.
const showPaymentMethods = async (bot, chatId) => {
  const message = "<b>💰 افزایش موجودی کیف پول</b>\n\nلطفاً روش پرداخت را انتخاب کنید.";

  const topUpButtons = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: HOOSH_PAY_BUTTON, callback_data: "pay_hoosh" }],
        [{ text: NOWPAYMENTS_BUTTON, callback_data: "pay_nowpayments" }],
        [{ text: "🔙 بازگشت", callback_data: "back_to_home" }],
      ],
    },
  };

  // * Send the message with the inline keyboard and disable the main keyboard
  const sentMessage = await bot.sendMessage(chatId, message, topUpButtons);

  await setSession(chatId, {
    step: "waiting_for_payment_method",
    messageId: sentMessage.message_id,
  })

  return sentMessage;
};

export default showPaymentMethods;
