import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import { summarizeUsers } from "../../services/admin/collectionStats.js";

const usersReport = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const stats = await summarizeUsers();
    const report =
      `👥 <b>گزارش کاربران جامع</b>\n\n` +
      `📊 <b>آمار کلی:</b>\n` +
      `• کل کاربران: <code>${stats.totalUsers}</code>\n` +
      `• کاربران فعال: <code>${stats.activeUsers}</code>\n` +
      `• کاربران غیرفعال: <code>${stats.inactiveUsers}</code>\n` +
      `• کاربران پریمیوم: <code>${stats.premiumUsers}</code>\n\n` +
      `💰 <b>موجودی‌ها:</b>\n` +
      `• کل موجودی: <code>${stats.totalBalance.toLocaleString()}</code> تومان\n` +
      `• متوسط موجودی: <code>${stats.avgBalance.toLocaleString()}</code> تومان\n\n` +
      `📈 <b>توزیع موجودی:</b>\n` +
      `• کم (0-50 هزار): <code>${stats.lowBalance}</code>\n` +
      `• متوسط (50-200 هزار): <code>${stats.mediumBalance}</code>\n` +
      `• بالا (200 هزار+): <code>${stats.highBalance}</code>\n\n` +
      `🛒 <b>سرویس‌ها:</b>\n` +
      `• کل سرویس‌ها: <code>${stats.totalServices}</code>\n` +
      `• کل پرداخت‌ها: <code>${stats.totalPayments}</code>\n\n` +
      `🆕 <b>کاربران جدید:</b>\n` +
      `• 30 روز اخیر: <code>${stats.newUsers}</code>\n\n` +
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
            { text: "🏦 گزارش بانکی", callback_data: "admin_bank_report" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_financial_report" }],
        ],
      },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ گزارش کاربران نمایش داده شد" });
  } catch (error) {
    console.error("❌ Error in users report:", error.message);
    await bot.editMessageText(
      `❌ خطا در نمایش گزارش کاربران:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_users_report" },
            { text: "🏠 بازگشت", callback_data: "admin_financial_report" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در نمایش گزارش کاربران", show_alert: true });
  }
};

export default usersReport;
