import trxScanner from "../../services/trxWalletScanner.js";
import { TRXPrice } from "../../api/TRXPrice.js";
import { USDPrice } from "../../api/USDPrice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";

const handleTrxWalletScan = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    // ارسال پیام در حال اسکن
    await bot.editMessageText(
      "🔍 در حال اسکن ولت TRX...\n\n⏳ لطفاً صبر کنید...",
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 اسکن مجدد",
                callback_data: "admin_scan_trx_wallet",
              },
            ],
          ],
        },
      }
    );

    // اجرای اسکن دستی و دریافت خلاصه
    const summary = await trxScanner.manualScan();

    // دریافت قیمت TRX و USD
    const trxPrice = await TRXPrice();
    const usdPrice = await USDPrice();

    // محاسبه موجودی ولت به دلار
    const walletBalanceUSD = trxPrice
      ? (summary.totalBalance || 0) * trxPrice
      : null;

    // دریافت آمار کامل از دیتابیس
    const dbStats = await getDatabaseStats();

    const lines = [];
    if (summary?.error) {
      lines.push(`❌ خطا: <code>${summary.error}</code>`);
    } else {
      lines.push("✅ اسکن ولت TRX با موفقیت انجام شد!");
      lines.push("");

      // بخش موجودی ولت
      lines.push("💰 <b>موجودی ولت:</b>");
      if (walletBalanceUSD) {
        lines.push(
          `• موجودی TRX: <code>${(summary.totalBalance || 0).toFixed(
            6
          )}</code> TRX`
        );
        lines.push(
          `• ارزش دلاری: <code>$${walletBalanceUSD.toFixed(2)}</code>`
        );
        lines.push(`• قیمت TRX: <code>$${trxPrice.toFixed(6)}</code>`);
      } else {
        lines.push(
          `• موجودی TRX: <code>${(summary.totalBalance || 0).toFixed(
            6
          )}</code> TRX`
        );
        lines.push(`• قیمت TRX: نامشخص`);
      }
      lines.push("");

      // بخش آمار تراکنش‌ها
      lines.push("📊 <b>آمار تراکنش‌ها:</b>");
      lines.push(
        `• کل تراکنش‌ های TRX ورودی: <code>${summary.totalTransactions}</code>`
      );
      lines.push(
        `• تراکنش‌ های پردازش شده: <code>${summary.processedTransactions}</code>`
      );
      lines.push(`• فاکتور های مطابق: <code>${summary.matchedInvoices}</code>`);
      lines.push(
        `• تایید شده: <code>${summary.confirmedInvoices}</code> | رد شده: <code>${summary.rejectedInvoices}</code> | در انتظار: <code>${summary.pendingMatches}</code>`
      );
      lines.push("");

      // بخش آمار دیتابیس
      lines.push("🗄️ <b>آمار دیتابیس:</b>");
      lines.push(`• کل فاکتورهای TRX: <code>${dbStats.totalInvoices}</code>`);
      lines.push(`• پرداخت شده: <code>${dbStats.paidInvoices}</code>`);
      lines.push(`• در انتظار: <code>${dbStats.pendingInvoices}</code>`);
      lines.push(`• رد شده: <code>${dbStats.rejectedInvoices}</code>`);
      lines.push(
        `• کل مبلغ پرداخت شده: <code>${dbStats.totalPaidAmount.toLocaleString()}</code> تومان`
      );
      lines.push("");

      // بخش تراکنش‌های اخیر
      if (summary.recentTransactions && summary.recentTransactions.length > 0) {
        lines.push("🕒 <b>آخرین تراکنش‌ها:</b>");
        const recentTxs = summary.recentTransactions.slice(0, 10);
        recentTxs.forEach((tx, idx) => {
          const amount = parseFloat(tx.amount) / 1000000;
          const status =
            tx.confirmed && tx.contractRet === "SUCCESS"
              ? "✅"
              : tx.revert
              ? "❌"
              : "⏳";
          const hash =
            tx.hash.substring(0, 8) +
            "..." +
            tx.hash.substring(tx.hash.length - 8);
          lines.push(
            `${idx + 1}. ${status} <code>${amount.toFixed(
              6
            )}</code> TRX - <code>${hash}</code>`
          );
        });
        lines.push("");
      }

      // بخش فاکتورهای مطابق
      if (
        Array.isArray(summary.matchedInvoiceDetails) &&
        summary.matchedInvoiceDetails.length > 0
      ) {
        const preview = summary.matchedInvoiceDetails
          .slice(0, 10)
          .map(
            (d, idx) =>
              `${idx + 1}. <code>${d.invoiceId}</code> — <code>${
                d.cryptoAmount?.toFixed?.(6) ?? d.cryptoAmount
              }</code> TRX (${(d.amount ?? 0).toLocaleString()} تومان)`
          )
          .join("\n");
        lines.push("🧾 <b>فاکتورهای مطابق:</b>");
        lines.push(preview);
        if (summary.matchedInvoiceDetails.length > 10) {
          lines.push(
            `… و <code>${
              summary.matchedInvoiceDetails.length - 10
            }</code> مورد دیگر`
          );
        }
        lines.push("");
      }

      // بخش وضعیت اسکن
      lines.push("🔍 <b>وضعیت اسکن:</b>");
      lines.push(`• آخرین اسکن: ${new Date().toLocaleString("fa-IR")}`);
      lines.push(
        `• وضعیت: ${trxScanner.isScanning ? "⏳ در حال اسکن" : "✅ آماده"}`
      );
      lines.push(
        `• اسکن خودکار: ${trxScanner.scanInterval ? "🟢 فعال" : "🔴 غیرفعال"}`
      );
    }

    const resultText = lines.join("\n");

    // ارسال نتایج به‌صورت ادیت پیام
    await bot.editMessageText(resultText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 اسکن مجدد", callback_data: "admin_scan_trx_wallet" },
            { text: "💰 موجودی", callback_data: "admin_trx_balance" },
          ],
          [
            { text: "📊 آمار کامل", callback_data: "admin_trx_stats" },
            { text: "🕒 تراکنش‌های اخیر", callback_data: "admin_trx_recent" },
          ],
          [
            { text: "🔍 وضعیت اسکن", callback_data: "admin_trx_scan_status" },
            { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
          ],
        ],
      },
    });

    // پاسخ به callback query
    await bot.answerCallbackQuery(query.id, {
      text: "✅ اسکن ولت TRX انجام شد",
    });
  } catch (error) {
    console.error("❌ Error in TRX wallet scan:", error.message);

    // ارسال پیام خطا
    await bot.editMessageText(
      `❌ خطا در اسکن ولت TRX:\n\n<code>${error.message}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 تلاش مجدد",
                callback_data: "admin_scan_trx_wallet",
              },
              { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
            ],
          ],
        },
      }
    );

    // پاسخ به callback query
    await bot.answerCallbackQuery(query.id, {
      text: "❌ خطا در اسکن ولت TRX",
      show_alert: true,
    });
  }
};

// تابع دریافت آمار از دیتابیس
async function getDatabaseStats() {
  try {
    const totalInvoices = await CryptoInvoice.countDocuments({
      paymentType: "trx",
    });
    const paidInvoices = await CryptoInvoice.countDocuments({
      paymentType: "trx",
      status: "paid",
    });
    const pendingInvoices = await CryptoInvoice.countDocuments({
      paymentType: "trx",
      status: "unpaid",
    });
    const rejectedInvoices = await CryptoInvoice.countDocuments({
      paymentType: "trx",
      status: "rejected",
    });

    // محاسبه کل مبلغ پرداخت شده
    const paidInvoicesData = await CryptoInvoice.find({
      paymentType: "trx",
      status: "paid",
    });
    const totalPaidAmount = paidInvoicesData.reduce(
      (sum, inv) => sum + (inv.amount || 0),
      0
    );

    return {
      totalInvoices,
      paidInvoices,
      pendingInvoices,
      rejectedInvoices,
      totalPaidAmount,
    };
  } catch (error) {
    console.error("❌ Error getting database stats:", error.message);
    return {
      totalInvoices: 0,
      paidInvoices: 0,
      pendingInvoices: 0,
      rejectedInvoices: 0,
      totalPaidAmount: 0,
    };
  }
}

export default handleTrxWalletScan;
