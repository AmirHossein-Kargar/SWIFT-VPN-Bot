import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import { classifyInvoices, groupAmounts } from "../../services/admin/collectionStats.js";

const cryptoReport = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const [stats, byType] = await Promise.all([
      classifyInvoices(CryptoInvoice, {
        confirmedStatuses: ["paid"],
        pendingStatus: "unpaid",
        rejectedStatus: "rejected",
      }),
      groupAmounts(CryptoInvoice, {}, "paymentType"),
    ]);
    const conversionRate = stats.confirmedCount > 0
      ? ((stats.confirmedCount / stats.total) * 100).toFixed(1)
      : 0;

    const report =
      `💰 <b>گزارش کریپتو جامع</b>\n\n` +
      `📊 <b>آمار کلی:</b>\n` +
      `• کل فاکتورها: <code>${stats.total}</code>\n` +
      `• تایید شده: <code>${stats.confirmedCount}</code>\n` +
      `• در انتظار: <code>${stats.pendingCount}</code>\n` +
      `• رد شده: <code>${stats.rejectedCount}</code>\n\n` +
      `💰 <b>مبالغ:</b>\n` +
      `• کل تایید شده: <code>${stats.confirmedSum.toLocaleString()}</code> تومان\n` +
      `• در انتظار: <code>${stats.pendingSum.toLocaleString()}</code> تومان\n` +
      `• رد شده: <code>${stats.rejectedSum.toLocaleString()}</code> تومان\n\n` +
      `📈 <b>نرخ تبدیل:</b> <code>${conversionRate}%</code>\n\n` +
      `📊 <b>توزیع مبالغ:</b>\n` +
      `• کمتر از 100 هزار: <code>${stats.small}</code>\n` +
      `• 100 هزار تا 500 هزار: <code>${stats.medium}</code>\n` +
      `• بیشتر از 500 هزار: <code>${stats.large}</code>\n\n` +
      `🪙 <b>جزئیات بر اساس نوع:</b>\n` +
      byType
        .map((entry) => `• ${entry.key.toUpperCase()}: ${entry.count} فاکتور، ${entry.amount.toLocaleString()} تومان`)
        .join("\n") +
      "\n\n" +
      `📅 <b>آخرین بروزرسانی:</b> ${new Date().toLocaleString("fa-IR")}`;

    await bot.editMessageText(report, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 جزئیات بیشتر", callback_data: "admin_detailed_financial" },
            { text: "📅 گزارش ماهانه", callback_data: "admin_monthly_report" },
          ],
          [
            { text: "🏦 گزارش بانکی", callback_data: "admin_bank_report" },
            { text: "👥 گزارش کاربران", callback_data: "admin_users_report" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_financial_report" }],
        ],
      },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ گزارش کریپتو نمایش داده شد" });
  } catch (error) {
    console.error("❌ Error in crypto report:", error.message);
    await bot.editMessageText(
      `❌ خطا در نمایش گزارش کریپتو:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_crypto_report" },
            { text: "🏠 بازگشت", callback_data: "admin_financial_report" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در نمایش گزارش کریپتو", show_alert: true });
  }
};

export default cryptoReport;
