// spell-checker: disable
import moment from "moment-jalaali";
import User from "../../models/User.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import formatDate from "../../utils/formatDate.js";
import escapeHtml from "../../utils/escapeHtml.js";
import {
  eligibleRecentOrderStatusQuery,
  isHiddenRecentOrderStatus,
  normalizePaymentStatus,
} from "../../services/payments/status.js";

moment.loadPersian({ usePersianDigits: false, dialect: "persian-modern" });

const EMPTY_RECENT_ORDERS = "▫️ سفارش واجد شرایطی برای نمایش وجود ندارد.";

/** Persian payment-status summary for the profile's recent-orders list. */
export function paymentStatusFa(provider, record) {
  if (record.recoveryStatus === "required") return "🔔 نیاز به بررسی";
  const status = normalizePaymentStatus(provider, record.status);
  if (status === "paid") return record.balanceCredited ? "✅ موفق" : "⏳ در حال تسویه";
  if (status === "partially_paid") return "⚠️ پرداخت ناقص";
  if (status === "failed") return "❌ ناموفق";
  if (status === "reversed") return "↩️ بازگشت داده شد";
  if (provider === "bank") return "⏳ در انتظار تأیید";
  return "⏳ در انتظار پرداخت";
}

function queryWithVisibleStatus(extraExcluded = []) {
  const status = eligibleRecentOrderStatusQuery();
  return extraExcluded.length
    ? { ...status, $nin: [...status.$nin, ...extraExcluded] }
    : status;
}

async function recent(model, query, limit = 4) {
  return model.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * Load eligible orders before sorting/limiting the cross-provider result. This
 * intentionally filters at MongoDB rather than fetching private/irrelevant rows
 * and hiding their labels in the rendered message.
 */
export async function loadRecentProfileOrders(userId, {
  hooshModel = HooshPayInvoice,
  nowPaymentsModel = NowPaymentsInvoice,
  cryptoModel = CryptoInvoice,
  bankModel = bankInvoice,
} = {}) {
  const numericUserId = Number(userId);
  const visible = queryWithVisibleStatus();
  const [hooshPayments, nowPayments, trxPayments, bankPayments] = await Promise.all([
    recent(hooshModel, {
      userId: numericUserId,
      status: visible,
      creationStatus: { $in: [null, "created"] },
    }),
    recent(nowPaymentsModel, {
      userId: numericUserId,
      status: queryWithVisibleStatus(["creation_failed"]),
    }),
    recent(cryptoModel, { userId: numericUserId, status: visible }),
    recent(bankModel, { userId: numericUserId, status: visible }),
  ]);

  return [
    ...hooshPayments.map((record) => ({ provider: "hoosh", label: "پرداخت آنلاین", record })),
    ...nowPayments.map((record) => ({ provider: "nowpayments", label: "پرداخت ترون", record })),
    ...trxPayments.map((record) => ({ provider: "trx", label: "پرداخت TRX", record })),
    ...bankPayments.map((record) => ({ provider: "bank", label: "کارت به کارت", record })),
  ]
    // Defensive legacy guard: the database predicate is authoritative, while
    // this protects output if a test adapter or old non-Mongo store ignores it.
    .filter(({ provider, record }) => !isHiddenRecentOrderStatus(provider, record.status))
    .sort((a, b) => new Date(b.record.createdAt || 0) - new Date(a.record.createdAt || 0))
    .slice(0, 4);
}

function paymentAmount(provider, record) {
  return provider === "nowpayments" ? Number(record.amountToman || 0) : Number(record.amount || 0);
}

const handleProfile = async (bot, chatId, userId, dependencies = {}) => {
  const userModel = dependencies.userModel || User;
  try {
    const user = await userModel.findOne({ telegramId: String(userId) });
    if (!user) {
      await bot.sendMessage(chatId, "❌ اطلاعات حساب شما هنوز ثبت نشده است. لطفاً دستور /start را ارسال کنید.");
      return;
    }

    const formattedDate = formatDate(user.createdAt);

    // Active services = not revoked and (no expiry known OR expiry in future).
    const now = Date.now();
    const services = Array.isArray(user.services) ? user.services : [];
    const activeServices = services.filter((service) => {
      if (service.revokedAt) return false;
      if (!service.expiresAt) return true;
      return new Date(service.expiresAt).getTime() > now;
    }).length;

    const recentOrders = await loadRecentProfileOrders(userId, dependencies);
    const recentLines = recentOrders.map(({ provider, label, record }) => {
      const amount = paymentAmount(provider, record).toLocaleString("en-US");
      const date = record.createdAt ? moment(new Date(record.createdAt)).format("jYY/jMM/jDD") : "—";
      return `▫️ ${label} — <code>${amount}</code> تومان | ${paymentStatusFa(provider, record)} | ${date}`;
    });

    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    const balance = Number(user.balance || 0).toLocaleString("en-US");

    const message = `
👤 <b>پروفایل من</b>

🆔 شناسه کاربری: <code>${escapeHtml(user.telegramId)}</code>
${displayName ? `📌 نام: <b>${escapeHtml(displayName)}</b>\n` : ""}${user.username ? `🔗 یوزرنیم: @${escapeHtml(user.username)}\n` : ""}
💰 موجودی کیف پول: <b>${balance} تومان</b>

📦 خدمات فعال: <b>${activeServices}</b> از ${services.length} سرویس
✅ پرداخت‌های موفق: <b>${user.successfulPayments || 0}</b>
${user.referralCode ? `🎟️ کد معرف شما: <code>${escapeHtml(user.referralCode)}</code>\n` : ""}
🧾 <b>آخرین سفارش‌ها:</b>
${recentLines.length ? recentLines.join("\n") : EMPTY_RECENT_ORDERS}

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

    await bot.sendMessage(chatId, message, { parse_mode: "HTML", ...reply_markup });
  } catch (err) {
    console.error("profile error:", err?.name || "Error");
    await bot.sendMessage(chatId, "❌ خطایی رخ داده است. لطفاً دوباره تلاش کنید.");
  }
};

export { EMPTY_RECENT_ORDERS };
export default handleProfile;
