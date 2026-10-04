// spell-checker: disable
import moment from "moment-jalaali";
import User from "../../models/User.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import formatDate from "../../utils/formatDate.js";

moment.loadPersian({ usePersianDigits: false, dialect: "persian-modern" });

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

/** Persian payment-status summary for the profile's recent-orders list. */
function paymentStatusFa(provider, record) {
  if (record.recoveryStatus === "required") return "🔔 نیاز به بررسی";
  switch (provider) {
    case "hoosh":
      if (record.status === "paid") return record.balanceCredited ? "✅ موفق" : "⏳ در حال تسویه";
      if (["expired", "cancelled"].includes(record.status)) return "🚫 لغو/منقضی";
      if (record.status === "reversed") return "↩️ بازگشت داده شد";
      return "⏳ در انتظار پرداخت";
    case "trx":
      if (record.status === "paid") return record.balanceCredited ? "✅ موفق" : "⏳ در حال تسویه";
      if (record.status === "rejected") return "❌ ناموفق";
      return "⏳ در انتظار پرداخت";
    case "bank":
      if (["confirmed", "paid"].includes(record.status)) return record.balanceCredited ? "✅ موفق" : "⏳ در حال تسویه";
      if (record.status === "rejected") return "❌ رد شده";
      return "⏳ در انتظار تأیید";
    default:
      return "⏳ در انتظار";
  }
}

const handleProfile = async (bot, chatId, userId) => {
  try {
    const user = await User.findOne({ telegramId: userId });

    if (!user || !user.phoneNumber) {
      const requestContactKeyboard = {
        reply_markup: {
          keyboard: [
            [
              {
                text: "📞 ارسال شماره من",
                request_contact: true,
              },
            ],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      };

      bot.sendMessage(
        chatId,
        "📞 لطفاً شماره تلفن خود را ارسال کنید:",
        requestContactKeyboard
      );
      return;
    }

    const phone = user.phoneNumber.startsWith("+98")
      ? user.phoneNumber.replace("+98", "0")
      : user.phoneNumber;

    const formattedDate = formatDate(user.createdAt);

    // Active services = not revoked and (no expiry known OR expiry in future).
    const now = Date.now();
    const services = Array.isArray(user.services) ? user.services : [];
    const activeServices = services.filter((service) => {
      if (service.revokedAt) return false;
      if (!service.expiresAt) return true;
      return new Date(service.expiresAt).getTime() > now;
    }).length;

    // ── Recent orders (latest 4 across all payment providers) ────────────────
    const [hooshPayments, trxPayments, bankPayments] = await Promise.all([
      HooshPayInvoice.find({ userId: Number(userId) }).sort({ createdAt: -1 }).limit(3).lean().catch(() => []),
      CryptoInvoice.find({ userId: Number(userId) }).sort({ createdAt: -1 }).limit(3).lean().catch(() => []),
      bankInvoice.find({ userId: Number(userId) }).sort({ createdAt: -1 }).limit(3).lean().catch(() => []),
    ]);
    const recent = [
      ...hooshPayments.map((r) => ({ provider: "hoosh", label: "پرداخت آنلاین", record: r })),
      ...trxPayments.map((r) => ({ provider: "trx", label: "پرداخت TRX", record: r })),
      ...bankPayments.map((r) => ({ provider: "bank", label: "کارت به کارت", record: r })),
    ]
      .sort((a, b) => new Date(b.record.createdAt || 0) - new Date(a.record.createdAt || 0))
      .slice(0, 4);

    const recentLines = recent.map(({ provider, label, record }) => {
      const amount = Number(record.amount || 0).toLocaleString("en-US");
      const date = record.createdAt ? moment(new Date(record.createdAt)).format("jYY/jMM/jDD") : "—";
      return `▫️ ${label} — <code>${amount}</code> تومان | ${paymentStatusFa(provider, record)} | ${date}`;
    });

    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

    const message = `
👤 <b>پروفایل من</b>

🆔 شناسه کاربری: <code>${user.telegramId}</code>
${displayName ? `📌 نام: <b>${escapeHtml(displayName)}</b>\n` : ""}${user.username ? `🔗 یوزرنیم: @${escapeHtml(user.username)}\n` : ""}
💰 موجودی کیف پول: <b>${user.balance.toLocaleString("en-US")} تومان</b>

📦 خدمات فعال: <b>${activeServices}</b> از ${services.length} سرویس
✅ پرداخت‌های موفق: <b>${user.successfulPayments || 0}</b>
${user.referralCode ? `🎟️ کد معرف شما: <code>${escapeHtml(user.referralCode)}</code>\n` : ""}
🧾 <b>آخرین سفارش‌ها:</b>
${recentLines.length ? recentLines.join("\n") : "▫️ سفارشی ثبت نشده است."}

📞 شماره تلفن: <code>${phone}</code>
🕒 تاریخ عضویت: <code>${formattedDate}</code>`;

    const reply_markup = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💰 افزایش موجودی", callback_data: "topup_from_profile" },
            { text: "📦 سرویس‌های من", callback_data: "my_services_from_profile" },
          ],
          [
            { text: "🎟️ اعمال کد تخفیف", callback_data: "alert_discount_code_disabled" },
          ],
        ],
      },
    };

    bot.sendMessage(chatId, message, { parse_mode: "HTML", ...reply_markup });
  } catch (err) {
    console.error("profile error:", err?.name || "Error");
    bot.sendMessage(chatId, "❌ خطایی رخ داده است. لطفاً دوباره تلاش کنید.");
  }
};

export default handleProfile;
