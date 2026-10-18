import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import { groupAmounts, summarizeUsers } from "../../services/admin/collectionStats.js";

const detailedFinancialReport = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const [cryptoByType, bankByStatus, users] = await Promise.all([
      groupAmounts(CryptoInvoice, { status: "paid" }, "paymentType"),
      groupAmounts(bankInvoice, { status: { $in: ["paid", "confirmed"] } }, "status"),
      summarizeUsers(),
    ]);

    const report =
      `📊 <b>گزارش مالی جزئیات</b>\n\n` +
      `💰 <b>جزئیات کریپتو:</b>\n` +
      cryptoByType
        .map((entry) => `• ${entry.key.toUpperCase()}: <code>${entry.amount.toLocaleString()}</code> تومان`)
        .join("\n") +
      "\n\n" +
      `🏦 <b>جزئیات بانکی:</b>\n` +
      bankByStatus
        .map((entry) => `• ${entry.key}: <code>${entry.amount.toLocaleString()}</code> تومان`)
        .join("\n") +
      "\n\n" +
      `👥 <b>آمار کاربران:</b>\n` +
      `• کل کاربران: <code>${users.totalUsers}</code>\n` +
      `• کاربران فعال: <code>${users.activeUsers}</code>\n` +
      `• متوسط موجودی: <code>${users.avgBalance.toLocaleString()}</code> تومان\n` +
      `• کل موجودی: <code>${users.totalBalance.toLocaleString()}</code> تومان`;

    await bot.editMessageText(report, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📅 گزارش ماهانه", callback_data: "admin_monthly_report" },
            { text: "💰 گزارش کریپتو", callback_data: "admin_crypto_report" },
          ],
          [
            { text: "🏦 گزارش بانکی", callback_data: "admin_bank_report" },
            { text: "👥 گزارش کاربران", callback_data: "admin_users_report" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_financial_report" }],
        ],
      },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ گزارش مالی جزئیات نمایش داده شد" });
  } catch (error) {
    console.error("❌ Error in detailed financial report:", error.message);
    await bot.editMessageText(
      `❌ خطا در نمایش گزارش مالی جزئیات:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_detailed_financial" },
            { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در نمایش گزارش مالی جزئیات", show_alert: true });
  }
};

export default detailedFinancialReport;
