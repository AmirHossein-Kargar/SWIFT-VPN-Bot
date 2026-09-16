/**
 * fulfillHooshOrder
 * -----------------
 * Central idempotent fulfillment function.
 * Called by BOTH the webhook handler AND the manual verify flow.
 *
 * Guarantees:
 *  - Balance is credited exactly once per invoice (fulfilled flag).
 *  - Uses a MongoDB findOneAndUpdate with { fulfilled: false } as the filter
 *    so two concurrent calls cannot both credit the balance.
 *  - Sends a Telegram confirmation message to the user.
 *  - On Telegram API failure, balance is still credited (payment already done).
 */
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import User from "../../models/User.js";
import keyboard from "../../keyboards/mainKeyboard.js";

/**
 * @param {object} params
 * @param {import('../../models/HooshPayInvoice.js').default} params.invoice - Mongoose document
 * @param {object}  params.bot     - node-telegram-bot-api instance (may be null in webhook-only mode)
 * @param {number}  [params.chatId] - Telegram chat ID; falls back to invoice.userId
 */
export async function fulfillHooshOrder({ invoice, bot, chatId }) {
  const targetChatId = chatId ?? invoice.userId;

  // ── Idempotency guard ────────────────────────────────────────────────────
  // Atomically flip fulfilled=true only if it is currently false.
  // If two processes race here, only one will get a non-null result.
  const updated = await HooshPayInvoice.findOneAndUpdate(
    { _id: invoice._id, fulfilled: false },
    {
      $set: {
        fulfilled: true,
        fulfilledAt: new Date(),
        status: "paid",
        paidAt: new Date(),
      },
    },
    { new: true }
  );

  if (!updated) {
    // Another process already fulfilled this invoice — do nothing
    console.log(`[HooshPay] Duplicate fulfillment blocked for uid=${invoice.uid}`);
    return;
  }

  // ── Credit user balance ──────────────────────────────────────────────────
  let user;
  try {
    user = await User.findOneAndUpdate(
      { telegramId: String(invoice.userId) },
      { $inc: { balance: invoice.amount, successfulPayments: 1 } },
      { new: true }
    );
  } catch (dbErr) {
    // Critical: balance credit failed. Roll back the fulfilled flag so the
    // next attempt can retry, then re-throw so the caller can log/alert.
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
      $set: { fulfilled: false, fulfilledAt: null, status: "pending", paidAt: null },
    });
    console.error(`[HooshPay] DB error crediting balance for uid=${invoice.uid}:`, dbErr.message);
    throw dbErr;
  }

  if (!user) {
    console.warn(`[HooshPay] User not found for telegramId=${invoice.userId}, uid=${invoice.uid}`);
  }

  const newBalance = user ? user.balance : "نامشخص";
  const formattedAmount = invoice.amount.toLocaleString("en-US");
  const formattedBalance = typeof newBalance === "number"
    ? newBalance.toLocaleString("en-US")
    : newBalance;

  // ── Notify user ──────────────────────────────────────────────────────────
  if (bot) {
    const confirmMsg =
      `✅ <b>پرداخت شما تأیید شد!</b>\n\n` +
      `🧾 <b>شناسه فاکتور:</b> <code>${invoice.uid}</code>\n` +
      `💰 <b>مبلغ پرداختی:</b> <code>${formattedAmount}</code> تومان\n` +
      `💳 <b>موجودی جدید:</b> <code>${formattedBalance}</code> تومان\n\n` +
      `🎉 <b>موجودی کیف پول شما شارژ شد. می‌توانید سرویس خود را خریداری کنید.</b>`;

    try {
      await bot.sendMessage(targetChatId, confirmMsg, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } catch (tgErr) {
      // Non-fatal — user may have blocked the bot. Log and continue.
      console.warn(
        `[HooshPay] Could not send confirmation to chatId=${targetChatId}:`,
        tgErr.message
      );
    }
  }

  console.log(
    `[HooshPay] ✅ Fulfilled: uid=${invoice.uid} orderId=${invoice.orderId} ` +
    `userId=${invoice.userId} amount=${invoice.amount}`
  );
}
