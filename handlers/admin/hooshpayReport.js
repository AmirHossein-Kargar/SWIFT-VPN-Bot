/**
 * Admin: HooshPay payment report
 * Accessible via callback_data: "admin_hooshpay_report"
 *
 * Shows:
 *  - Total invoices by status
 *  - Total amount collected
 *  - Last 5 paid invoices
 *  - Inline buttons: search by UID/order_id, resend fulfillment
 */
import HooshPayInvoice from "../../models/HooshPayInvoice.js";

const hooshpayReport = async (bot, query, _session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const [all, paid, pending, expired, cancelled, failed] = await Promise.all([
      HooshPayInvoice.countDocuments({}),
      HooshPayInvoice.countDocuments({ status: "paid" }),
      HooshPayInvoice.countDocuments({ status: "pending" }),
      HooshPayInvoice.countDocuments({ status: "expired" }),
      HooshPayInvoice.countDocuments({ status: "cancelled" }),
      HooshPayInvoice.countDocuments({ status: "failed" }),
    ]);

    const paidInvoices = await HooshPayInvoice.find({ status: "paid", fulfilled: true })
      .sort({ paidAt: -1 })
      .limit(5)
      .lean();

    const totalPaid = await HooshPayInvoice.aggregate([
      { $match: { status: "paid", fulfilled: true } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalAmount = totalPaid[0]?.total || 0;

    const unfulfilled = await HooshPayInvoice.countDocuments({ status: "paid", fulfilled: false });

    let recentLines = "";
    if (paidInvoices.length > 0) {
      recentLines = "\n\n📋 <b>آخرین پرداخت‌ها:</b>\n";
      for (const inv of paidInvoices) {
        const date = inv.paidAt ? new Date(inv.paidAt).toLocaleString("fa-IR") : "نامشخص";
        const tracking = inv.trackingCode ? ` | کد: ${inv.trackingCode}` : "";
        recentLines += `• <code>${inv.uid.slice(0, 12)}…</code> | ${inv.amount.toLocaleString()} تومان | کاربر: <code>${inv.userId}</code>${tracking} | ${date}\n`;
      }
    }

    const report =
      `🏦 <b>گزارش HooshPay</b>\n\n` +
      `📊 <b>آمار کلی:</b>\n` +
      `• کل فاکتورها: <code>${all}</code>\n` +
      `• پرداخت شده: <code>${paid}</code>\n` +
      `• در انتظار: <code>${pending}</code>\n` +
      `• منقضی: <code>${expired}</code>\n` +
      `• لغوشده: <code>${cancelled}</code>\n` +
      `• ناموفق: <code>${failed}</code>\n\n` +
      `💰 <b>جمع کل دریافتی:</b> <code>${totalAmount.toLocaleString()}</code> تومان\n` +
      (unfulfilled > 0
        ? `\n⚠️ <b>${unfulfilled} فاکتور پرداخت‌شده هنوز تسویه نشده!</b>\n`
        : "") +
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
          ...(unfulfilled > 0
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
      `❌ خطا در نمایش گزارش HooshPay:\n<code>${err.message}</code>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 تلاش مجدد", callback_data: "admin_hooshpay_report" },
              { text: "🏠 بازگشت", callback_data: "admin_back_to_panel" },
            ],
          ],
        },
      }
    );
    await bot.answerCallbackQuery(query.id, { text: "❌ خطا در گزارش", show_alert: true });
  }
};

export default hooshpayReport;
