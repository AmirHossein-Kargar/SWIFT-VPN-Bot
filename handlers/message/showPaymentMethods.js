import { renderUiScreen } from "../../utils/telegramUi.js";

// * HooshPay is the primary online payment method; TRX remains available.
const showPaymentMethods = async (bot, chatId, messageId) => {
  const message = `💰 <b>افزایش موجودی کیف پول</b>

روش پرداخت دلخواه را انتخاب کنید.`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "💳 پرداخت آنلاین (HooshPay)", callback_data: "pay_hoosh" }],
      [{ text: "💸 پرداخت با ترون (TRX)", callback_data: "pay_trx" }],
      [{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }],
    ],
  };

  const sentMessage = await renderUiScreen(
    bot,
    chatId,
    messageId,
    message,
    { parse_mode: "HTML", reply_markup },
    {
      step: "waiting_for_payment_method",
      paymentId: null,
      paymentType: null,
      support: false,
      supportMessageId: null,
    }
  );

  return sentMessage;
};

export default showPaymentMethods;
