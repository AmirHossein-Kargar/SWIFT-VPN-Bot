import { randomUUID } from "node:crypto";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import User from "../../models/User.js";
import keyboard from "../../keyboards/mainKeyboard.js";
import { creditWalletOnce } from "../walletCredit.js";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay", level, message, ...meta })
  );
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function alertAdmin(bot, message) {
  const groupId = process.env.GROUP_ID;
  if (!groupId || !bot?.sendMessage) return;
  try {
    await bot.sendMessage(groupId, `🚨 <b>HooshPay Alert</b>\n\n${message}`, { parse_mode: "HTML" });
  } catch (error) {
    log("warn", "Admin alert failed", { errorType: error?.name || "TelegramError" });
  }
}

async function notifyUserOnce({ invoice, bot, user }) {
  if (!invoice.notificationPending || !bot?.sendMessage) return false;
  const now = new Date();
  const staleClaim = new Date(now.getTime() - 5 * 60_000);
  const claim = await HooshPayInvoice.findOneAndUpdate(
    {
      _id: invoice._id,
      status: "paid",
      balanceCredited: true,
      notificationPending: true,
      $or: [
        { notificationClaimedAt: null },
        { notificationClaimedAt: { $lt: staleClaim } },
      ],
    },
    { $set: { notificationClaimedAt: now } },
    { new: true }
  );
  if (!claim) return false;

  const amount = Number(invoice.amount).toLocaleString("en-US");
  const balance = user?.balance == null ? null : Number(user.balance).toLocaleString("en-US");
  const trackingLine = invoice.trackingCode
    ? `🔢 <b>کد پیگیری:</b> <code>${html(invoice.trackingCode)}</code>\n`
    : "";
  const balanceLine = balance
    ? `💳 <b>موجودی جدید:</b> <code>${balance}</code> تومان\n\n`
    : "";
  const message =
    `✅ <b>پرداخت شما تأیید شد!</b>\n\n` +
    `🧾 <b>شناسه فاکتور:</b> <code>${html(invoice.uid)}</code>\n` +
    trackingLine +
    `💰 <b>مبلغ شارژ:</b> <code>${amount}</code> تومان\n` +
    balanceLine +
    `🎉 <b>موجودی کیف پول شما شارژ شد.</b>`;

  try {
    await bot.sendMessage(invoice.userId, message, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
    });
    await HooshPayInvoice.findOneAndUpdate(
      { _id: invoice._id, notificationClaimedAt: now, notificationPending: true },
      { $set: { notificationPending: false, notifiedAt: new Date() }, $unset: { notificationClaimedAt: 1 } }
    );
    return true;
  } catch (error) {
    // Keep the claim for five minutes. Telegram timeouts can be ambiguous (it
    // may have accepted a message before the connection failed), so retrying
    // immediately could duplicate a notification.
    log("warn", "Telegram payment notification failed; retry is delayed", {
      uid: invoice.uid,
      errorType: error?.name || "TelegramError",
    });
    return false;
  }
}

/**
 * Idempotent, crash-recoverable HooshPay wallet fulfillment.
 * A durable User.appliedPaymentKeys entry is written atomically with the wallet
 * credit; the invoice completion flag is written afterwards. This closes the
 * old crash window where the invoice was marked credited before User.balance.
 */
export async function fulfillHooshOrder({ invoice, bot, chatId, correlationId, paidAt }) {
  const cid = correlationId || randomUUID();
  if (!invoice?._id || !invoice?.uid) throw new TypeError("A persisted HooshPay invoice is required");
  if (!Number.isSafeInteger(Number(invoice.userId)) || Number(invoice.userId) <= 0) {
    throw new Error("HooshPay invoice has an invalid Telegram user ID");
  }
  if (!Number.isSafeInteger(Number(invoice.amount)) || Number(invoice.amount) <= 0) {
    throw new Error("HooshPay invoice has an invalid amount");
  }

  let current = invoice;
  let newlyClaimed = false;

  if (!invoice.fulfilled) {
    const safePaidAt = paidAt ? new Date(paidAt) : new Date();
    const phaseOne = await HooshPayInvoice.findOneAndUpdate(
      {
        _id: invoice._id,
        fulfilled: false,
        status: { $in: ["pending", "expired", "cancelled", "failed", "paid"] },
      },
      {
        $set: {
          fulfilled: true,
          fulfilledAt: new Date(),
          status: "paid",
          paidAt: Number.isNaN(safePaidAt.getTime()) ? new Date() : safePaidAt,
          creditLedgerVersion: 2,
        },
      },
      { new: true }
    );
    if (phaseOne) {
      newlyClaimed = true;
      current = phaseOne;
      log("info", "PAYMENT_VERIFIED — fulfillment claim acquired", {
        cid, uid: current.uid, userId: current.userId, amount: current.amount,
      });
    } else {
      current = await HooshPayInvoice.findById(invoice._id).lean();
    }
  } else {
    current = await HooshPayInvoice.findById(invoice._id).lean();
  }

  if (!current) throw new Error("HooshPay invoice disappeared during fulfillment");
  if (current.status === "reversed") {
    log("warn", "Reversed invoice cannot be credited", { cid, uid: current.uid });
    return { credited: false, reversed: true };
  }
  if (!current.fulfilled || current.status !== "paid") {
    return { credited: false, notPaid: true };
  }

  // Existing invoices with fulfilled=true but no ledger version were processed
  // by the older pre-ledger code. It could have crashed after incrementing the
  // balance but before reporting success. Do not risk a second credit: send the
  // invoice to manual reconciliation instead of guessing.
  if (!current.balanceCredited && current.creditLedgerVersion !== 2) {
    const alertClaim = await HooshPayInvoice.findOneAndUpdate(
      {
        _id: current._id,
        balanceCredited: false,
        creditLedgerVersion: { $ne: 2 },
        legacyReviewAlertedAt: null,
      },
      { $set: { legacyReviewAlertedAt: new Date() } },
      { new: true }
    );
    if (alertClaim) {
      await alertAdmin(
        bot,
        `⚠️ <b>پرداخت قدیمی نیازمند تطبیق دستی است</b>\n` +
        `UID: <code>${html(current.uid)}</code>\n` +
        `کاربر: <code>${html(current.userId)}</code>\n` +
        `مبلغ: <code>${Number(current.amount).toLocaleString("en-US")}</code> تومان\n` +
        `برای جلوگیری از شارژ تکراری، این فاکتور خودکار تسویه نشد.`
      );
    }
    log("error", "Legacy HooshPay credit requires manual reconciliation", {
      cid, uid: current.uid,
    });
    return { credited: false, manualReviewRequired: true };
  }

  let walletResult = null;
  if (!current.balanceCredited) {
    try {
      walletResult = await creditWalletOnce({
        telegramId: current.userId,
        amount: Number(current.amount),
        creditKey: `hooshpay:${current.uid}`,
      });
    } catch (error) {
      log("error", "Atomic wallet credit failed", {
        cid, uid: current.uid, errorType: error?.name || "DatabaseError",
        code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
      });
      await alertAdmin(
        bot,
        `❌ <b>شارژ کیف پول ناموفق</b>\n` +
        `UID: <code>${html(current.uid)}</code>\n` +
        `کاربر: <code>${html(current.userId)}</code>\n` +
        `لطفاً اتصال دیتابیس و کاربر را بررسی کنید.`
      );
      throw error;
    }

    if (!walletResult.user) {
      log("error", "Wallet owner not found; payment remains recoverable", {
        cid, uid: current.uid, userId: current.userId,
      });
      await alertAdmin(
        bot,
        `⚠️ <b>کاربر پرداخت HooshPay یافت نشد</b>\n` +
        `UID: <code>${html(current.uid)}</code>\n` +
        `کاربر: <code>${html(current.userId)}</code>\n` +
        `مبلغ: <code>${Number(current.amount).toLocaleString("en-US")}</code> تومان`
      );
      throw new Error("HooshPay invoice owner is missing; credit remains pending");
    }

    const finalized = await HooshPayInvoice.findOneAndUpdate(
      { _id: current._id, status: "paid", balanceCredited: false, creditLedgerVersion: 2 },
      {
        $set: {
          balanceCredited: true,
          balanceCreditedAt: new Date(),
          notificationPending: true,
        },
      },
      { new: true }
    );
    if (finalized) {
      current = finalized.toObject ? finalized.toObject() : finalized;
    } else {
      current = await HooshPayInvoice.findById(current._id).lean();
      if (!current?.balanceCredited) {
        throw new Error("Wallet credit is durable but invoice completion could not be recorded");
      }
    }

    log("info", "PAYMENT_CREDITED — atomic wallet ledger committed", {
      cid,
      uid: current.uid,
      userId: current.userId,
      amount: current.amount,
      newlyCredited: walletResult.credited,
      recovered: !newlyClaimed || walletResult.alreadyCredited,
    });
  } else {
    walletResult = {
      user: await User.findOne({ telegramId: String(current.userId) }).select("balance").lean(),
      credited: false,
      alreadyCredited: true,
    };
  }

  let notified = Boolean(current.notifiedAt);
  if (current.notificationPending) {
    notified = await notifyUserOnce({ invoice: current, bot, user: walletResult?.user }) || notified;
  }

  return {
    credited: Boolean(walletResult?.credited),
    alreadyCredited: Boolean(walletResult?.alreadyCredited),
    notified,
  };
}
