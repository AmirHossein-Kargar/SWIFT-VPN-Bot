/**
 * fulfillHooshOrder
 * -----------------
 * Central idempotent fulfillment — two-phase write with crash recovery.
 *
 * Phase 1 — Acquire the fulfillment lock atomically:
 *   findOneAndUpdate({ _id, fulfilled: false }) → flip fulfilled=true
 *   If result is null, another process already owns this invoice — bail out.
 *
 * Phase 2 — Credit the user's balance:
 *   After User.findOneAndUpdate succeeds, set balanceCredited=true.
 *   If the process crashes between Phase 1 and Phase 2, the recovery cron
 *   (services/hooshpay/hooshpayRecoveryCron.js) will re-run Phase 2 for
 *   any invoice where fulfilled=true && balanceCredited=false.
 *
 * Called by:
 *   - POST /api/hooshpay/webhook  (primary)
 *   - verifyHooshPayment()        (manual fallback)
 *   - admin_hoosh_run_pending     (admin recovery)
 *   - hooshpayRecoveryCron        (automatic recovery)
 */
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import User from "../../models/User.js";
import keyboard from "../../keyboards/mainKeyboard.js";

/**
 * @param {object} params
 * @param {object}  params.invoice  - Mongoose document or plain object with _id, uid, userId, amount
 * @param {object}  [params.bot]    - node-telegram-bot-api instance (null-safe)
 * @param {number}  [params.chatId] - Override Telegram chat ID; falls back to invoice.userId
 */
export async function fulfillHooshOrder({ invoice, bot, chatId }) {
  const targetChatId = chatId ?? invoice.userId;

  // ── Phase 1: Acquire the lock ─────────────────────────────────────────────
  // Only one concurrent caller can win this write. The filter includes
  // fulfilled:false so any second caller gets null back and exits.
  const locked = await HooshPayInvoice.findOneAndUpdate(
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

  if (!locked) {
    // Either already fulfilled, or a concurrent call owns the lock.
    // Check if balanceCredited also needs completing (crash recovery path).
    const current = await HooshPayInvoice.findById(invoice._id).lean();
    if (current?.fulfilled && !current?.balanceCredited) {
      // Phase 1 was done before crash but Phase 2 was not — continue below
      // using `current` as the invoice reference.
      return _creditBalance({ invoice: current, bot, targetChatId });
    }
    console.log(`[HooshPay] Duplicate fulfillment blocked for uid=${invoice.uid ?? invoice._id}`);
    return;
  }

  // ── Phase 2: Credit the balance ───────────────────────────────────────────
  return _creditBalance({ invoice: locked, bot, targetChatId });
}

/**
 * Internal: credit balance + mark balanceCredited + notify user.
 * Safe to call multiple times — User.$inc is idempotent once balanceCredited=true.
 */
async function _creditBalance({ invoice, bot, targetChatId }) {
  // Guard: don't double-credit if already marked
  if (invoice.balanceCredited) {
    console.log(`[HooshPay] Balance already credited for uid=${invoice.uid}, skipping.`);
    return;
  }

  let user;
  try {
    user = await User.findOneAndUpdate(
      { telegramId: String(invoice.userId) },
      { $inc: { balance: invoice.amount, successfulPayments: 1 } },
      { new: true }
    );
  } catch (dbErr) {
    // Do NOT roll back fulfilled — it stays true so the recovery cron can
    // retry just the balance credit step (balanceCredited remains false).
    console.error(
      `[HooshPay] DB error crediting balance for uid=${invoice.uid}:`,
      dbErr.message
    );
    throw dbErr;
  }

  if (!user) {
    console.warn(
      `[HooshPay] User not found for telegramId=${invoice.userId}, uid=${invoice.uid}. ` +
      `Balance credit skipped — user may have been deleted.`
    );
  }

  // Mark Phase 2 complete — now safe to consider the invoice fully settled
  await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
    $set: { balanceCredited: true, balanceCreditedAt: new Date() },
  });

  // ── Notify user ───────────────────────────────────────────────────────────
  const newBalance = user?.balance ?? null;
  const formattedAmount = Number(invoice.amount).toLocaleString("en-US");
  const formattedBalance = newBalance !== null ? newBalance.toLocaleString("en-US") : "نامشخص";

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
      // Non-fatal — user may have blocked the bot.
      console.warn(
        `[HooshPay] Could not send confirmation to chatId=${targetChatId}:`,
        tgErr.message
      );
    }
  }

  console.log(
    `[HooshPay] ✅ Fulfilled+Credited: uid=${invoice.uid} ` +
    `userId=${invoice.userId} amount=${invoice.amount}`
  );
}
