// spell-checker: disable
import moment from "moment-jalaali";
import User from "../../models/User.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import formatDate from "../../utils/formatDate.js";
import ensureTelegramUser from "../../services/users/ensureTelegramUser.js";
import {
  buildRecentSuccessfulPayments,
  renderProfileMessage,
  successfulPaymentQuery,
} from "../../utils/profileView.js";
import { renderUiScreen } from "../../utils/telegramUi.js";

moment.loadPersian({ usePersianDigits: false, dialect: "persian-modern" });

const profileKeyboard = {
  inline_keyboard: [
    [
      { text: "💰 افزایش موجودی", callback_data: "topup_from_profile" },
      { text: "📦 سرویس‌های من", callback_data: "my_services_from_profile" },
    ],
    [{ text: "🎟️ اعمال کد تخفیف", callback_data: "alert_discount_code_disabled" }],
    [{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }],
  ],
};

const handleProfile = async (bot, chatId, userId, { messageId, telegramUser } = {}) => {
  try {
    // Telegram's numeric user ID is the account identity. Profile viewing never
    // requests a contact, and no contact data is loaded or displayed.
    await ensureTelegramUser(telegramUser || { id: userId });
    const user = await User.findOne({ telegramId: String(userId) }).lean();
    if (!user) throw new Error("Profile account is unavailable");

    // A payment is shown as successful only after its provider's canonical
    // paid/confirmed status AND the wallet-credit ledger both say it settled.
    const [hooshPayments, trxPayments, bankPayments] = await Promise.all([
      HooshPayInvoice.find(successfulPaymentQuery("hoosh", userId))
        .sort({ createdAt: -1 }).limit(4).lean().catch(() => []),
      CryptoInvoice.find(successfulPaymentQuery("trx", userId))
        .sort({ createdAt: -1 }).limit(4).lean().catch(() => []),
      bankInvoice.find(successfulPaymentQuery("bank", userId))
        .sort({ createdAt: -1 }).limit(4).lean().catch(() => []),
    ]);
    const recentPayments = buildRecentSuccessfulPayments({
      hoosh: hooshPayments,
      trx: trxPayments,
      bank: bankPayments,
    });

    // Active services = not revoked and (no expiry known OR expiry in future).
    const now = Date.now();
    const services = Array.isArray(user.services) ? user.services : [];
    const activeServices = services.filter((service) => {
      if (service.revokedAt) return false;
      if (!service.expiresAt) return true;
      return new Date(service.expiresAt).getTime() > now;
    }).length;

    const message = renderProfileMessage({
      user,
      activeServices,
      serviceCount: services.length,
      recentPayments,
      formattedJoinDate: formatDate(user.createdAt),
      formatPaymentDate: (createdAt) => createdAt
        ? moment(new Date(createdAt)).format("jYY/jMM/jDD")
        : "—",
    });

    await renderUiScreen(
      bot,
      chatId,
      messageId,
      message,
      { parse_mode: "HTML", reply_markup: profileKeyboard },
      { step: null, support: false, supportMessageId: null }
    );
  } catch (error) {
    console.error("profile error:", error?.name || "Error");
    await renderUiScreen(
      bot,
      chatId,
      messageId,
      "❌ خطایی رخ داده است. لطفاً دوباره تلاش کنید.",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }]] } },
      { step: null, support: false, supportMessageId: null }
    ).catch(() => {});
  }
};

export default handleProfile;
