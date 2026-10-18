import { getSession, setSession } from "../config/sessionStore.js";

const RESTART_TEXT = "❌ این درخواست پرداخت ترون قدیمی است و دیگر با نرخ لحظه‌ای ساخته نمی‌شود.\n\n"
  + "لطفاً به روش‌های پرداخت برگردید و «پرداخت با ترون» را دوباره انتخاب کنید.\n"
  + "مبلغی که الان فرستادید ثبت نشده است.";

const BACK = {
  reply_markup: {
    inline_keyboard: [[{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }]],
  },
};

export default async function handleTrxAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  const stored = await getSession(chatId);
  const sessionData = stored?.messageId ? stored : { ...(session || {}), ...(stored || {}) };
  const botMessageId = sessionData?.messageId;

  await setSession(chatId, {
    ...sessionData,
    step: null,
    paymentType: null,
    paymentId: null,
  });

  const options = {
    chat_id: chatId,
    parse_mode: "HTML",
    ...BACK,
  };
  if (botMessageId) {
    try {
      await bot.editMessageText(RESTART_TEXT, { ...options, message_id: botMessageId });
      return;
    } catch {
      /* fall through to a new message */
    }
  }
  await bot.sendMessage(chatId, RESTART_TEXT, options);
}

export async function sendTrxWallet(bot, chatId, session) {
  const trxWallet = process.env.TRX_WALLET;
  await bot.editMessageText(`آدرس پرداخت TRX:\n<code>${trxWallet}</code>`, {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "ارسال Hash TRX",
            callback_data: "send_trx_hash",
          },
          {
            text: "🔙 بازگشت به روش‌های پرداخت",
            callback_data: "back_to_topup",
          },
        ],
      ],
    },
  });
}
