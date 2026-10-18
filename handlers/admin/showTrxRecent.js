import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import trxScanner from "../../services/trxWalletScanner.js";
import { TRXPrice } from "../../api/TRXPrice.js";
import { USDPrice } from "../../api/USDPrice.js";

const showTrxRecent = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    // ارسال پیام در حال بارگذاری
    await bot.editMessageText(
      "🕒 در حال دریافت تراکنش‌های اخیر TRX...\n\n⏳ لطفاً صبر کنید...",
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 بارگذاری مجدد",
                callback_data: "admin_trx_recent",
              },
            ],
          ],
        },
      }
    );

    // دریافت تراکنش‌های اخیر
    const transactions = await trxScanner.fetchTransactions();

    // دریافت قیمت‌ها
    const trxPrice = await TRXPrice();
    const usdPrice = await USDPrice();

    const lines = [];
    lines.push("🕒 <b>تراکنش‌های اخیر TRX:</b>");
    lines.push("");

    if (!transactions || transactions.length === 0) {
      lines.push("📭 هیچ تراکنش TRX ورودی جدیدی یافت نشد.");
      lines.push("💡 این طبیعی است اگر تراکنش جدیدی انجام نشده باشد.");
    } else {
      lines.push(
        `📊 <b>تعداد کل تراکنش‌ها:</b> <code>${transactions.length}</code>`
      );
      lines.push("");

      // نمایش 10 تراکنش آخر
      const recentTxs = transactions.slice(0, 10);
      lines.push("🔍 <b>آخرین تراکنش‌ها:</b>");

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

        // محاسبه ارزش دلاری
        let usdValue = "";
        if (trxPrice) {
          const usdAmount = amount * trxPrice;
          usdValue = ` ($${usdAmount.toFixed(2)})`;
        }

        // محاسبه ارزش تومانی
        let tomanValue = "";
        if (trxPrice && usdPrice) {
          const usdAmount = amount * trxPrice;
          const tomanAmount = usdAmount * usdPrice;
          tomanValue = ` (${tomanAmount.toLocaleString()} تومان)`;
        }

        lines.push(
          `${idx + 1}. ${status} <code>${amount.toFixed(
            6
          )}</code> TRX${usdValue}${tomanValue}`
        );
        lines.push(`   🔗 <code>${hash}</code>`);

        // اطلاعات اضافی تراکنش
        if (tx.timestamp) {
          const date = new Date(tx.timestamp).toLocaleString("fa-IR");
          lines.push(`   ⏰ ${date}`);
        }

        if (tx.fromAddress) {
          const fromHash =
            tx.fromAddress.substring(0, 8) +
            "..." +
            tx.fromAddress.substring(tx.fromAddress.length - 8);
          lines.push(`   👤 از: <code>${fromHash}</code>`);
        }

        lines.push("");
      });

      // آمار خلاصه
      const confirmedCount = transactions.filter(
        (tx) => tx.confirmed && tx.contractRet === "SUCCESS"
      ).length;
      const pendingCount = transactions.filter(
        (tx) => !tx.confirmed && !tx.revert
      ).length;
      const revertedCount = transactions.filter((tx) => tx.revert).length;

      lines.push("📊 <b>آمار وضعیت:</b>");
      lines.push(`• تایید شده: <code>${confirmedCount}</code>`);
      lines.push(`• در انتظار: <code>${pendingCount}</code>`);
      lines.push(`• رد شده: <code>${revertedCount}</code>`);
      lines.push("");

      // محاسبه کل مبلغ
      const totalAmount = transactions.reduce(
        (sum, tx) => sum + parseFloat(tx.amount) / 1000000,
        0
      );
      lines.push("💰 <b>کل مبالغ:</b>");
      lines.push(`• کل TRX: <code>${totalAmount.toFixed(6)}</code> TRX`);

      if (trxPrice) {
        const totalUSD = totalAmount * trxPrice;
        lines.push(`• کل USD: <code>$${totalUSD.toFixed(2)}</code>`);

        if (usdPrice) {
          const totalToman = totalUSD * usdPrice;
          lines.push(
            `• کل تومان: <code>${totalToman.toLocaleString()}</code> تومان`
          );
        }
      }
      lines.push("");

      // اطلاعات قیمت‌ها
      if (trxPrice || usdPrice) {
        lines.push("💱 <b>قیمت‌های فعلی:</b>");
        if (trxPrice) {
          lines.push(`• قیمت TRX: <code>$${trxPrice.toFixed(6)}</code>`);
        }
        if (usdPrice) {
          lines.push(
            `• نرخ USD: <code>${usdPrice.toLocaleString()}</code> تومان`
          );
        }
        lines.push("");
      }
    }

    // بخش وضعیت اسکن
    lines.push("🔍 <b>وضعیت اسکن:</b>");
    lines.push(`• آخرین به‌روزرسانی: ${new Date().toLocaleString("fa-IR")}`);
    lines.push(
      `• وضعیت: ${trxScanner.isScanning ? "⏳ در حال اسکن" : "✅ آماده"}`
    );
    lines.push(
      `• اسکن خودکار: ${trxScanner.scanInterval ? "🟢 فعال" : "🔴 غیرفعال"}`
    );

    const resultText = lines.join("\n");

    // ارسال نتایج
    await bot.editMessageText(resultText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 بارگذاری مجدد", callback_data: "admin_trx_recent" },
            { text: "🔍 اسکن کامل", callback_data: "admin_scan_trx_wallet" },
          ],
          [
            { text: "💰 موجودی", callback_data: "admin_trx_balance" },
            { text: "📊 آمار کامل", callback_data: "admin_trx_stats" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
        ],
      },
    });

    // پاسخ به callback query
    await bot.answerCallbackQuery(query.id, {
      text: "✅ تراکنش‌های اخیر TRX دریافت شد",
    });
  } catch (error) {
    console.error("❌ Error showing TRX recent transactions:", error.message);

    // ارسال پیام خطا
    await bot.editMessageText(
      `❌ خطا در دریافت تراکنش‌های اخیر TRX:\n\n<code>${escapeErrorMessage(error)}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 تلاش مجدد",
                callback_data: "admin_trx_recent",
              },
              { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
            ],
          ],
        },
      }
    );

    // پاسخ به callback query
    await bot.answerCallbackQuery(query.id, {
      text: "❌ خطا در دریافت تراکنش‌های اخیر TRX",
      show_alert: true,
    });
  }
};

export default showTrxRecent;
