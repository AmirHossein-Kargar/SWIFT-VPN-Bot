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

// ─── Helper: verify the caller is an admin in the admin group ──────────────
function isAdmin(chatId, userId) {
  const groupId = process.env.GROUP_ID;
  const adminIds = (process.env.ADMINS || "")
    .split(",")
    .filter(Boolean)
    .map((id) => Number(id.trim()));

  if (groupId && chatId.toString() !== String(groupId)) return false;
  if (adminIds.length > 0 && !adminIds.includes(Number(userId))) return false;
  return true;
}

async function denyAdmin(bot, queryId) {
  await bot.answerCallbackQuery(queryId, {
    text: "⛔️ دسترسی غیرمجاز",
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
  const data = query.data;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const session = await getSession(chatId);

  // ── hoosh_verify:<uid> — manual "I've Paid" verification ─────────────────
  if (data.startsWith("hoosh_verify:")) {
    const uid = data.split("hoosh_verify:")[1];
    if (!uid) return;

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
      // Delete the payment message.
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

    if (result.notPaid) {
      // Re-fetch invoice to show payment URL again
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
    case "admin_api_service_purchase":
      await apiServicePurchase(bot, query, session);
      break;
    case "admin_create_api_service":
      await createApiService(bot, query, session);
      break;
    case "admin_cancel_api_purchase":
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
    const parts = data.split("_");
    if (parts.length >= 5) {
      const targetUserId = parts[2];
      const amount = parseInt(parts[3].replace(/,/g, ""));
      const paymentId = parts[4];

      try {
        const user = await User.findOneAndUpdate(
          { telegramId: targetUserId },
          { $inc: { balance: amount, successfulPayments: 1 } },
          { new: true }
        );
        if (!user) {
          await bot.answerCallbackQuery(query.id, { text: "❌ کاربر یافت نشد", show_alert: true });
          return;
        }
        await invoice.findOneAndUpdate({ paymentId }, { status: "confirmed" });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await bot.sendMessage(chatId, "✅ پرداخت تایید شد و موجودی کاربر افزایش یافت.");
        await bot.sendMessage(
          targetUserId,
          `✅ پرداخت شما تایید شد!\n💰 مبلغ ${amount.toLocaleString("en-US")} تومان به کیف پول شما اضافه شد.`,
          { reply_markup: keyboard.reply_markup }
        );
        await bot.answerCallbackQuery(query.id, { text: "✅ پرداخت تایید شد" });
      } catch (err) {
        console.error("Error confirming payment:", err);
        await bot.answerCallbackQuery(query.id, { text: "❌ خطا در تایید پرداخت" });
      }
      return;
    }
  }

  if (data.startsWith("reject_payment_")) {
    const rest = data.split("reject_payment_")[1];
    const underscoreIdx = rest.indexOf("_");
    if (underscoreIdx === -1) { console.error("❗ reject_payment_ missing userId"); return; }
    const paymentId = rest.slice(0, underscoreIdx);
    const targetUserId = rest.slice(underscoreIdx + 1);

    try {
      await invoice.findOneAndDelete({ paymentId });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      await bot.sendMessage(chatId, "❌ پرداخت رد شد.");
      await bot.sendMessage(
        targetUserId,
        "❌ پرداخت شما توسط ادمین رد شد. در صورت نیاز با پشتیبانی تماس بگیرید.",
        { reply_markup: keyboard.reply_markup }
      );
      await bot.answerCallbackQuery(query.id, { text: "❌ پرداخت رد شد" });
    } catch (err) {
      console.error("Error rejecting payment:", err);
      await bot.answerCallbackQuery(query.id, { text: "❌ خطا در رد پرداخت", show_alert: true });
    }
    return;
  }

  if (data.startsWith("send_config_to_user_")) {
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
    const targetTelegramId = data.split(":")[1];
    await setSession(chatId, { step: "waiting_for_vpn_id", targetTelegramId, messageId });
    await bot.editMessageText("🔑 لطفاً آیدی سرویس را وارد کنید:", { chat_id: chatId, message_id: messageId });
    return;
  }

  if (data.startsWith("show_service_")) {
    const username = data.split("show_service_")[1];
    await showServiceDetails(bot, chatId, username, messageId);
    return;
  }

  if (data.startsWith("change_link_")) {
    await changeServiceLink(bot, chatId, messageId, data, query);
    return;
  }

  if (data.startsWith("delete_service_")) {
    const username = data.split("delete_service_")[1];
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
    await generateQRCode(bot, chatId, messageId, data, query);
    return;
  }

  if (data.startsWith("deactivate_service_")) {
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
};

export default handleCallbackQuery;
