/**
 * payHoosh
 * --------
 * Bot payment flow for HooshPay card-to-card.
 *
 * Flow:
 *   1. User selects "پرداخت آنلاین (HooshPay)"
 *   2. User enters amount (validated: 10,000–50,000,000 Toman with commas)
 *   3. Invoice created via HooshPay API → stored in MongoDB
 *   4. User sees: amount, fee, payable_amount, card info, payment link
 *   5. User pays → presses "پرداخت کردم" → verifyHooshPayment
 *
 * Guards:
 *   - Session set to "creating_hoosh_invoice" BEFORE the API call so a
 *     second message from the same user cannot trigger a second invoice.
 *   - Step cleared on any exit path so the user is never stuck.
 */
import { getSession, setSession } from "../config/sessionStore.js";
import validateWithCommas from "../utils/validationAmount.js";
import { createHooshInvoice } from "../services/hooshpay/createHooshInvoice.js";

// ─── Step 1: Show amount-input prompt ──────────────────────────────────────

export async function payHoosh(bot, query, session) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;

  try {
    await bot.editMessageText(
      `💳 <b>پرداخت آنلاین – HooshPay</b>\n\n` +
      `🔹 <b>لطفاً مبلغ مورد نظر را به تومان و با کاما وارد کنید.</b>\n` +
      `مثال: <code>50,000</code> | <code>200,000</code>\n\n` +
      `🔻 <b>محدودیت مبلغ:</b>\n` +
      `▫️ حداقل: <code>10,000 تومان</code>\n` +
      `▫️ حداکثر: <code>50,000,000 تومان</code>\n\n` +
      `ℹ️ <b>کارمزد درگاه:</b> ۲۰٪ (روی مبلغ پرداختی شما اعمال می‌شود)\n\n` +
      `✍️ <i>برای ادامه، مبلغ را به صورت صحیح ارسال کنید.</i>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("[payHoosh] editMessageText error:", err.message);
  }

  await setSession(chatId, {
    ...session,
    step: "waiting_for_hoosh_amount",
    messageId,
    paymentType: "hoosh",
  });
}

// ─── Step 2: Process amount, create invoice, send payment link ─────────────

export async function handleHooshAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const messageId = session?.messageId;

  // Delete the user's typed message to keep the chat clean
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  const backButton = [
    [{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }],
  ];

  // ── Guard: block re-entrant invoice creation ──────────────────────────────
  if (session?.step === "creating_hoosh_invoice") {
    try {
      await bot.editMessageText(
        "⏳ <b>فاکتور در حال ایجاد است...</b>\n\nلطفاً چند لحظه صبر کنید.",
        { chat_id: chatId, message_id: messageId, parse_mode: "HTML" }
      );
    } catch (_) {}
    return;
  }

  // Validate amount
  const validation = validateWithCommas(text, 10000, 50000000);
  if (!validation.valid) {
    try {
      await bot.editMessageText(validation.message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: backButton },
      });
    } catch (e) {
      if (!e?.response?.body?.description?.includes("message is not modified")) {
        console.error("[handleHooshAmount] editMessageText error:", e.message);
      }
    }
    return;
  }

  const amount = validation.amount;

  // ── Lock session against concurrent messages ──────────────────────────────
  await setSession(chatId, {
    ...session,
    step: "creating_hoosh_invoice",
    messageId,
    paymentType: "hoosh",
  });

  // Show creating feedback
  try {
    await bot.editMessageText(
      `⏳ <b>در حال ایجاد فاکتور پرداخت...</b>\n\nلطفاً چند لحظه صبر کنید.`,
      { chat_id: chatId, message_id: messageId, parse_mode: "HTML" }
    );
  } catch (_) {}

  // Create invoice
  let invoice;
  try {
    invoice = await createHooshInvoice({
      userId: chatId,
      amount,
      description: `VPN wallet top-up — ${amount.toLocaleString()} Toman`,
    });
  } catch (err) {
    console.error("[handleHooshAmount] createHooshInvoice error:", err.message);
    try {
      await bot.editMessageText(
        `❌ <b>خطا در ایجاد فاکتور پرداخت</b>\n\n` +
        `لطفاً دوباره تلاش کنید یا از روش دیگری استفاده کنید.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: backButton },
        }
      );
    } catch (_) {}
    // Unlock session so user can try again
    await setSession(chatId, { ...session, step: "waiting_for_hoosh_amount", messageId });
    return;
  }

  // Save invoice UID in session
  await setSession(chatId, {
    ...session,
    step: "waiting_for_hoosh_confirm",
    paymentType: "hoosh",
    paymentId: invoice.uid,
    hooshOrderId: invoice.orderId,
    rawAmount: text,
    messageId,
  });

  // ── Build payment info message with fee transparency ──────────────────────
  const fmtAmount = amount.toLocaleString("en-US");
  const fmtPayable = invoice.payableAmount
    ? Number(invoice.payableAmount).toLocaleString("en-US")
    : fmtAmount;
  const fmtFee = invoice.feeAmount
    ? Number(invoice.feeAmount).toLocaleString("en-US")
    : null;
  const fmtMerchant = invoice.merchantCredit
    ? Number(invoice.merchantCredit).toLocaleString("en-US")
    : fmtAmount;

  let cardInfo = "";
  if (invoice.cardNumber) {
    cardInfo =
      `\n💳 <b>شماره کارت مقصد:</b> <code>${invoice.cardNumber}</code>\n`;
    if (invoice.cardHolder) {
      cardInfo += `👤 <b>نام دارنده:</b> ${invoice.cardHolder}\n`;
    }
    if (invoice.cardBank) {
      cardInfo += `🏦 <b>بانک:</b> ${invoice.cardBank}\n`;
    }
    cardInfo += `\n⚠️ <i>مبلغ دقیق <code>${fmtPayable}</code> تومان را به کارت بالا واریز کنید.</i>\n\n`;
  }

  const feeLine = fmtFee
    ? `💸 <b>کارمزد درگاه:</b> <code>${fmtFee}</code> تومان (${invoice.feePercent ?? 20}%)\n` +
      `💰 <b>مبلغ قابل پرداخت:</b> <code>${fmtPayable}</code> تومان\n` +
      `💳 <b>شارژ کیف پول:</b> <code>${fmtMerchant}</code> تومان\n`
    : `💰 <b>مبلغ قابل پرداخت:</b> <code>${fmtPayable}</code> تومان\n`;

  const expiryLine = invoice.expiresAt
    ? `⏱ <b>مهلت پرداخت:</b> <code>${new Date(invoice.expiresAt).toLocaleString("fa-IR")}</code>\n`
    : `⏱ این فاکتور به مدت <b>۳۰ دقیقه</b> معتبر است.\n`;

  try {
    await bot.editMessageText(
      `✅ <b>فاکتور پرداخت ایجاد شد</b>\n\n` +
      `🧾 <b>شناسه فاکتور:</b> <code>${invoice.uid}</code>\n` +
      `💰 <b>مبلغ درخواستی:</b> <code>${fmtAmount}</code> تومان\n` +
      feeLine +
      cardInfo +
      `\n👇 <b>برای پرداخت روی دکمه زیر کلیک کنید:</b>\n` +
      expiryLine +
      `\nپس از پرداخت، دکمه <b>«پرداخت کردم»</b> را بزنید تا موجودی شما بلافاصله اضافه شود.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 پرداخت اکنون", url: invoice.paymentUrl }],
            [{ text: "✅ پرداخت کردم", callback_data: `hoosh_verify:${invoice.uid}` }],
            [{ text: "❌ انصراف و بازگشت", callback_data: "back_to_topup" }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("[handleHooshAmount] send payment link error:", err.message);
  }
}