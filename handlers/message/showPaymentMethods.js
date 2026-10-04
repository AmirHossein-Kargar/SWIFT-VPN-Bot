import { setSession } from "../../config/sessionStore.js";

// * This function sends payment method options to the user.
// * HooshPay is the primary online payment method; direct card-to-card was
// * removed from the customer-facing flow (admin reconciliation of historical
// * bank receipts remains available in the admin panel).
const showPaymentMethods = async (bot, chatId) => {
  // * Main message shown to the user
  const message = `
<b>💰 افزایش موجودی کیف پول</b>

لطفاً روش پرداخت را انتخاب کنید.
  `;

  // * Inline keyboard with different payment options
  const topUpButtons = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 پرداخت آنلاین (HooshPay)", callback_data: "pay_hoosh" }],
        [{ text: "💸 پرداخت با ترون (TRX)", callback_data: "pay_trx" }],
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
