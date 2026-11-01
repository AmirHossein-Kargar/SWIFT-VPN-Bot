// spell-checker: disable
import moment from "moment-jalaali";
import User from "../../models/User.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import escapeHtml from "../../utils/escapeHtml.js";
import {
  activeWindowQuery,
  eligibleRecentOrderStatusQuery,
  isVisibleRecentOrder,
  normalizePaymentStatus,
} from "../../services/payments/status.js";
import { renderInterface } from "../../services/messaging/messageManager.js";

moment.loadPersian({ usePersianDigits: false, dialect: "persian-modern" });

const RECENT_ORDER_LIMIT = 5;
// Per-provider over-fetch so collapsing duplicate pending rows can still fill the list.
const PROVIDER_FETCH_LIMIT = 10;
const SEPARATOR = "┄┄┄┄┄┄┄┄┄┄┄┄┄┄";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

const PROVIDER_LABELS = Object.freeze({
  hoosh: "پرداخت آنلاین",
  nowpayments: "پرداخت با کریپتو",
  trx: "پرداخت TRX",
  bank: "کارت به کارت",
});

/** Persian digits for display text. Copyable identifiers stay Latin. */
export function toPersianDigits(value) {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

export function formatToman(value) {
  const number = Number(value);
  return `${toPersianDigits((Number.isFinite(number) ? number : 0).toLocaleString("en-US").replaceAll(",", "٬"))} تومان`;
}

export function formatJalaliDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  return toPersianDigits(moment(date).format("jYYYY/jMM/jDD"));
}

/** Persian payment-status summary for a recent-orders list. */
export function paymentStatusFa(provider, record) {
  if (record.recoveryStatus === "required") return "🔔 در حال بررسی";
  const status = normalizePaymentStatus(provider, record.status);
  if (status === "paid") return record.balanceCredited ? "✅ موفق" : "⏳ در حال تسویه";
  if (status === "partially_paid") return "⚠️ پرداخت ناقص";
  if (status === "reversed") return "↩️ بازگشت داده شد";
  if (provider === "bank") return "⏳ در انتظار تأیید";
  return "⏳ در انتظار پرداخت";
}

function visibleQuery(provider, userId, extra = {}, now = Date.now()) {
  return {
    userId,
    status: eligibleRecentOrderStatusQuery(),
    ...activeWindowQuery(provider, now),
    ...extra,
  };
}

async function recent(model, query) {
  return model.find(query).sort({ createdAt: -1, _id: -1 }).limit(PROVIDER_FETCH_LIMIT).lean();
}

function orderKey(provider, record) {
  const id = record.uid || record.orderId || record.paymentId || record.invoiceId || record._id;
  return id == null ? null : `${provider}:${id}`;
}

/**
 * Load eligible orders before sorting/limiting the cross-provider result. The
 * status/age predicate runs in MongoDB, so cancelled, expired, failed and
 * abandoned rows are never fetched; the in-memory pass below only repeats the
 * same policy for stores that ignore the predicate and collapses duplicates.
 * Historical records are untouched.
 *
 * No caller since the profile message dropped its recent-orders section; kept
 * with its tests.
 */
export async function loadRecentProfileOrders(userId, {
  hooshModel = HooshPayInvoice,
  nowPaymentsModel = NowPaymentsInvoice,
  cryptoModel = CryptoInvoice,
  bankModel = bankInvoice,
  now = Date.now(),
} = {}) {
  const numericUserId = Number(userId);
  const [hooshPayments, nowPayments, trxPayments, bankPayments] = await Promise.all([
    recent(hooshModel, visibleQuery("hoosh", numericUserId, { creationStatus: { $in: [null, "created"] } }, now)),
    recent(nowPaymentsModel, visibleQuery("nowpayments", numericUserId, {}, now)),
    recent(cryptoModel, visibleQuery("trx", numericUserId, {}, now)),
    recent(bankModel, visibleQuery("bank", numericUserId, {}, now)),
  ]);

  const candidates = [
    ...hooshPayments.map((record) => ({ provider: "hoosh", label: PROVIDER_LABELS.hoosh, record })),
    ...nowPayments.map((record) => ({ provider: "nowpayments", label: PROVIDER_LABELS.nowpayments, record })),
    ...trxPayments.map((record) => ({ provider: "trx", label: PROVIDER_LABELS.trx, record })),
    ...bankPayments.map((record) => ({ provider: "bank", label: PROVIDER_LABELS.bank, record })),
  ]
    .filter(({ provider, record }) => isVisibleRecentOrder(provider, record, now))
    .sort((a, b) => {
      const delta = new Date(b.record.createdAt || 0) - new Date(a.record.createdAt || 0);
      return delta || String(orderKey(b.provider, b.record)).localeCompare(String(orderKey(a.provider, a.record)));
    });

  const seen = new Set();
  const pendingProviders = new Set();
  const result = [];
  for (const item of candidates) {
    const key = orderKey(item.provider, item.record);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    // Repeated attempts leave several open invoices; only the newest open one
    // per provider is meaningful to the customer.
    if (normalizePaymentStatus(item.provider, item.record.status) === "pending" && item.record.recoveryStatus !== "required") {
      if (pendingProviders.has(item.provider)) continue;
      pendingProviders.add(item.provider);
    }
    result.push(item);
    if (result.length === RECENT_ORDER_LIMIT) break;
  }
  return result;
}

/**
 * Pure renderer so the layout can be tested without Telegram or MongoDB. Every
 * value shares a line with its Persian label: a line holding only a Latin code
 * or a bare date would lose the message's right-to-left alignment.
 */
export function renderProfileMessage({ user }) {
  return [
    "👤 <b>پروفایل من</b>",
    SEPARATOR,
    "",
    `💰 موجودی کیف پول: <b>${formatToman(user.balance)}</b>`,
    `📅 تاریخ عضویت: <b>${formatJalaliDate(user.createdAt)}</b>`,
    ...(user.referralCode
      ? [
        "",
        "🎁 <b>دعوت از دوستان</b>",
        `کد معرف شما: <code>${escapeHtml(user.referralCode)}</code>`,
        "<i>برای کپی، روی کد بزنید.</i>",
      ]
      : []),
  ].join("\n");
}

const handleProfile = async (bot, chatId, userId, dependencies = {}) => {
  const userModel = dependencies.userModel || User;
  try {
    const user = await userModel.findOne({ telegramId: String(userId) });
    if (!user) {
      await renderInterface(bot, {
        chatId,
        text: "❌ اطلاعات حساب شما هنوز ثبت نشده است. لطفاً دستور /start را ارسال کنید.",
        messageId: dependencies.messageId,
      });
      return;
    }

    const message = renderProfileMessage({ user });

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
          [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
        ],
      },
    };

    // Edits the caller's screen in place (e.g. navigating back from the
    // discount-disabled notice) instead of sending a new message every time;
    // falls back to a fresh send on its own if no editable message is known.
    await renderInterface(bot, {
      chatId,
      text: message,
      options: { parse_mode: "HTML", ...reply_markup },
      messageId: dependencies.messageId,
    });
  } catch (err) {
    console.error("profile error:", err?.name || "Error");
    await renderInterface(bot, {
      chatId,
      text: "❌ خطایی رخ داده است. لطفاً دوباره تلاش کنید.",
      messageId: dependencies.messageId,
    });
  }
};

export default handleProfile;
