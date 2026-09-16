/**
 * fulfillHooshOrder
 * -----------------
 * Central idempotent fulfillment — two-phase write with crash recovery.
 *
 * Phase 1 — Acquire the fulfillment lock (atomic single-document write):
 *   findOneAndUpdate({ _id, fulfilled: false }) → flip fulfilled=true
 *   MongoDB guarantees only one concurrent caller wins this write.
 *
 * Phase 2 — Credit the user's balance (idempotent):
 *   Uses findOneAndUpdate({ _id, balanceCredited: false }) as a second
 *   atomic guard so concurrent recovery workers cannot double-credit.
 *   After User.balance is incremented, sets balanceCredited=true.
 *
 * Recovery path (crash between Phase 1 and Phase 2):
 *   The recovery cron finds { fulfilled:true, balanceCredited:false }
 *   and calls fulfillHooshOrder again. Phase 1 returns null (already locked),
 *   then the code detects the crash-recovery case and jumps to Phase 2.
 *
 * Called by:
 *   - POST /api/hooshpay/webhook
 *   - verifyHooshPayment() (manual fallback)
 *   - admin_hoosh_run_pending
 *   - hooshpayRecoveryCron
 */
import { randomUUID } from "crypto";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import User from "../../models/User.js";
import keyboard from "../../keyboards/mainKeyboard.js";

// ── Structured logger ────────────────────────────────────────────────────────
function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "hooshpay",
      level,
      message,
      ...meta,
    })
  );
}

// ── Admin alert (best-effort Telegram message to GROUP_ID) ───────────────────
async function _alertAdmin(bot, message) {
  const groupId = process.env.GROUP_ID;
  if (!groupId || !bot) return;
  try {
    await bot.sendMessage(groupId, `🚨 <b>HooshPay Alert</b>\n\n${message}`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    log("warn", "Admin alert failed", { error: err.message });
  }
}

/**
 * @param {object}  params.invoice  - Mongoose doc or plain object with _id, uid, userId, amount
 * @param {object}  [params.bot]    - node-telegram-bot-api instance (null-safe)
 * @param {number}  [params.chatId] - Falls back to invoice.userId
 * @param {string}  [params.correlationId] - Trace ID for logs
 */
export async function fulfillHooshOrder({ invoice, bot, chatId, correlationId }) {
  const cid = correlationId ?? randomUUID();
  const targetChatId = chatId ?? invoice.userId;

  // ── Phase 1: Acquire the fulfillment lock ──────────────────────────────────
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
    // Phase 1 already ran. Check if Phase 2 still needs to run (crash recovery).
    const current = await HooshPayInvoice.findById(invoice._id).lean();
    if (current?.fulfilled && !current?.balanceCredited && current?.status === "paid") {
      log("warn", "Crash recovery: Phase-1 done but Phase-2 missing — re-running credit", {
        cid, uid: current.uid,
      });
      return _creditBalance({ invoice: current, bot, targetChatId, cid });
    }
    // Already fully completed — genuine duplicate call.
    log("info", "Duplicate fulfillment blocked", { cid, uid: invoice.uid ?? invoice._id });
    return;
  }

  log("info", "Phase-1 lock acquired", { cid, uid: locked.uid, userId: locked.userId, amount: locked.amount });
  return _creditBalance({ invoice: locked, bot, targetChatId, cid });
}

/**
 * Phase 2: credit balance atomically and mark balanceCredited.
 * Uses a second findOneAndUpdate to prevent concurrent recovery workers
 * from crediting the same invoice twice.
 */
async function _creditBalance({ invoice, bot, targetChatId, cid }) {
  // ── Atomic Phase-2 guard ───────────────────────────────────────────────────
  // This is the safety net for concurrent recovery workers (PM2 cluster, etc.).
  // Only the first worker to execute this write will proceed.
  const phase2Lock = await HooshPayInvoice.findOneAndUpdate(
    { _id: invoice._id, fulfilled: true, balanceCredited: false },
    { $set: { balanceCredited: true, balanceCreditedAt: new Date() } },
    { new: true }
  );

  if (!phase2Lock) {
    // Another worker already completed Phase 2, or it was pre-flagged.
    log("info", "Phase-2 already completed by another worker", { cid, uid: invoice.uid });
    return;
  }

  // ── Credit user balance ────────────────────────────────────────────────────
  let user;
  try {
    user = await User.findOneAndUpdate(
      { telegramId: String(invoice.userId) },
      { $inc: { balance: invoice.amount, successfulPayments: 1 } },
      { new: true }
    );
  } catch (dbErr) {
    // Phase-2 flag is already set — roll it back so the cron can retry.
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
      $set: { balanceCredited: false, balanceCreditedAt: null },
    });
    log("error", "DB error crediting balance — Phase-2 flag rolled back", {
      cid, uid: invoice.uid, error: dbErr.message,
    });
    await _alertAdmin(
      bot,
      `❌ <b>Balance credit FAILED</b>\n` +
      `UID: <code>${invoice.uid}</code>\n` +
      `کاربر: <code>${invoice.userId}</code>\n` +
      `مبلغ: <code>${invoice.amount.toLocaleString()}</code> تومان\n` +
      `خطا: <code>${dbErr.message}</code>\n` +
      `لطفاً دستی بررسی کنید.`
    );
    throw dbErr;
  }

  if (!user) {
    log("warn", "User not found — balance credit skipped", {
      cid, uid: invoice.uid, userId: invoice.userId,
    });
    await _alertAdmin(
      bot,
      `⚠️ <b>کاربر یافت نشد — موجودی اضافه نشد</b>\n` +
      `UID: <code>${invoice.uid}</code>\n` +
      `کاربر: <code>${invoice.userId}</code>\n` +
      `مبلغ: <code>${invoice.amount.toLocaleString()}</code> تومان`
    );
  }

  const newBalance = user?.balance ?? null;
  const fmtAmount = Number(invoice.amount).toLocaleString("en-US");
  const fmtBalance = newBalance !== null ? newBalance.toLocaleString("en-US") : "نامشخص";

  log("info", "Phase-2 complete: balance credited", {
    cid, uid: invoice.uid, userId: invoice.userId,
    amount: invoice.amount, newBalance,
  });

  // ── Notify user ────────────────────────────────────────────────────────────
  if (bot) {
    const msg =
      `✅ <b>پرداخت شما تأیید شد!</b>\n\n` +
      `🧾 <b>شناسه فاکتور:</b> <code>${invoice.uid}</code>\n` +
      `💰 <b>مبلغ پرداختی:</b> <code>${fmtAmount}</code> تومان\n` +
      `💳 <b>موجودی جدید:</b> <code>${fmtBalance}</code> تومان\n\n` +
      `🎉 <b>موجودی کیف پول شارژ شد. می‌توانید سرویس خود را خریداری کنید.</b>`;

    try {
      await bot.sendMessage(targetChatId, msg, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } catch (tgErr) {
      log("warn", "Telegram confirmation failed — non-fatal", {
        cid, uid: invoice.uid, chatId: targetChatId, error: tgErr.message,
      });
    }
  }
}
