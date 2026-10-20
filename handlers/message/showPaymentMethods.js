import { setSession as defaultSetSession } from "../../config/sessionStore.js";

export const HOOSH_PAY_BUTTON = "💳 پرداخت آنلاین کارت به کارت";
export const NOWPAYMENTS_BUTTON = "🪙 پرداخت با کریپتو";

// HooshPay stays the first method and still uses its own provider.
// New TRON top-ups use NOWPayments. The older direct TRX callback remains
// routed so an already-open invoice can still be finished by the scanner.
//
// Deliberately independent of services/messaging/* (messageManager.js /
// activeMessageStore.js): from this screen onward, the whole payment flow
// tracks its one live message via session.messageId, edited step by step
// (amount prompt, invoice, card/wallet details, ...). That must never be
// exposed to the shared, chat-wide active-message pointer used by
// throwaway navigation screens (profile, guide, my services) — those can
// look up and edit "the active screen" with no explicit message id, which
// would risk silently overwriting a live invoice or payment instructions.
//
// @param {object} [options]
// @param {number} [options.messageId] - edit this exact message (e.g. the
//   profile screen's message id, when reached via topup_from_profile)
//   instead of sending a new one, when that is still possible.
// @param {Function} [options.setSession] - test-only override.
const showPaymentMethods = async (bot, chatId, { messageId, setSession = defaultSetSession } = {}) => {
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

  let resultMessageId;
  if (messageId != null) {
    try {
      await bot.editMessageText(message, { ...topUpButtons, chat_id: chatId, message_id: messageId });
      resultMessageId = messageId;
    } catch (error) {
      // The caller's screen could not be turned into this one (deleted, too
      // old, or otherwise not editable) — send a fresh one and clean up the
      // now-stale screen, exactly like every other delete-then-send
      // transition in this codebase already does on a failed edit.
      const sentMessage = await bot.sendMessage(chatId, message, topUpButtons);
      resultMessageId = sentMessage?.message_id ?? null;
      await bot.deleteMessage(chatId, messageId).catch(() => {});
    }
  } else {
    // * Send the message with the inline keyboard and disable the main keyboard
    const sentMessage = await bot.sendMessage(chatId, message, topUpButtons);
    resultMessageId = sentMessage?.message_id ?? null;
  }

  await setSession(chatId, {
    step: "waiting_for_payment_method",
    messageId: resultMessageId,
  });

  return { message_id: resultMessageId };
};

export default showPaymentMethods;
