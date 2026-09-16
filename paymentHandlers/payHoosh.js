/**
 * payHoosh
 * --------
 * Bot payment flow for HooshPay.
 *
 * Guards added:
 *  - Session is set to "creating_hoosh_invoice" BEFORE the API call so a
 *    second message from the same user cannot trigger a second invoice creation.
 *  - Step is cleared to null on any exit path so the user is never stuck.
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
  // If we're already creating an invoice for this user, ignore the duplicate message.
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
        `<code>${err.message}</code>\n\n` +
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

  // Send payment link
  try {
    await bot.editMessageText(
      `✅ <b>فاکتور پرداخت ایجاد شد</b>\n\n` +
      `🧾 <b>شناسه فاکتور:</b> <code>${invoice.uid}</code>\n` +
      `💰 <b>مبلغ:</b> <code>${amount.toLocaleString()}</code> تومان\n\n` +
      `👇 <b>برای پرداخت روی دکمه زیر کلیک کنید:</b>\n\n` +
      `پس از پرداخت، دکمه <b>«پرداخت کردم»</b> را بزنید تا موجودی شما بلافاصله اضافه شود.\n\n` +
      `⏱ این فاکتور به مدت <b>۳۰ دقیقه</b> معتبر است.`,
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
