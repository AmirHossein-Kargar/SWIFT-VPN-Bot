import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import { plans30, plans60, plans90 } from "../../services/plans.js";
import { sumAmount, sumUserBalances } from "../../services/admin/collectionStats.js";
import { estimateCatalogConsumption } from "../../services/admin/reportMath.js";

const profitChart = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const [crypto, bank, totalBalances] = await Promise.all([
      sumAmount(CryptoInvoice, { status: "paid" }),
      sumAmount(bankInvoice, { status: { $in: ["paid", "confirmed"] } }),
      sumUserBalances(),
    ]);
    const totalTopups = crypto.total + bank.total;
    const recognizedRevenue = Math.max(0, totalTopups - totalBalances);
    const { estGigSold, estDaysSold } = estimateCatalogConsumption(recognizedRevenue, [
      ...plans30,
      ...plans60,
      ...plans90,
    ]);

    const costPerDay = Number(process.env.COST_PER_DAY || 200);
    const costPerGb = Number(process.env.COST_PER_GB || 300);
    const totalCost = estDaysSold * costPerDay + estGigSold * costPerGb;
    const profit = recognizedRevenue - totalCost;
    const profitMargin = recognizedRevenue > 0 ? ((profit / recognizedRevenue) * 100).toFixed(1) : 0;
    const costPercentage = recognizedRevenue > 0 ? ((totalCost / recognizedRevenue) * 100).toFixed(1) : 0;
    const createBarChart = (percentage, maxBars = 20) => {
      const bars = Math.round((percentage / 100) * maxBars);
      return "█".repeat(Math.max(0, bars)) + "░".repeat(Math.max(0, maxBars - bars));
    };

    const report =
      `📈 <b>نمودار سود و زیان</b>\n\n` +
      `💰 <b>درآمد کل:</b> <code>${totalTopups.toLocaleString()}</code> تومان\n` +
      `👛 <b>موجودی کاربران:</b> <code>${totalBalances.toLocaleString()}</code> تومان\n` +
      `🎯 <b>درآمد واقعی:</b> <code>${recognizedRevenue.toLocaleString()}</code> تومان\n\n` +
      `💸 <b>هزینه‌ها:</b>\n` +
      `• هزینه کل: <code>${totalCost.toLocaleString()}</code> تومان\n` +
      `• هزینه هر روز: <code>${costPerDay.toLocaleString()}</code> تومان\n` +
      `• هزینه هر گیگ: <code>${costPerGb.toLocaleString()}</code> تومان\n\n` +
      `📊 <b>نمودار سود:</b>\n` +
      `سود: ${createBarChart(profitMargin)} ${profitMargin}%\n` +
      `هزینه: ${createBarChart(costPercentage)} ${costPercentage}%\n\n` +
      `🎉 <b>سود خالص:</b> <code>${profit.toLocaleString()}</code> تومان\n` +
      `📈 <b>حاشیه سود:</b> <code>${profitMargin}%</code>\n\n` +
      `🛒 <b>تخمین فروش:</b>\n` +
      `• گیگ فروخته شده: <code>${estGigSold.toLocaleString()}</code> GB\n` +
      `• روز فروخته شده: <code>${estDaysSold.toLocaleString()}</code> روز\n\n` +
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

    await bot.answerCallbackQuery(query.id, { text: "✅ نمودار سود نمایش داده شد" });
  } catch (error) {
    console.error("❌ Error in profit chart:", error.message);
    await bot.editMessageText(
      `❌ خطا در نمایش نمودار سود:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 تلاش مجدد", callback_data: "admin_profit_chart" },
            { text: "🏠 بازگشت", callback_data: "admin_financial_report" },
          ]],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در نمایش نمودار سود", show_alert: true });
  }
};

export default profitChart;
