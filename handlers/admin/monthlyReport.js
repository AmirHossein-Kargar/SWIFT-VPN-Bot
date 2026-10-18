import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import User from "../../models/User.js";
import { sumAmount } from "../../services/admin/collectionStats.js";
import { gregorianMonthWindow, jalaliMonthWindow } from "../../services/admin/reportMath.js";

async function periodTotals(start, end) {
  const match = { createdAt: { $gte: start, $lte: end } };
  const [crypto, bank, users] = await Promise.all([
    sumAmount(CryptoInvoice, match),
    sumAmount(bankInvoice, match),
    User.countDocuments(match).maxTimeMS(8_000),
  ]);
  return { cryptoSum: crypto.total, bankSum: bank.total, total: crypto.total + bank.total, users };
}

const monthlyReport = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const now = new Date();
    let window;
    try {
      window = jalaliMonthWindow(now);
    } catch (error) {
      console.error("خطا در تبدیل تاریخ شمسی:", error);
      window = gregorianMonthWindow(now);
    }

    const [current, previous] = await Promise.all([
      periodTotals(window.startOfMonth, window.endOfMonth),
      periodTotals(window.lastMonthStart, window.lastMonthEnd),
    ]);

    const revenueChange = previous.total > 0
      ? (((current.total - previous.total) / previous.total) * 100).toFixed(1)
      : 0;
    const usersChange = previous.users > 0
      ? (((current.users - previous.users) / previous.users) * 100).toFixed(1)
      : 0;

    const report =
      `📅 <b>گزارش ماهانه ${window.monthName} ${window.persianYear}</b>\n\n` +
      `💰 <b>درآمد ماه جاری:</b>\n` +
      `• کل درآمد: <code>${current.total.toLocaleString()}</code> تومان\n` +
      `• کریپتو: <code>${current.cryptoSum.toLocaleString()}</code> تومان\n` +
      `• بانکی: <code>${current.bankSum.toLocaleString()}</code> تومان\n\n` +
      `👥 <b>کاربران جدید:</b>\n` +
      `• ماه جاری: <code>${current.users}</code>\n` +
      `• ماه قبل: <code>${previous.users}</code>\n` +
      `• تغییر: <code>${usersChange}%</code>\n\n` +
      `📊 <b>مقایسه با ماه قبل:</b>\n` +
      `• درآمد ماه قبل: <code>${previous.total.toLocaleString()}</code> تومان\n` +
      `• تغییر درآمد: <code>${revenueChange}%</code>\n\n` +
      `📈 <b>روند:</b>\n` +
      `• وضعیت درآمد: ${revenueChange > 0 ? "📈 افزایش" : revenueChange < 0 ? "📉 کاهش" : "➡️ ثابت"}\n` +
      `• وضعیت کاربران: ${usersChange > 0 ? "📈 افزایش" : usersChange < 0 ? "📉 کاهش" : "➡️ ثابت"}\n\n` +
      `📅 <b>دوره:</b> ${window.startOfMonth.toLocaleDateString("fa-IR")} تا ${window.endOfMonth.toLocaleDateString("fa-IR")}\n` +
      `🕐 <b>آخرین بروزرسانی:</b> ${now.toLocaleString("fa-IR")}`;

    await bot.editMessageText(report, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 جزئیات بیشتر", callback_data: "admin_detailed_financial" },
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

    await bot.answerCallbackQuery(query.id, { text: "✅ گزارش ماهانه نمایش داده شد" });
  } catch (error) {
    console.error("❌ Error in monthly report:", error.message);
    await bot.editMessageText(
      `❌ خطا در نمایش گزارش ماهانه:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_monthly_report" },
            { text: "🏠 بازگشت", callback_data: "admin_financial_report" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در نمایش گزارش ماهانه", show_alert: true });
  }
};

export default monthlyReport;
