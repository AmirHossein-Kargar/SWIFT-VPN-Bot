import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import bankInvoice from "../../models/invoice.js";
import { classifyInvoices } from "../../services/admin/collectionStats.js";

const bankReport = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const stats = await classifyInvoices(bankInvoice, {
      confirmedStatuses: ["paid", "confirmed"],
      pendingStatus: "pending",
      rejectedStatus: "rejected",
    });

    const report =
      `🏦 <b>گزارش بانکی جامع</b>\n\n` +
      `📊 <b>آمار کلی:</b>\n` +
      `• کل فاکتورها: <code>${stats.total}</code>\n` +
      `• تایید شده: <code>${stats.confirmedCount}</code>\n` +
      `• در انتظار: <code>${stats.pendingCount}</code>\n` +
      `• رد شده: <code>${stats.rejectedCount}</code>\n\n` +
      `💰 <b>مبالغ:</b>\n` +
      `• کل تایید شده: <code>${stats.confirmedSum.toLocaleString()}</code> تومان\n` +
      `• در انتظار: <code>${stats.pendingSum.toLocaleString()}</code> تومان\n` +
      `• رد شده: <code>${stats.rejectedSum.toLocaleString()}</code> تومان\n\n` +
      `📈 <b>توزیع مبالغ:</b>\n` +
      `• کمتر از 100 هزار: <code>${stats.small}</code>\n` +
      `• 100 هزار تا 500 هزار: <code>${stats.medium}</code>\n` +
      `• بیشتر از 500 هزار: <code>${stats.large}</code>\n\n` +
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
            { text: "💰 گزارش کریپتو", callback_data: "admin_crypto_report" },
            { text: "👥 گزارش کاربران", callback_data: "admin_users_report" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_financial_report" }],
        ],
      },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ گزارش بانکی نمایش داده شد" });
  } catch (error) {
    console.error("❌ Error in bank report:", error.message);
    await bot.editMessageText(
      `❌ خطا در نمایش گزارش بانکی:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_bank_report" },
            { text: "🏠 بازگشت", callback_data: "admin_financial_report" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در نمایش گزارش بانکی", show_alert: true });
  }
};

export default bankReport;
