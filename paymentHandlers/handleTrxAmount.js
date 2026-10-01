import validationAmountTrx from "../utils/validationAmountTrx.js";
import { getSession, setSession } from "../config/sessionStore.js";
import { USDPrice } from "../api/USDPrice.js";
import { TRXPrice } from "../api/TRXPrice.js";
import CryptoInvoice from "../models/CryptoInvoice.js";

export default async function handleTrxAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Delete the user's message to keep the chat clean
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  const sessionData = await getSession(chatId);
  const botMessageId = sessionData?.messageId;

  if (!botMessageId) return;

  // Set session to wait for TRX amount input
  await setSession(chatId, {
    ...sessionData,
    step: null,
    paymentType: "trx", // Add payment type to session
  });

  // Validate the amount entered by the user
  const { valid, amount, message } = validationAmountTrx(text);

  if (!valid) {
    return bot.editMessageText(message, {
      chat_id: chatId,
      message_id: botMessageId,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔙 بازگشت به روش‌های پرداخت",
              callback_data: "back_to_topup",
            },
          ],
        ],
      },
    });
  }

  // Get USD and TRX rates
  let usdRate, trxRate;
  try {
    usdRate = await USDPrice();
    trxRate = await TRXPrice();
  } catch (error) {
    console.error("Error fetching rates:", error);
    await bot.editMessageText(
      `❌ خطا در دریافت نرخ ارز

${error.message}

🔙 لطفاً دوباره تلاش کنید یا از روش‌های دیگر پرداخت استفاده کنید.`,
      {
        chat_id: chatId,
        message_id: botMessageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔙 بازگشت به روش‌های پرداخت",
                callback_data: "back_to_topup",
              },
            ],
          ],
        },
      }
    );
    await setSession(chatId, { ...sessionData, step: null });
    return;
  }
  const trxWallet = process.env.TRX_WALLET;

  const usdAmount = amount / usdRate;
  const finalTrxAmount = usdAmount / trxRate;
  const paymentId = Math.random().toString(36).slice(2, 8).toUpperCase();

  // Show success message
  await bot.editMessageText(
    `✅ مبلغ ${amount.toLocaleString()} تومان ثبت شد و فاکتور در حال ساخت است.`,
    {
      chat_id: chatId,
      message_id: botMessageId,
    }
  );

  try {
    await CryptoInvoice.create({
      invoiceId: paymentId,
      userId: chatId,
      amount: amount,
      usdAmount: usdAmount,
      cryptoAmount: finalTrxAmount,
      currency: "TRX",
      paymentType: "trx",
    });

    // Update session immediately after creating invoice
    await setSession(chatId, {
      ...sessionData,
      step: null,
      paymentType: "trx", // Add payment type to session
      paymentId: paymentId, // Add payment ID to session for deletion
    });

    setTimeout(async () => {
      const walletMessage = await bot.editMessageText(
        `✅ فاکتور (<code>${paymentId}</code>) باموفقیت ایجاد شد

📊 قیمت ترون: <code>${trxRate}</code>
🌐 شبکه: TRX ( ترون )
🔗 آدرس ولت:
<code>${trxWallet}</code>

💲 مبلغ تراکنش: <code>${finalTrxAmount.toFixed(2)}</code> TRX

📌 پس از پرداخت مبلغ <code>${amount.toLocaleString()}</code> تومان به موجودیتان اضافه میشود.

- - 
🔄 تایید تراکنش بصورت اتوماتیک حداکثر 5 دقیقه بعد از واریز رمز ارز به مشخصات بالا(آدرس و..)  انجام میگردد.
نحوه خرید TRX: <a href="https://t.me/swift_shield/18">کلیک کنید</a>
`,
        {
          chat_id: chatId,
          message_id: botMessageId,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ کنسل کردن پرداخت و بازگشت",
                  callback_data: "back_to_topup",
                },
              ],
            ],
          },
        }
      );

      // ذخیره message ID در session برای حذف بعدی
      await setSession(chatId, {
        ...sessionData,
        step: null,
        paymentType: "trx",
        paymentId: paymentId,
        walletMessageId: botMessageId, // ذخیره message ID برای حذف بعدی
      });
    }, 1000);
  } catch (error) {
    console.error("Error processing TRX payment:", error);

    await bot.editMessageText(
      `❌ خطا در پردازش پرداخت TRX

${error.message}

🔙 لطفاً دوباره تلاش کنید یا از روش‌های دیگر پرداخت استفاده کنید.`,
      {
        chat_id: chatId,
        message_id: botMessageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔙 بازگشت به روش‌های پرداخت",
                callback_data: "back_to_topup",
              },
            ],
          ],
        },
      }
    );

    await setSession(chatId, { ...sessionData, step: null });
  }
}

// send trx wallet
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
