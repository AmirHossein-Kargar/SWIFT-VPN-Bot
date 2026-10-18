import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import { TRXPrice } from "../../api/TRXPrice.js";
import { USDPrice } from "../../api/USDPrice.js";
import {
  countPayingUsers,
  recentPaidTrx,
  sumPaidTrxInRanges,
  trxPaymentSummary,
} from "../../services/admin/collectionStats.js";
import { invoiceAverage, recentLocalMonths } from "../../services/admin/reportMath.js";

const showTrxStats = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    // ارسال پیام در حال بارگذاری
    await bot.editMessageText(
      "📊 در حال دریافت آمار کامل TRX...\n\n⏳ لطفاً صبر کنید...",
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 بارگذاری مجدد",
                callback_data: "admin_trx_stats",
              },
            ],
          ],
        },
      }
    );

    // دریافت آمار کامل از دیتابیس
    const stats = await getDetailedStats();

    // دریافت قیمت‌ها
    const trxPrice = await TRXPrice();
    const usdPrice = await USDPrice();

    const lines = [];
    lines.push("📊 <b>آمار کامل TRX:</b>");
    lines.push("");

    // بخش آمار کلی
    lines.push("📈 <b>آمار کلی:</b>");
    lines.push(`• کل فاکتورهای TRX: <code>${stats.totalInvoices}</code>`);
    lines.push(`• پرداخت شده: <code>${stats.paidInvoices}</code>`);
    lines.push(`• در انتظار: <code>${stats.pendingInvoices}</code>`);
    lines.push(`• رد شده: <code>${stats.rejectedInvoices}</code>`);
    lines.push("");

    // بخش مبالغ
    lines.push("💰 <b>مبالغ:</b>");
    lines.push(
      `• کل مبلغ پرداخت شده: <code>${stats.totalPaidAmount.toLocaleString()}</code> تومان`
    );
    lines.push(
      `• کل مبلغ TRX پرداخت شده: <code>${stats.totalPaidTrx.toFixed(
        6
      )}</code> TRX`
    );

    if (trxPrice && usdPrice) {
      const totalPaidUSD = stats.totalPaidTrx * trxPrice;
      const totalPaidTomanCalculated = totalPaidUSD * usdPrice;
      lines.push(`• کل مبلغ USD: <code>$${totalPaidUSD.toFixed(2)}</code>`);
      lines.push(
        `• محاسبه تومان: <code>${totalPaidTomanCalculated.toLocaleString()}</code> تومان`
      );
    }
    lines.push("");

    // بخش آمار ماهانه
    if (stats.monthlyStats.length > 0) {
      lines.push("📅 <b>آمار ماهانه (3 ماه اخیر):</b>");
      stats.monthlyStats.forEach((month) => {
        lines.push(
          `• ${month.month}: <code>${
            month.count
          }</code> فاکتور - <code>${month.amount.toLocaleString()}</code> تومان`
        );
      });
      lines.push("");
    }

    // بخش فاکتورهای اخیر
    if (stats.recentInvoices.length > 0) {
      lines.push("🕒 <b>آخرین فاکتورهای پرداخت شده:</b>");
      stats.recentInvoices.slice(0, 5).forEach((invoice, idx) => {
        const date = new Date(invoice.confirmedAt).toLocaleDateString("fa-IR");
        lines.push(
          `${idx + 1}. <code>${
            invoice.invoiceId
          }</code> - <code>${Number(invoice.cryptoAmount || 0).toFixed(
            6
          )}</code> TRX - <code>${Number(invoice.amount || 0).toLocaleString()}</code> تومان - ${date}`
        );
      });
      lines.push("");
    }

    // بخش وضعیت سیستم
    lines.push("🔧 <b>وضعیت سیستم:</b>");
    lines.push(`• آخرین به‌روزرسانی: ${new Date().toLocaleString("fa-IR")}`);
    lines.push(`• تعداد کاربران فعال: <code>${stats.activeUsers}</code>`);
    lines.push(
      `• میانگین مبلغ فاکتور: <code>${stats.averageInvoiceAmount.toLocaleString()}</code> تومان`
    );
    lines.push(`• نرخ موفقیت: <code>${stats.successRate.toFixed(1)}%</code>`);

    const resultText = lines.join("\n");

    // ارسال نتایج
    await bot.editMessageText(resultText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 بارگذاری مجدد", callback_data: "admin_trx_stats" },
            { text: "🔍 اسکن کامل", callback_data: "admin_scan_trx_wallet" },
          ],
          [
            { text: "💰 موجودی", callback_data: "admin_trx_balance" },
            { text: "🕒 تراکنش‌های اخیر", callback_data: "admin_trx_recent" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
        ],
      },
    });

    // پاسخ به callback query
    await bot.answerCallbackQuery(query.id, {
      text: "✅ آمار کامل TRX دریافت شد",
    });
  } catch (error) {
    console.error("❌ Error showing TRX stats:", error.message);

    // ارسال پیام خطا
    await bot.editMessageText(
      `❌ خطا در دریافت آمار کامل TRX:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 تلاش مجدد",
                callback_data: "admin_trx_stats",
              },
              { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
            ],
          ],
        },
      }
    );

    // پاسخ به callback query
    await bot.answerCallbackQuery(query.id, {
      text: "❌ خطا در دریافت آمار کامل TRX",
      show_alert: true,
    });
  }
};

// تابع دریافت آمار تفصیلی
async function getDetailedStats() {
  try {
    const summary = await trxPaymentSummary();
    const months = recentLocalMonths(3);
    const [monthlyStats, recentInvoices, activeUsers] = await Promise.all([
      sumPaidTrxInRanges(months),
      recentPaidTrx(5),
      countPayingUsers(),
    ]);
    const successRate = summary.totalInvoices > 0
      ? (summary.paidInvoices / summary.totalInvoices) * 100
      : 0;

    return {
      ...summary,
      monthlyStats,
      recentInvoices,
      activeUsers,
      averageInvoiceAmount: invoiceAverage(summary.totalPaidAmount, summary.paidInvoices),
      successRate,
    };
  } catch (error) {
    console.error("❌ Error getting detailed stats:", error.message);
    return {
      totalInvoices: 0,
      paidInvoices: 0,
      pendingInvoices: 0,
      rejectedInvoices: 0,
      totalPaidAmount: 0,
      totalPaidTrx: 0,
      monthlyStats: [],
      recentInvoices: [],
      activeUsers: 0,
      averageInvoiceAmount: 0,
      successRate: 0,
    };
  }
}

export default showTrxStats;
