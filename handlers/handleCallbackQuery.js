import handleTrxWalletScan from "./admin/handleTrxWalletScan.js";
import showTrxBalance from "./admin/showTrxBalance.js";
import showTrxStats from "./admin/showTrxStats.js";
import showTrxRecent from "./admin/showTrxRecent.js";
import showTrxScanStatus from "./admin/showTrxScanStatus.js";
import detailedFinancialReport from "./admin/detailedFinancialReport.js";
import bankReport from "./admin/bankReport.js";
import usersReport from "./admin/usersReport.js";
import monthlyReport from "./admin/monthlyReport.js";
import profitChart from "./admin/profitChart.js";
import cryptoReport from "./admin/cryptoReport.js";
import hooshpayReport from "./admin/hooshpayReport.js";
import {
  apiServicePurchase,
  createApiService,
  cancelApiPurchase,
} from "./admin/apiServicePurchase.js";
import showPaymentMethods from "./message/showPaymentMethods.js";
import {
  clearSession,
  getSession,
  setSession,
} from "../config/sessionStore.js";
import keyboard from "../keyboards/mainKeyboard.js";
import { CHOOSE_OPTION_MESSAGE } from "../messages/staticMessages.js";
import promptForReceipt from "../paymentHandlers/promptForReceipt.js";
import { plans30, plans60, plans90 } from "../services/plans.js";
import handleBuyService from "../services/buyService/buyService.js";
import generatePlanButtons from "../keyboards/generatePlanButtons.js";
import confirmOrder from "../services/buyService/confirmOrder.js";
import orderService from "../services/buyService/orderService.js";
import User from "../models/User.js";
import invoice from "../models/invoice.js";
import CryptoInvoice from "../models/CryptoInvoice.js";
import HooshPayInvoice from "../models/HooshPayInvoice.js";
import showServiceDetails from "../services/manageServices/showServiceDetails.js";
import changeServiceLink from "../services/manageServices/changeServiceLink.js";
import generateQRCode from "../services/manageServices/generateQRCode.js";
import { deleteService, StatusApi } from "../api/wizardApi.js";
import deactivateServiceButton from "../services/manageServices/deactiveServiceButton.js";
import handleProfile from "./message/handleProfile.js";
import payTrx from "../paymentHandlers/payTrx.js";
import { sendTrxWallet } from "../paymentHandlers/handleTrxAmount.js";
import { payHoosh } from "../paymentHandlers/payHoosh.js";
import { verifyHooshPayment } from "../services/hooshpay/verifyHooshPayment.js";
import { confirmBankPayment } from "../services/payments/confirmBankPayment.js";
import { isAdmin } from "../utils/auth.js";

// ─── Authorization helpers ─────────────────────────────────────────────────
// isAdmin comes from utils/auth.js (fail-CLOSED: no ADMINS => no admins).
// Imported rather than re-implemented so the policy cannot drift per handler.

async function denyAdmin(bot, queryId) {
  await bot.answerCallbackQuery(queryId, {
    text: "⛔️ دسترسی غیرمجاز",
    show_alert: true,
  });
}

/**
 * Ownership guard for user-facing service callbacks.
 *
 * callback_data can reach a user who is not its originator (a message carrying
 * an inline keyboard can be forwarded, and the forwarded buttons still fire),
 * so "the button exists" is not proof of ownership — the server must verify
 * that the requested service actually belongs to the caller.
 */
async function userOwnsService(userId, username) {
  if (!username) return false;
  const owner = await User.findOne({
    telegramId: String(userId),
    "services.username": username,
  }).lean();
  return Boolean(owner);
}

async function denyOwnership(bot, queryId) {
  await bot.answerCallbackQuery(queryId, {
    text: "⛔️ این سرویس متعلق به حساب شما نیست",
    show_alert: true,
  });
}

// ─── Admin panel inline keyboard (single source of truth) ─────────────────
const ADMIN_PANEL_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🔍 اسکن ولت TRX", callback_data: "admin_scan_trx_wallet" },
      { text: "📊 وضعیت سیستم", callback_data: "admin_status" },
    ],
    [
      { text: "💰 گزارش مالی", callback_data: "admin_financial_report" },
      { text: "🏦 گزارش HooshPay", callback_data: "admin_hooshpay_report" },
    ],
    [
      { text: "🛒 خرید از API", callback_data: "admin_api_service_purchase" },
      { text: "📨 ارسال پیام به کاربر", callback_data: "admin_send_message_to_user" },
    ],
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
const handleCallbackQuery = async (bot, query) => {
  const data = query?.data;
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = query?.message?.message_id;
  const userId = query?.from?.id;

  // Defensive: callbacks can arrive with no data (malformed client) or from a
  // message the bot can no longer address (deleted / too old / inline mode).
  if (!data || !chatId) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }
    return;
  }
  if (messageId == null) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: "⚠️ این دکمه دیگر معتبر نیست. لطفاً از منوی اصلی دوباره اقدام کنید.",
        show_alert: true,
      });
    } catch { /* ignore */ }
    return;
  }

  const session = await getSession(chatId);

  // ── hoosh_verify:<uid> — manual "I've Paid" verification ─────────────────
  if (data.startsWith("hoosh_verify:")) {
    const uid = data.split("hoosh_verify:")[1];
    if (!uid) return;

    // Ownership guard: an invoice may only be verified by the user it belongs to.
    // (Kept as a scoped lookup so an unknown uid falls through to the normal
    // "not found" path rather than being answered twice.)
    const ownedInvoice = await HooshPayInvoice.findOne({ uid }).select("userId").lean();
    if (ownedInvoice && String(ownedInvoice.userId) !== String(userId)) {
      await denyOwnership(bot, query.id);
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: "⏳ در حال بررسی پرداخت..." });

    try {
      await bot.editMessageText(
        "⏳ <b>در حال بررسی وضعیت پرداخت...</b>\n\nلطفاً چند لحظه صبر کنید.",
        { chat_id: chatId, message_id: messageId, parse_mode: "HTML" }
      );
    } catch (_) { /* ignore "message is not modified" */ }

    const result = await verifyHooshPayment(uid, bot, chatId);

    if (result.success) {
      // fulfillHooshOrder already sent the confirmation message + keyboard.
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      await clearSession(chatId);
      return;
    }

    if (result.alreadyFulfilled) {
      await bot.editMessageText(
        "✅ <b>این پرداخت قبلاً تأیید شده است.</b>\n\nموجودی شما قبلاً اضافه شده است.",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت", callback_data: "back_to_home" }]] },
        }
      );
      return;
    }

    // ── NEW: duplicate click / in-flight lock ──────────────────────────────
    if (result.locked) {
      // Another verify call is already in-flight — silently ignore this duplicate
      try {
        await bot.editMessageText(
          "⏳ <b>بررسی پرداخت در حال انجام است...</b>\n\nلطفاً چند لحظه صبر کنید.",
          { chat_id: chatId, message_id: messageId, parse_mode: "HTML" }
        );
      } catch (_) {}
      return;
    }

    // ── NEW: expired invoice ───────────────────────────────────────────────
    if (result.expired) {
      await bot.editMessageText(
        "⏰ <b>مهلت این فاکتور به پایان رسیده است.</b>\n\n" +
        "لطفاً یک فاکتور جدید ایجاد کنید.",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 ایجاد فاکتور جدید", callback_data: "pay_hoosh" }],
              [{ text: "🏠 بازگشت به خانه", callback_data: "back_to_home" }],
            ],
          },
        }
      );
      await clearSession(chatId);
      return;
    }

    // ── NEW: cancelled invoice ────────────────────────────────────────────
    if (result.cancelled) {
      await bot.editMessageText(
        "❌ <b>این فاکتور لغو شده است.</b>\n\n" +
        "لطفاً یک فاکتور جدید ایجاد کنید.",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 ایجاد فاکتور جدید", callback_data: "pay_hoosh" }],
              [{ text: "🏠 بازگشت به خانه", callback_data: "back_to_home" }],
            ],
          },
        }
      );
      await clearSession(chatId);
      return;
    }

    if (result.notPaid) {
      const inv = await HooshPayInvoice.findOne({ uid });
      const paymentUrl = inv?.paymentUrl;
      await bot.editMessageText(
        "⏳ <b>پرداخت هنوز تأیید نشده است.</b>\n\n" +
        "لطفاً پس از انجام پرداخت دوباره تلاش کنید.\n\n" +
        "اگر پرداخت را انجام داده‌اید، چند دقیقه صبر کرده و دوباره دکمه «پرداخت کردم» را بزنید.",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              ...(paymentUrl ? [[{ text: "💳 پرداخت اکنون", url: paymentUrl }]] : []),
              [{ text: "✅ پرداخت کردم", callback_data: `hoosh_verify:${uid}` }],
              [{ text: "❌ انصراف و بازگشت", callback_data: "back_to_topup" }],
            ],
          },
        }
      );
      return;
    }

    // Unexpected error
    await bot.editMessageText(
      `❌ <b>خطا در بررسی پرداخت</b>\n\n<code>${result.error || "خطای نامشخص"}</code>\n\nلطفاً دوباره تلاش کنید.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 تلاش مجدد", callback_data: `hoosh_verify:${uid}` }],
            [{ text: "❌ انصراف", callback_data: "back_to_topup" }],
          ],
        },
      }
    );
    return;
  }

  // ── Admin: invoice search by uid or order_id ──────────────────────────────
  if (data.startsWith("admin_hoosh_search:")) {
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }
    const term = data.split("admin_hoosh_search:")[1];
    const inv = await HooshPayInvoice.findOne({
      $or: [{ uid: term }, { orderId: term }],
    });
    if (!inv) {
      await bot.answerCallbackQuery(query.id, { text: "❌ فاکتور یافت نشد", show_alert: true });
      return;
    }
    await bot.sendMessage(
      chatId,
      `🔍 <b>جزئیات فاکتور HooshPay</b>\n\n` +
      `🆔 UID: <code>${inv.uid}</code>\n` +
      `📦 Order ID: <code>${inv.orderId}</code>\n` +
      `👤 User ID: <code>${inv.userId}</code>\n` +
      `💰 مبلغ: <code>${inv.amount.toLocaleString()}</code> تومان\n` +
      `📌 وضعیت: <code>${inv.status}</code>\n` +
      `✅ تسویه: <code>${inv.fulfilled ? "بله" : "خیر"}</code>\n` +
      `📅 ایجاد: <code>${inv.createdAt.toLocaleString("fa-IR")}</code>\n` +
      `${inv.paidAt ? `💳 پرداخت: <code>${inv.paidAt.toLocaleString("fa-IR")}</code>\n` : ""}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 ارسال مجدد موجودی", callback_data: `admin_hoosh_resend:${inv.uid}` }],
            [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
          ],
        },
      }
    );
    return;
  }

  // ── Admin: force-resend fulfillment for a HooshPay invoice ────────────────
  if (data.startsWith("admin_hoosh_resend:")) {
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }
    const uid = data.split("admin_hoosh_resend:")[1];
    const inv = await HooshPayInvoice.findOne({ uid });
    if (!inv) {
      await bot.answerCallbackQuery(query.id, { text: "❌ فاکتور یافت نشد", show_alert: true });
      return;
    }
    if (inv.status !== "paid") {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ این فاکتور هنوز پرداخت نشده است", show_alert: true });
      return;
    }
    // Reset fulfilled flag so fulfillHooshOrder can run again
    await HooshPayInvoice.findByIdAndUpdate(inv._id, { $set: { fulfilled: false, fulfilledAt: null } });
    const { fulfillHooshOrder } = await import("../services/hooshpay/fulfillHooshOrder.js");
    await fulfillHooshOrder({ invoice: { ...inv.toObject(), fulfilled: false }, bot, chatId: inv.userId });
    await bot.answerCallbackQuery(query.id, { text: "✅ موجودی مجدداً ارسال شد" });
    return;
  }

  switch (data) {
    // ── Payment methods ──────────────────────────────────────────────────────
    case "pay_hoosh":
      await payHoosh(bot, query, session);
      break;

    case "pay_bank": {
      const payBank = (await import("./../paymentHandlers/payBank.js")).default;
      await payBank(bot, query, session);
      break;
    }

    case "pay_trx":
      await payTrx(bot, query, session);
      break;

    case "send_trx_wallet":
      await sendTrxWallet(bot, chatId, session);
      break;

    case "upload_receipt":
      await promptForReceipt(bot, chatId, session);
      break;

    // ── Cancel / back ────────────────────────────────────────────────────────
    case "back_to_topup":
      await bot.deleteMessage(chatId, messageId);

      // Clean up any pending invoice for the current payment type
      if (session?.paymentId) {
        const { paymentType, paymentId } = session;
        try {
          if (paymentType === "bank") {
            await invoice.findOneAndDelete({ paymentId });
          } else if (paymentType === "trx" || paymentType === "crypto") {
            await CryptoInvoice.findOneAndDelete({ invoiceId: paymentId });
          } else if (paymentType === "hoosh") {
            // Mark as expired rather than deleting (preserves audit trail)
            await HooshPayInvoice.findOneAndUpdate(
              { uid: paymentId, fulfilled: false, status: "pending" },
              { $set: { status: "expired" } }
            );
          }
        } catch (err) {
          console.error("[back_to_topup] cleanup error:", err.message);
        }
      }

      await clearSession(chatId);
      await showPaymentMethods(bot, chatId);
      break;

    case "back_to_home":
      try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
      await clearSession(chatId);
      if (session?.supportMessageId && session.supportMessageId !== messageId) {
        try { await bot.deleteMessage(chatId, session.supportMessageId); } catch (_) {}
      }
      await bot.sendMessage(chatId, CHOOSE_OPTION_MESSAGE, keyboard);
      break;

    // ── Service purchase ─────────────────────────────────────────────────────
    case "duration_30":
      await bot.editMessageText("💡 لطفاً یکی از پلن‌های 30 روزه را انتخاب کنید:", {
        chat_id: chatId,
        message_id: messageId,
        ...generatePlanButtons(plans30),
      });
      break;

    case "duration_60":
      await bot.editMessageText("💡 لطفاً یکی از پلن‌های 60 روزه را انتخاب کنید:", {
        chat_id: chatId,
        message_id: messageId,
        ...generatePlanButtons(plans60),
      });
      break;

    case "duration_90":
      await bot.editMessageText("💡 لطفاً یکی از پلن‌های 90 روزه را انتخاب کنید:", {
        chat_id: chatId,
        message_id: messageId,
        ...generatePlanButtons(plans90),
      });
      break;

    case "buy_service_back_to_main":
      await bot.deleteMessage(chatId, messageId);
      await bot.sendMessage(chatId, CHOOSE_OPTION_MESSAGE);
      break;

    case "buy_service_back":
      await bot.deleteMessage(chatId, messageId);
      await handleBuyService(bot, chatId);
      break;

    // ── Admin: back to panel ─────────────────────────────────────────────────
    case "admin_back_to_panel": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await clearSession(chatId);
      await bot.editMessageText("🔒 پنل مدیریت", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: ADMIN_PANEL_KEYBOARD,
      });
      break;
    }

    // ── Admin: system status ─────────────────────────────────────────────────
    case "admin_status": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      try {
        const statusData = await StatusApi();
        if (statusData.ok) {
          const r = statusData.result;
          const pct = r.count_services > 0
            ? Math.round((r.count_active_services / r.count_services) * 100)
            : 0;
          await bot.editMessageText(
            `📊 <b>وضعیت سیستم</b>\n\n` +
            `🔗 سیستم: <code>${r.system === "connected" ? "🟢 متصل" : "🔴 قطع"}</code> | پینگ: <code>${r.ping}ms</code>\n` +
            `💰 موجودی: <code>${r.balance} تومان</code>\n` +
            `📦 کل سرویس‌ها: <code>${r.count_services}</code> | فعال: <code>${r.count_active_services}</code> (<code>${pct}%</code>)\n` +
            `💵 هر گیگ: <code>${r.per_gb}</code> | هر روز: <code>${r.per_day}</code> تومان\n\n` +
            `🕐 <code>${new Date().toLocaleString("fa-IR")}</code>`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "🔍 اسکن TRX", callback_data: "admin_scan_trx_wallet" },
                    { text: "📊 وضعیت TRX", callback_data: "admin_trx_scan_status" },
                  ],
                  [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
                ],
              },
            }
          );
        } else {
          throw new Error(statusData.error || "API error");
        }
      } catch (err) {
        await bot.editMessageText(`❌ خطا در وضعیت سیستم:\n<code>${err.message}</code>`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🔄 تلاش مجدد", callback_data: "admin_status" }, { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }]] },
        });
      }
      break;
    }

    // ── Admin: financial report ──────────────────────────────────────────────
    case "admin_financial_report": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      try {
        const paidCrypto = await CryptoInvoice.find({ status: "paid" });
        const confirmedBank = await invoice.find({ status: { $in: ["paid", "confirmed"] } });
        const paidHoosh = await HooshPayInvoice.find({ status: "paid", fulfilled: true });

        const cryptoSum = paidCrypto.reduce((s, i) => s + (i.amount || 0), 0);
        const bankSum = confirmedBank.reduce((s, i) => s + (i.amount || 0), 0);
        const hooshSum = paidHoosh.reduce((s, i) => s + (i.amount || 0), 0);
        const totalTopups = cryptoSum + bankSum + hooshSum;

        const users = await User.find({});
        const totalBalances = users.reduce((s, u) => s + (u.balance || 0), 0);
        const recognizedRevenue = Math.max(0, totalTopups - totalBalances);

        const allPlans = [...plans30, ...plans60, ...plans90]
          .map((p) => ({ price: p.price, gig: p.gig, days: p.days }))
          .sort((a, b) => b.price - a.price);
        let remaining = recognizedRevenue;
        let estGigSold = 0;
        let estDaysSold = 0;
        for (const plan of allPlans) {
          if (plan.price > 0 && remaining >= plan.price) {
            const cnt = Math.floor(remaining / plan.price);
            estGigSold += cnt * (plan.gig || 0);
            estDaysSold += cnt * (plan.days || 0);
            remaining -= cnt * plan.price;
          }
        }
        const costPerDay = Number(process.env.COST_PER_DAY || 200);
        const costPerGb = Number(process.env.COST_PER_GB || 300);
        const totalCost = estDaysSold * costPerDay + estGigSold * costPerGb;
        const profit = recognizedRevenue - totalCost;

        await bot.editMessageText(
          `💵 <b>گزارش مالی جامع</b>\n\n` +
          `💰 <b>درآمدها:</b>\n` +
          `• کل شارژها: <code>${totalTopups.toLocaleString()}</code> تومان\n` +
          `• HooshPay (آنلاین): <code>${hooshSum.toLocaleString()}</code> تومان\n` +
          `• کریپتو (TRX): <code>${cryptoSum.toLocaleString()}</code> تومان\n` +
          `• بانکی: <code>${bankSum.toLocaleString()}</code> تومان\n\n` +
          `👛 موجودی فعلی کاربران: <code>${totalBalances.toLocaleString()}</code> تومان\n` +
          `📊 درآمد واقعی: <code>${recognizedRevenue.toLocaleString()}</code> تومان\n\n` +
          `💸 هزینه تخمینی: <code>${totalCost.toLocaleString()}</code> تومان\n` +
          `📈 <b>سود خالص: <code>${profit.toLocaleString()}</code> تومان</b>`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📊 جزئیات", callback_data: "admin_detailed_financial" },
                  { text: "📅 ماهانه", callback_data: "admin_monthly_report" },
                ],
                [
                  { text: "💰 کریپتو", callback_data: "admin_crypto_report" },
                  { text: "🏦 بانکی", callback_data: "admin_bank_report" },
                ],
                [
                  { text: "🏦 HooshPay", callback_data: "admin_hooshpay_report" },
                  { text: "👥 کاربران", callback_data: "admin_users_report" },
                ],
                [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
              ],
            },
          }
        );
      } catch (err) {
        await bot.editMessageText(`❌ خطا در گزارش مالی`, {
          chat_id: chatId, message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }]] },
        });
      }
      break;
    }

    // ── Admin: HooshPay report ────────────────────────────────────────────────
    case "admin_hooshpay_report": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await hooshpayReport(bot, query, session);
      break;
    }

    // ── Admin: sub-reports ───────────────────────────────────────────────────
    case "admin_detailed_financial": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await detailedFinancialReport(bot, query, session);
      break;
    }
    case "admin_bank_report": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await bankReport(bot, query, session);
      break;
    }
    case "admin_users_report": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await usersReport(bot, query, session);
      break;
    }
    case "admin_monthly_report": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await monthlyReport(bot, query, session);
      break;
    }
    case "admin_profit_chart": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await profitChart(bot, query, session);
      break;
    }
    case "admin_crypto_report": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await cryptoReport(bot, query, session);
      break;
    }

    // ── Admin: TRX scanner ───────────────────────────────────────────────────
    case "admin_scan_trx_wallet": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await handleTrxWalletScan(bot, query, session);
      break;
    }
    case "admin_trx_balance": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await showTrxBalance(bot, query, session);
      break;
    }
    case "admin_trx_stats": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await showTrxStats(bot, query, session);
      break;
    }
    case "admin_trx_recent": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await showTrxRecent(bot, query, session);
      break;
    }
    case "admin_trx_scan_status": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await showTrxScanStatus(bot, query, session);
      break;
    }

    // ── Admin: API service purchase ──────────────────────────────────────────
    // These provision paid VPN services from the panel's own account — they
    // MUST be admin-gated here, not only inside the helper functions.
    case "admin_api_service_purchase":
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await apiServicePurchase(bot, query, session);
      break;
    case "admin_create_api_service":
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await createApiService(bot, query, session);
      break;
    case "admin_cancel_api_purchase":
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await cancelApiPurchase(bot, query);
      break;

    // ── Admin: send message to user ──────────────────────────────────────────
    case "admin_send_message_to_user": {
      if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); break; }
      await setSession(chatId, {
        step: "admin_waiting_for_user_id",
        action: "send_message_to_user",
        messageId,
      });
      await bot.editMessageText(
        "📨 <b>ارسال پیام به کاربر</b>\n\n🔢 لطفاً <b>آیدی عددی</b> کاربر را وارد کنید:",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }]] },
        }
      );
      break;
    }

    // ── Misc ─────────────────────────────────────────────────────────────────
    case "confirm_payment":
      // Placeholder — bank payment confirmation is handled by startsWith below
      break;
  }

  // ── Dynamic callback handlers (startsWith) ─────────────────────────────────

  if (data.startsWith("confirm_payment_")) {
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }

    // New callbacks contain only the invoice ID. Older receipt messages also
    // included an untrusted user ID and amount, so retain compatibility by
    // reading just the last field and ignoring the rest.
    const encoded = data.slice("confirm_payment_".length);
    const paymentId = encoded.includes("_") ? encoded.slice(encoded.lastIndexOf("_") + 1) : encoded;
    try {
      const result = await confirmBankPayment({ paymentId, adminId: userId, bot });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});

      if (result.status === "credited" || result.status === "recovered") {
        await bot.sendMessage(chatId, "✅ پرداخت تأیید شد و موجودی کاربر ثبت شد.");
        await bot.answerCallbackQuery(query.id, { text: "✅ پرداخت تأیید شد" });
      } else if (result.status === "already_confirmed") {
        await bot.answerCallbackQuery(query.id, { text: "⚠️ این پرداخت قبلاً تأیید شده است", show_alert: true });
      } else if (result.status === "user_not_found") {
        await bot.answerCallbackQuery(query.id, { text: "❌ حساب کاربر یافت نشد؛ فاکتور به صف بررسی بازگشت", show_alert: true });
      } else if (result.status === "manual_review") {
        await bot.answerCallbackQuery(query.id, { text: "⚠️ فاکتور قدیمی است و به تطبیق دستی نیاز دارد", show_alert: true });
      } else if (result.status === "invalid") {
        await bot.answerCallbackQuery(query.id, { text: "❌ شناسه فاکتور نامعتبر است", show_alert: true });
      } else {
        await bot.answerCallbackQuery(query.id, { text: "⚠️ این فاکتور در انتظار تأیید نیست", show_alert: true });
      }
    } catch (error) {
      console.error("Bank payment confirmation failed:", error?.name || "PaymentError");
      await bot.answerCallbackQuery(query.id, { text: "❌ تأیید پرداخت موقتاً انجام نشد؛ دوباره تلاش کنید", show_alert: true });
    }
    return;
  }

  if (data.startsWith("reject_payment_")) {
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }

    const encoded = data.slice("reject_payment_".length);
    const paymentId = encoded.includes("_") ? encoded.slice(0, encoded.indexOf("_")) : encoded;
    try {
      const rejected = await invoice.findOneAndUpdate(
        { paymentId, paymentType: "bank", status: "waiting_for_approval", balanceCredited: false },
        { $set: { status: "rejected", rejectedAt: new Date(), rejectedBy: String(userId) } },
        { new: true }
      );
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
      if (!rejected) {
        await bot.answerCallbackQuery(query.id, { text: "⚠️ این فاکتور قبلاً بررسی شده است", show_alert: true });
        return;
      }

      await bot.sendMessage(chatId, "❌ پرداخت رد شد.");
      try {
        await bot.sendMessage(
          String(rejected.userId),
          "❌ رسید پرداخت شما توسط ادمین رد شد. در صورت نیاز با پشتیبانی تماس بگیرید.",
          { reply_markup: keyboard.reply_markup }
        );
      } catch (error) {
        console.warn("Bank rejection notification failed:", error?.name || "TelegramError");
      }
      await bot.answerCallbackQuery(query.id, { text: "❌ پرداخت رد شد" });
    } catch (error) {
      console.error("Bank payment rejection failed:", error?.name || "DatabaseError");
      await bot.answerCallbackQuery(query.id, { text: "❌ رد پرداخت موقتاً انجام نشد", show_alert: true });
    }
    return;
  }

  if (data.startsWith("send_config_to_user_")) {
    // ADMIN ONLY — the admin then types a config that is delivered to a user.
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }

    const targetUserId = data.split("send_config_to_user_")[1];
    const sentMsg = await bot.sendMessage(chatId, "📝 لطفاً کانفیگ سرویس را ارسال کنید:", {
      reply_markup: { inline_keyboard: [] },
    });
    await setSession(chatId, {
      step: "waiting_for_config_details",
      targetUserId,
      messageId: sentMsg.message_id,
    });
    return;
  }

  if (data.startsWith("plan_")) {
    const planId = data.replace("plan_", "");
    const allPlans = [...plans30, ...plans60, ...plans90];
    const selectedPlan = allPlans.find((p) => p.id === planId);
    if (!selectedPlan) { await bot.sendMessage(chatId, "❌ پلن مورد نظر یافت نشد."); return; }
    const { message, replyMarkup } = confirmOrder(selectedPlan);
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
      parse_mode: "HTML",
    });
    return;
  }

  if (data.startsWith("confirm_order_")) {
    const planId = data.split("confirm_order_")[1];
    const allPlans = [...plans30, ...plans60, ...plans90];
    const selectedPlan = allPlans.find((p) => p.id.toString() === planId);
    if (!selectedPlan) { return bot.sendMessage(chatId, "❌ پلن مورد نظر یافت نشد."); }
    await bot.deleteMessage(chatId, messageId);
    await orderService(bot, chatId, userId, selectedPlan);
    return;
  }

  if (data.startsWith("register_vpn_id")) {
    // ADMIN ONLY — registers a VPN service ID against a user account.
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }
    const targetTelegramId = data.split(":")[1];
    await setSession(chatId, { step: "waiting_for_vpn_id", targetTelegramId, messageId });
    await bot.editMessageText("🔑 لطفاً آیدی سرویس را وارد کنید:", { chat_id: chatId, message_id: messageId });
    return;
  }

  if (data.startsWith("show_service_")) {
    const username = data.split("show_service_")[1];
    if (!(await userOwnsService(userId, username))) { await denyOwnership(bot, query.id); return; }
    await showServiceDetails(bot, chatId, username, messageId);
    return;
  }

  if (data.startsWith("change_link_")) {
    const username = data.split("change_link_")[1];
    if (!(await userOwnsService(userId, username))) { await denyOwnership(bot, query.id); return; }
    await changeServiceLink(bot, chatId, messageId, data, query);
    return;
  }

  if (data.startsWith("delete_service_")) {
    const username = data.split("delete_service_")[1];
    if (!(await userOwnsService(userId, username))) { await denyOwnership(bot, query.id); return; }
    await bot.editMessageText("آیا می خواهید این سرویس را حذف کنید؟", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ خیر", callback_data: `show_service_${username}` }, { text: "✅ بله", callback_data: `confirm_delete_service_${username}` }],
        ],
      },
    });
    await setSession(chatId, { step: "confirm_delete_service", username });
    return;
  }

  if (data.startsWith("confirm_delete_service_")) {
    const username = data.split("confirm_delete_service_")[1];
    if (!(await userOwnsService(userId, username))) { await denyOwnership(bot, query.id); return; }
    const res = await deleteService(username);
    const user = await User.findOne({ telegramId: userId });
    if (user) {
      await User.updateOne(
        { telegramId: userId },
        { $pull: { services: { username } }, $set: { totalServices: Math.max(0, (user.totalServices || 0) - 1) } }
      );
    }
    await bot.editMessageText(res.result ? "✅ سرویس با موفقیت حذف شد." : "❌ خطا در حذف سرویس.", {
      chat_id: chatId,
      message_id: messageId,
    });
    return;
  }

  if (data.startsWith("qrcode_")) {
    const username = data.split("qrcode_")[1];
    if (!(await userOwnsService(userId, username))) { await denyOwnership(bot, query.id); return; }
    await generateQRCode(bot, chatId, messageId, data, query);
    return;
  }

  if (data.startsWith("deactivate_service_")) {
    const username = data.split("deactivate_service_")[1];
    if (!(await userOwnsService(userId, username))) { await denyOwnership(bot, query.id); return; }
    await deactivateServiceButton(bot, chatId, messageId, data, query);
    return;
  }

  if (data.startsWith("alert_discount_code_disabled")) {
    await bot.editMessageText("کد تخفیف فعلا غیرفعال است.", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: "🔄 بازگشت", callback_data: "back_to_profile" }]] },
    });
    return;
  }

  if (data.startsWith("back_to_profile")) {
    await bot.deleteMessage(chatId, messageId);
    await handleProfile(bot, chatId, userId);
    return;
  }

  if (data.startsWith("extend_service_") || data.startsWith("extend_data_")) {
    await bot.answerCallbackQuery(query.id, {
      text: "⛔️ این آپشن در حال حاضر غیرفعال است! لطفا سرویس جدید خریداری فرمایید",
      show_alert: true,
    });
    return;
  }

  // ── Admin: HooshPay invoice search prompt ─────────────────────────────────
  if (data.startsWith("admin_hoosh_search_prompt:")) {
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }
    const type = data.split("admin_hoosh_search_prompt:")[1]; // "uid" or "order"
    const label = type === "uid" ? "UID فاکتور" : "Order ID";
    await setSession(chatId, {
      step: "admin_waiting_for_hoosh_search",
      hooshSearchType: type,
      messageId,
    });
    await bot.editMessageText(
      `🔍 <b>جستجوی فاکتور HooshPay</b>\n\n` +
      `لطفاً <b>${label}</b> را وارد کنید:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت", callback_data: "admin_hooshpay_report" }]] },
      }
    );
    return;
  }

  // ── Admin: run all pending (paid but unfulfilled) HooshPay orders ─────────
  if (data === "admin_hoosh_run_pending") {
    if (!isAdmin(chatId, userId)) { await denyAdmin(bot, query.id); return; }
    await bot.answerCallbackQuery(query.id, { text: "⏳ در حال اجرا..." });
    const { fulfillHooshOrder } = await import("../services/hooshpay/fulfillHooshOrder.js");
    const pending = await HooshPayInvoice.find({ status: "paid", fulfilled: false });
    let count = 0;
    for (const inv of pending) {
      try {
        await fulfillHooshOrder({ invoice: inv, bot, chatId: inv.userId });
        count++;
      } catch (e) {
        console.error(`[admin_hoosh_run_pending] Error for uid=${inv.uid}:`, e.message);
      }
    }
    await bot.sendMessage(chatId, `✅ ${count} سفارش معلق تسویه شد.`);
    return;
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  // Unknown/stale callback data reaches here. Acknowledge so the client-side
  // spinner is always dismissed; errors are expected when a handler already
  // answered and are intentionally swallowed.
  try {
    await bot.answerCallbackQuery(query.id);
  } catch { /* already answered */ }
};

export default handleCallbackQuery;
