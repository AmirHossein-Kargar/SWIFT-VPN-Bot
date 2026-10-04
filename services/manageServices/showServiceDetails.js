import User from "../../models/User.js";
import { getServiceView } from "../../services/wizardServiceStatus.js";
import formatDate from "../../utils/formatDate.js";

const HOME_BUTTON = [{ text: "🔙 بازگشت به منوی اصلی", callback_data: "buy_service_back_to_main" }];

function progressBar(percent) {
  if (percent == null || !Number.isFinite(percent)) return "";
  const filled = Math.round(Math.min(10, Math.max(0, percent / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

/**
 * Show a service's live details.
 *
 * Source of truth: the WizardXray panel for status/usage/expiry (cached for
 * WIZARD_STATUS_TTL_SECONDS). When the panel is unreachable, the user's stored
 * record is shown instead with a clear "live unavailable" notice — the bot
 * never crashes and NEVER auto-deletes a service because of a panel error.
 */
const showServiceDetails = async (bot, chatId, username, messageId) => {
  try {
    if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(username)) {
      await bot.sendMessage(chatId, "❌ شناسه سرویس نامعتبر است.");
      return;
    }

    const view = await getServiceView(username, null);
    const data = view.data;

    // Panel explicitly says the service does not exist. Offer cleanup, but
    // never delete automatically — the record is removed only with the user's
    // explicit confirmation (or admin action).
    if (view.source === "missing") {
      const messageText = `❌ سرویس <code>${escapeHtml(username)}</code> در پنل یافت نشد.\n\nاگر این سرویس را حذف کرده‌اید، می‌توانید آن را از لیست خود پاک کنید.`;
      const keyboard = {
        inline_keyboard: [
          [{ text: "🗑 حذف از لیست سرویس‌های من", callback_data: `delete_service_${username}` }],
          HOME_BUTTON,
        ],
      };
      if (messageId) {
        try {
          await bot.editMessageText(messageText, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: keyboard });
          return;
        } catch { /* fall through to send */ }
      }
      await bot.sendMessage(chatId, messageText, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    }

    // ── Live panel view ──────────────────────────────────────────────────────
    if (view.source === "live") {
      const d = data;
      const expiry = d.expireDate
        ? `${d.expireDate}${d.daysLeft != null ? ` | ${d.daysLeft} روز دیگر` : ""}`
        : "نامشخص";

      const trafficLines = [];
      if (d.totalGbText != null) trafficLines.push(`📦 حجم کل: <code>${d.totalGbText} گیگابایت</code>`);
      if (d.usedGbText != null) trafficLines.push(`📥 حجم مصرفی: <code>${d.usedGbText} گیگابایت</code>`);
      if (d.remainingGbText != null) trafficLines.push(`📤 حجم باقی‌مانده: <code>${d.remainingGbText} گیگابایت</code>`);
      if (d.usagePercent != null) trafficLines.push(`${progressBar(d.usagePercent)} <code>${d.usagePercent}%</code>`);

      const message = `#⃣ کد سرویس: <code>${escapeHtml(d.username)}</code>

▫️ وضعیت سرویس: <code>${d.statusLabel}</code>

${trafficLines.join("\n") || "📦 حجم: نامشخص"}

📅 تاریخ انقضا: <code>${expiry}</code>

🔗 لینک اتصال (Subscription):
<code>${escapeHtml(d.smartLink || "—")}</code>

🟢 اطلاعات لحظه‌ای از پنل
▫️ یکی از گزینه‌های زیر را انتخاب کنید.`;
      await sendDetailsMessage(bot, chatId, messageId, message, d.username, d.status);
      return;
    }

    // ── Cached fallback (panel unreachable) ──────────────────────────────────
    const record = view.record || {};
    const expiry = record.expiresAt
      ? `${formatDate(record.expiresAt)}${record.expiresAt ? ` | ${Math.ceil((new Date(record.expiresAt).getTime() - Date.now()) / 86400000)} روز دیگر` : ""}`
      : "نامشخص";

    const message = `#⃣ کد سرویس: <code>${escapeHtml(username)}</code>

▫️ وضعیت سرویس: <code>نامشخص</code>

${record.trafficGb != null ? `📦 حجم کل: <code>${record.trafficGb} گیگابایت</code>\n` : ""}📅 تاریخ انقضا: <code>${expiry}</code>

${record.sub_link ? `🔗 لینک اتصال (Subscription):\n<code>${escapeHtml(record.sub_link)}</code>\n\n` : ""}🟡 اطلاعات لحظه‌ای پنل در دسترس نیست؛ اطلاعات ذخیره‌شده نمایش داده می‌شود.
▫️ یکی از گزینه‌های زیر را انتخاب کنید.`;
    await sendDetailsMessage(bot, chatId, messageId, message, username, null);
  } catch (error) {
    console.error("showServiceDetails error:", error?.name || "Error");
    await bot.sendMessage(chatId, "❌ خطایی رخ داد، لطفا دوباره تلاش کنید.");
  }
};

async function sendDetailsMessage(bot, chatId, messageId, message, username, status) {
  const inlineKeyboard = [
    [{ text: "‼️چجوری به سرویس متصل بشم‼️", url: "https://t.me/swift_shield/9" }],
  ];

  if (status !== "limited") {
    inlineKeyboard.push([
      { text: "🛑 تغییر لینک 🛑", callback_data: `change_link_${username}` },
      { text: "⏳ افزایش زمان", callback_data: `extend_service_${username}` },
      { text: "📦 افزایش حجم", callback_data: `extend_data_${username}` },
    ]);
  } else {
    inlineKeyboard.push([
      { text: "⏳ افزایش زمان", callback_data: `extend_service_${username}` },
      { text: "📦 افزایش حجم", callback_data: `extend_data_${username}` },
    ]);
  }

  inlineKeyboard.push([
    { text: "🗑 حذف سرویس", callback_data: `delete_service_${username}` },
    { text: "◽️دریافت QRCode", callback_data: `qrcode_${username}` },
  ]);

  if (status !== "limited") {
    inlineKeyboard.push([
      {
        text: status === "active" ? "🚫 غیر فعال کردن سرویس" : "✅ فعال کردن سرویس",
        callback_data: `deactivate_service_${username}`,
      },
    ]);
  }

  inlineKeyboard.push([{ text: "🔄 بروزرسانی وضعیت", callback_data: `show_service_${username}` }]);
  inlineKeyboard.push(HOME_BUTTON);

  if (messageId) {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch { /* message deletion failed, continue */ }
  }
  await bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

// Kept for backward compatibility with any external callers.
const removeServiceFromDatabase = async (username) => {
  const user = await User.findOne({ "services.username": username });
  if (!user) return { success: false, message: "کاربر یافت نشد" };
  const newTotal = Math.max(0, (user.totalServices || 0) - 1);
  await User.updateOne(
    { telegramId: user.telegramId },
    { $pull: { services: { username } }, $set: { totalServices: newTotal } }
  );
  return { success: true, message: `سرویس ${username} از لیست شما حذف شد.` };
};

export { removeServiceFromDatabase };
export default showServiceDetails;
