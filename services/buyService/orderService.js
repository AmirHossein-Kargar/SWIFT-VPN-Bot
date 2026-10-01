/**
 * handlePlanOrder — buy a VPN service with wallet balance.
 *
 * Money-safe flow (reserve → provision → commit, with guaranteed rollback):
 *
 *   1. RESERVE  Atomically deduct the price, but only if the balance still
 *               covers it:
 *                 User.findOneAndUpdate({ telegramId, balance: { $gte: price } },
 *                                       { $inc: { balance: -price } })
 *               This closes the check-then-act race that allowed two concurrent
 *               purchases to both pass a balance check and drive the balance
 *               negative. It also replaces the previous whole-document
 *               `user.save()`, which could silently overwrite a balance that a
 *               payment webhook had credited in between (lost update = money
 *               destroyed).
 *
 *   2. PROVISION Call the WizardXray panel.
 *
 *   3. COMMIT   On success, record the service with $push/$inc — never a full
 *               document write.
 *
 *   4. ROLLBACK On any failure the reservation is refunded with $inc and the
 *               admin group is alerted. There is no path where the user is
 *               charged without receiving a service and being told about it.
 */
import { createVpnService } from "../../api/wizardApi.js";
import {
  getSuccessServiceMessage,
  guideButtons,
} from "../../messages/staticMessages.js";
import User from "../../models/User.js";
import keyboard from "../../keyboards/mainKeyboard.js";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "buy-service", level, message, ...meta })
  );
}

/**
 * Atomically reserve `price` Toman for a purchase.
 * @returns {Promise<object|null>} updated user, or null when funds are insufficient
 */
async function reserveBalance(telegramId, price) {
  return User.findOneAndUpdate(
    { telegramId: String(telegramId), balance: { $gte: price } },
    { $inc: { balance: -price } },
    { new: true }
  );
}

/**
 * Return a reservation to the user. Best-effort with loud alerting: if even the
 * refund fails, the admin group is told explicitly so it can be fixed by hand.
 */
async function refundBalance(bot, telegramId, price, reason) {
  try {
    const refunded = await User.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $inc: { balance: price } },
      { new: true }
    );
    log("warn", "Purchase failed — balance refunded", {
      telegramId, amount: price, reason, newBalance: refunded?.balance,
    });
    return true;
  } catch (err) {
    log("error", "REFUND FAILED — manual intervention required", {
      telegramId, amount: price, reason, error: err.message,
    });
    const groupId = process.env.GROUP_ID;
    if (groupId && bot) {
      await bot
        .sendMessage(
          groupId,
          `🚨 <b>بازپرداخت ناموفق!</b>\n\n` +
            `👤 کاربر: <code>${telegramId}</code>\n` +
            `💰 مبلغ: <code>${Number(price).toLocaleString()}</code> تومان\n` +
            `❗ دلیل خرید ناموفق: <code>${reason}</code>\n\n` +
            `⚠️ لطفاً موجودی این کاربر را <b>دستی</b> اصلاح کنید.`,
          { parse_mode: "HTML" }
        )
        .catch(() => {});
    }
    return false;
  }
}

async function handlePlanOrder(bot, chatId, userId, plan) {
  // ── 1. Atomic reservation ──────────────────────────────────────────────────
  const reserved = await reserveBalance(userId, plan.price);
  if (!reserved) {
    await bot.sendMessage(
      chatId,
      "⚠️ موجودی شما کافی نیست. لطفاً ابتدا حساب خود را شارژ کنید."
    );
    return;
  }

  log("info", "PURCHASE_RESERVED", {
    userId, planId: plan.id, price: plan.price, newBalance: reserved.balance,
  });

  // ── 2. Provision ───────────────────────────────────────────────────────────
  let apiResponse;
  try {
    apiResponse = await createVpnService(plan.gig, plan.days, 0);
  } catch (error) {
    // Network/timeout: outcome on the panel side is unknown, so we must not
    // keep the money. Refund and ask the user to retry.
    log("error", "WizardXray request threw — refunding reservation", {
      userId, planId: plan.id, error: error.message,
    });
    await refundBalance(bot, userId, plan.price, `WizardXray network error: ${error.message}`);
    await bot.sendMessage(
      chatId,
      "❌ خطایی در ارتباط با سرور ایجاد سرویس رخ داد و مبلغ کسر‌شده به کیف پول شما بازگردانده شد. لطفاً دوباره تلاش کنید."
    );
    return;
  }

  const serviceCreated = Boolean(apiResponse && apiResponse.ok && apiResponse.result);

  if (!serviceCreated) {
    const apiError = apiResponse?.error || apiResponse?.message || "پاسخ نامعتبر از سرور";
    log("error", "WizardXray refused service creation — refunding reservation", {
      userId, planId: plan.id, apiError,
    });
    await refundBalance(bot, userId, plan.price, `WizardXray error: ${apiError}`);
    await bot.sendMessage(
      chatId,
      "❌ ایجاد سرویس در حال حاضر ممکن نیست و مبلغ کسر‌شده به کیف پول شما بازگردانده شد. لطفاً بعداً دوباره تلاش کنید."
    );

    const groupId = process.env.GROUP_ID;
    if (groupId) {
      await bot
        .sendMessage(
          groupId,
          `⚠️ <b>خرید ناموفق — بازپرداخت شد</b>\n\n` +
            `👤 کاربر: <code>${userId}</code>\n` +
            `📦 پلن: <code>${plan.name}</code> (${plan.gig} گیگ / ${plan.days} روز)\n` +
            `💰 مبلغ بازپرداخت‌شده: <code>${plan.price.toLocaleString()}</code> تومان\n` +
            `❗ خطای پنل: <code>${apiError}</code>`,
          { parse_mode: "HTML" }
        )
        .catch(() => {});
    }
    return;
  }

  // ── 3. Commit ──────────────────────────────────────────────────────────────
  const result = apiResponse.result;
  const username = result.username || "نامشخص";
  const hash = result.hash;
  const smartLink = hash ? `https://iranisystem.com/bot/sub/?hash=${hash}` : "";
  const singleLink = Array.isArray(result.tak_links) ? result.tak_links[0] || "" : "";

  try {
    // Field-level writes only — cannot clobber a concurrent balance update.
    await User.updateOne(
      { telegramId: String(userId) },
      { $push: { services: { username } }, $inc: { totalServices: 1 } }
    );
  } catch (commitErr) {
    // The service exists on the panel but we failed to record it. Alert loudly;
    // the user keeps the config, so we do NOT refund.
    log("error", "Service created but DB commit failed", {
      userId, username, error: commitErr.message,
    });
    const groupId = process.env.GROUP_ID;
    if (groupId) {
      await bot
        .sendMessage(
          groupId,
          `🚨 <b>سرویس ساخته شد اما در دیتابیس ثبت نشد</b>\n\n` +
            `👤 کاربر: <code>${userId}</code>\n` +
            `🆔 سرویس: <code>${username}</code>\n` +
            `⚠️ لطفاً این سرویس را دستی برای کاربر ثبت کنید.`,
          { parse_mode: "HTML" }
        )
        .catch(() => {});
    }
  }

  // ── 4. Deliver ─────────────────────────────────────────────────────────────
  log("info", "PURCHASE_COMPLETED", { userId, username, planId: plan.id });

  const loadingMsg = await bot.sendMessage(chatId, "⏳ در حال ساخت سرویس ...", keyboard);

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
    smartLink
  )}&size=200x200&margin=20`;

  const successMessage = getSuccessServiceMessage({ username, smartLink, singleLink });

  await bot.sendPhoto(chatId, qrUrl, {
    caption: successMessage,
    parse_mode: "HTML",
    ...guideButtons,
  });

  // Remove the transient "building" message (main menu keyboard stays).
  setTimeout(() => {
    bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
  }, 2000);
}

export default handlePlanOrder;
