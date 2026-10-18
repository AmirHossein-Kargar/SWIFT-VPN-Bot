/**
 * Admin: HooshPay payment report
 * Accessible via callback_data: "admin_hooshpay_report"
 */
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import escapeHtml, { escapeErrorMessage } from "../../utils/escapeHtml.js";
import { hooshPayReportStats } from "../../services/admin/collectionStats.js";

const hooshpayReport = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const [stats, paidInvoices] = await Promise.all([
      hooshPayReportStats(),
      HooshPayInvoice.find({ status: "paid", fulfilled: true })
        .sort({ paidAt: -1 })
        .limit(5)
        .select("uid amount userId trackingCode paidAt")
        .maxTimeMS(8_000)
        .lean(),
    ]);

    let recentLines = "";
    if (paidInvoices.length > 0) {
      recentLines = "\n\n📋 <b>آخرین پرداخت‌ها:</b>\n";
      for (const inv of paidInvoices) {
        const date = inv.paidAt ? new Date(inv.paidAt).toLocaleString("fa-IR") : "نامشخص";
        const tracking = inv.trackingCode ? ` | کد: ${escapeHtml(inv.trackingCode)}` : "";
        recentLines += `• <code>${escapeHtml(String(inv.uid).slice(0, 12))}…</code> | ${Number(inv.amount || 0).toLocaleString()} تومان | کاربر: <code>${escapeHtml(inv.userId)}</code>${tracking} | ${date}\n`;
      }
    }

    const report =
      `🏦 <b>گزارش HooshPay</b>\n\n` +
      `📊 <b>آمار کلی:</b>\n` +
      `• کل فاکتورها: <code>${stats.all}</code>\n` +
      `• پرداخت شده: <code>${stats.paid}</code>\n` +
      `• در انتظار: <code>${stats.pending}</code>\n` +
      `• منقضی: <code>${stats.expired}</code>\n` +
      `• لغوشده: <code>${stats.cancelled}</code>\n` +
      `• ناموفق: <code>${stats.failed}</code>\n\n` +
      `💰 <b>جمع کل دریافتی:</b> <code>${stats.totalAmount.toLocaleString()}</code> تومان\n` +
      (stats.unfulfilled > 0 ? `\n⚠️ <b>${stats.unfulfilled} فاکتور پرداخت‌شده هنوز تسویه نشده!</b>\n` : "") +
      recentLines +
      `\n📅 ${new Date().toLocaleString("fa-IR")}`;

    await bot.editMessageText(report, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔍 جستجو با UID", callback_data: "admin_hoosh_search_prompt:uid" },
            { text: "🔍 جستجو با Order ID", callback_data: "admin_hoosh_search_prompt:order" },
          ],
          ...(stats.unfulfilled > 0
            ? [[{ text: "⚡ اجرای تسویه‌های معلق", callback_data: "admin_hoosh_run_pending" }]]
            : []),
          [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
        ],
      },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ گزارش HooshPay نمایش داده شد" });
  } catch (err) {
    console.error("[hooshpayReport] Error:", err.message);
    await bot.editMessageText(
      `❌ خطا در نمایش گزارش HooshPay:\n<code>${escapeErrorMessage(err)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_hooshpay_report" },
            { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در گزارش", show_alert: true });
  }
};

export default hooshpayReport;
