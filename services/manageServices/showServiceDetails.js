import User from "../../models/User.js";
import { getServiceView } from "../../services/wizardServiceStatus.js";
import formatDate from "../../utils/formatDate.js";
import escapeHtml from "../../utils/escapeHtml.js";
import { renderInterface } from "../messaging/messageManager.js";
import { trafficTextFa } from "../../utils/serviceTerms.js";

const HOME_BUTTON = [{ text: "🔙 بازگشت به منوی اصلی", callback_data: "buy_service_back_to_main" }];
/** The on/off switch only exists for these: the others stopped for a reason a switch cannot undo honestly. */
const SWITCHABLE = new Set(["active", "disabled"]);

function formatDaysLeft(daysLeft) {
  if (daysLeft <= 0) return "منقضی شده";
  return `${Math.ceil(daysLeft)} روز دیگر`;
}

function progressBar(percent) {
  if (percent == null || !Number.isFinite(percent)) return "";
  const filled = Math.round(Math.min(10, Math.max(0, percent / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
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
      await renderInterface(bot, {
        chatId,
        text: "❌ شناسه سرویس نامعتبر است.",
        options: { reply_markup: { inline_keyboard: [HOME_BUTTON] } },
        messageId,
      });
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
      await renderInterface(bot, {
        chatId,
        text: messageText,
        options: { parse_mode: "HTML", reply_markup: keyboard },
        messageId,
      });
      return;
    }

    // ── The panel's answer, live or from its own stored copy ─────────────────
    if (view.source === "live" || view.source === "stale") {
      const d = data;
      const expiry = d.expireDate
        ? `${d.expireDate}${d.daysLeft != null ? ` | ${formatDaysLeft(d.daysLeft)}` : ""}`
        : "نامشخص";

      const trafficLines = [];
      // Unlimited traffic has no total and no remainder to show: a "0" here would read as an exhausted service. It can
      // still expire, so the expiry line below stays.
      if (d.unlimited) trafficLines.push("📦 حجم کل: <code>نامحدود ♾</code>");
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

${view.source === "live" ? "🟢 اطلاعات لحظه‌ای از پنل" : "🟡 سرور لحظه‌ای پاسخ نداد؛ آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود."}
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

${record.trafficGb != null ? `📦 حجم کل: <code>${trafficTextFa(record.trafficGb)}</code>\n` : ""}📅 تاریخ انقضا: <code>${expiry}</code>

${record.sub_link ? `🔗 لینک اتصال (Subscription):\n<code>${escapeHtml(record.sub_link)}</code>\n\n` : ""}🟡 اطلاعات لحظه‌ای پنل در دسترس نیست؛ اطلاعات ذخیره‌شده نمایش داده می‌شود.
▫️ یکی از گزینه‌های زیر را انتخاب کنید.`;
    await sendDetailsMessage(bot, chatId, messageId, message, username, null);
  } catch (error) {
    console.error("showServiceDetails error:", error?.name || "Error");
    await renderInterface(bot, {
      chatId,
      text: "❌ خطایی رخ داد، لطفا دوباره تلاش کنید.",
      options: { reply_markup: { inline_keyboard: [HOME_BUTTON] } },
      messageId,
    });
  }
};

/** Exported so the edit-in-place/fallback-cleanup logic can be tested in
 * isolation, without the WizardXray panel or MongoDB (see showServiceDetails,
 * which is what actually builds `message`/`username`/`status` in production). */
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

  if (SWITCHABLE.has(status)) {
    inlineKeyboard.push([
      {
        text: status === "active" ? "🚫 غیر فعال کردن سرویس" : "✅ فعال کردن سرویس",
        callback_data: `deactivate_service_${username}`,
      },
    ]);
  }

  inlineKeyboard.push([{ text: "🔄 بروزرسانی وضعیت", callback_data: `show_service_${username}` }]);
  inlineKeyboard.push(HOME_BUTTON);

  const result = await renderInterface(bot, {
    chatId,
    text: message,
    options: { parse_mode: "HTML", reply_markup: { inline_keyboard: inlineKeyboard } },
    messageId,
  });

  // renderInterface only edits or sends, never deletes. Editing is impossible
  // when the caller's screen is currently a QR-code photo (editMessageText
  // cannot turn a photo into text) — in that case, and only then, a fresh
  // message was sent, so clean up the now-stale photo ourselves, exactly as
  // this screen always did before it could be edited in place.
  if (result.sent && messageId && messageId !== result.messageId) {
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  }
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

export { removeServiceFromDatabase, sendDetailsMessage };
export default showServiceDetails;
