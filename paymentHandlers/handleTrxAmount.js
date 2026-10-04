import { randomInt, randomUUID } from "node:crypto";
import validationAmountTrx from "../utils/validationAmountTrx.js";
import { getSession, setSession } from "../config/sessionStore.js";
import { USDPrice } from "../api/USDPrice.js";
import { TRXPrice } from "../api/TRXPrice.js";
import CryptoInvoice from "../models/CryptoInvoice.js";

export default async function handleTrxAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  const text = typeof msg?.text === "string" ? msg.text.trim() : "";

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
    console.error("TRX quote unavailable:", error?.name || "RateProviderError");
    await bot.editMessageText(
      `❌ در حال حاضر دریافت نرخ لحظه‌ای TRX ممکن نیست.\n\n🔙 لطفاً چند دقیقه دیگر دوباره تلاش کنید یا از روش دیگری استفاده کنید.`,
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
  if (!Number.isFinite(usdRate) || usdRate <= 0 || !Number.isFinite(trxRate) || trxRate <= 0) {
    await bot.editMessageText("❌ نرخ دریافتی معتبر نیست؛ فاکتور ساخته نشد. لطفاً بعداً دوباره تلاش کنید.", {
      chat_id: chatId,
      message_id: botMessageId,
      reply_markup: { inline_keyboard: [[{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }]] },
    });
    await setSession(chatId, { ...sessionData, step: null });
    return;
  }

  const usdAmount = amount / usdRate;
  const baseMicroTrx = Math.ceil((usdAmount / trxRate) * 1_000_000);
  // A tiny per-invoice fractional amount helps distinguish same-price invoices.
  // The bot displays all six TRX decimals so the customer can copy the exact quote.
  const finalTrxAmount = (baseMicroTrx + randomInt(1, 51)) / 1_000_000;
  const paymentId = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();

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
      creditLedgerVersion: 2,
    });

    // Update session immediately after creating invoice
    await setSession(chatId, {
      ...sessionData,
      step: null,
      paymentType: "trx", // Add payment type to session
      paymentId: paymentId, // Add payment ID to session for deletion
    });

    setTimeout(() => {
      void (async () => {
        try {
          await bot.editMessageText(
        `✅ فاکتور (<code>${paymentId}</code>) باموفقیت ایجاد شد

📊 قیمت ترون: <code>${trxRate}</code>
🌐 شبکه: TRX ( ترون )
🔗 آدرس ولت:
<code>${trxWallet}</code>

💲 مبلغ تراکنش: <code>${finalTrxAmount.toFixed(6)}</code> TRX

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
        walletMessageId: botMessageId,
      });
        } catch (error) {
          console.error("TRX invoice message delivery failed:", error?.name || "TelegramError");
        }
      })();
    }, 1000);
  } catch (error) {
    console.error("TRX invoice persistence failed:", error?.name || "DatabaseError");

    await bot.editMessageText(
      `❌ در حال حاضر امکان ثبت فاکتور TRX وجود ندارد.\n\n🔙 لطفاً دوباره تلاش کنید یا از روش دیگری استفاده کنید.`,
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
