import { randomUUID } from "node:crypto";
import User from "../models/User.js";
import { getTestServiceMessage, guideButtons } from "../messages/staticMessages.js";
import { createTestService as createTestServiceApi } from "../api/wizardApi.js";
import ensureTelegramUser from "./users/ensureTelegramUser.js";
import keyboard from "../keyboards/mainKeyboard.js";
import { renderUiScreen } from "../utils/telegramUi.js";

const NOTIFICATION_CLAIM_MS = 5 * 60_000;
const RECOVERY_STALE_MS = 5 * 60_000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "test-service", level, message, ...meta })
  );
}

async function notifyTestServiceOnce(user, bot) {
  if (!user?.testServiceNotificationPending || !bot?.sendPhoto) return false;
  const now = new Date();
  const stale = new Date(now.getTime() - NOTIFICATION_CLAIM_MS);
  const claimed = await User.findOneAndUpdate(
    {
      telegramId: String(user.telegramId),
      testServiceAttemptId: user.testServiceAttemptId,
      testServiceStatus: "completed",
      testServiceNotificationPending: true,
      $or: [
        { testServiceNotificationClaimedAt: null },
        { testServiceNotificationClaimedAt: { $lt: stale } },
      ],
    },
    { $set: { testServiceNotificationClaimedAt: now } },
    { new: true }
  );
  if (!claimed) return false;

  try {
    const smartLink = claimed.testServiceHash
      ? `https://iranisystem.com/bot/sub/?hash=${encodeURIComponent(claimed.testServiceHash)}`
      : claimed.testServiceLink || "";
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(smartLink)}&size=200x200&margin=20`;
    const message = getTestServiceMessage({
      maxUser: 1,
      maxUsageMB: 2,
      smartLink: escapeHtml(smartLink),
      singleLink: escapeHtml(claimed.testServiceSingleLink),
      username: escapeHtml(claimed.testServiceUsername),
    });
    await bot.sendPhoto(String(claimed.telegramId), qrUrl, {
      caption: `🎉 <b>سرویس تست یک‌ روزه شما فعال شد!</b>\n\n${message}`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: guideButtons.reply_markup,
    });
    await User.findOneAndUpdate(
      {
        telegramId: String(claimed.telegramId),
        testServiceAttemptId: claimed.testServiceAttemptId,
        testServiceNotificationClaimedAt: now,
        testServiceNotificationPending: true,
      },
      {
        $set: { testServiceNotificationPending: false, testServiceNotifiedAt: new Date() },
        $unset: { testServiceNotificationClaimedAt: 1 },
      }
    );
    return true;
  } catch (error) {
    log("warn", "Test service delivery notification failed", {
      attemptId: claimed.testServiceAttemptId,
      errorType: error?.name || "TelegramError",
    });
    return false;
  }
}

async function alertAdmin(user, bot, reason) {
  const groupId = process.env.GROUP_ID;
  if (!groupId || !bot?.sendMessage) return;
  try {
    await bot.sendMessage(
      groupId,
      `🚨 <b>ساخت سرویس تست نیاز به بررسی دستی دارد</b>\n\n` +
        `کاربر: <code>${escapeHtml(user.telegramId)}</code>\n` +
        `شناسه تلاش: <code>${escapeHtml(user.testServiceAttemptId)}</code>\n` +
        `علت: <code>${escapeHtml(reason)}</code>\n\n` +
        `از اجرای مجدد درخواست ساخت در پنل خودداری کنید تا وضعیت بررسی شود.`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    log("error", "Test service admin alert failed", {
      attemptId: user.testServiceAttemptId,
      errorType: error?.name || "TelegramError",
    });
  }
}

const createTestService = async (bot, msg, { uiMessageId } = {}) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  let currentUiMessageId = uiMessageId;
  const showStatus = async (text, { busy = false } = {}) => {
    const reply_markup = busy
      ? { inline_keyboard: [] }
      : keyboard.reply_markup;
    if (currentUiMessageId == null) {
      const sent = await bot.sendMessage(chatId, text, { reply_markup }).catch(() => null);
      if (sent?.message_id != null) currentUiMessageId = sent.message_id;
      return sent;
    }
    try {
      const rendered = await renderUiScreen(
        bot,
        chatId,
        currentUiMessageId,
        text,
        { reply_markup },
        { step: null, support: false, supportMessageId: null }
      );
      if (rendered?.message_id != null) currentUiMessageId = rendered.message_id;
      return rendered;
    } catch {
      return null;
    }
  };

  await showStatus("⏳ در حال آماده‌سازی سرویس تست ...", { busy: true });
  try {
    await ensureTelegramUser(msg.from);
  } catch (error) {
    log("error", "Could not load test-service account", { errorType: error?.name || "DatabaseError" });
    await showStatus("❌ خطا در ارتباط با پایگاه داده. لطفاً بعداً تلاش کنید.");
    return;
  }

  const attemptId = randomUUID();
  let user;
  try {
    user = await User.findOneAndUpdate(
      {
        telegramId: userId,
        hasReceivedTest: { $ne: true },
        testServiceStatus: { $nin: ["provisioning", "manual_review", "completed"] },
      },
      {
        $set: {
          hasReceivedTest: true,
          testServiceAttemptId: attemptId,
          testServiceStatus: "provisioning",
          testServiceStartedAt: new Date(),
          testServiceNotificationPending: false,
        },
        $unset: {
          testServiceUsername: 1,
          testServiceHash: 1,
          testServiceLink: 1,
          testServiceSingleLink: 1,
        },
      },
      { new: true }
    );
  } catch (error) {
    log("error", "Could not claim test-service attempt", { errorType: error?.name || "DatabaseError" });
    await showStatus("❌ درخواست در حال حاضر ثبت نشد. لطفاً بعداً تلاش کنید.");
    return;
  }

  if (!user) {
    const existing = await User.findOne({ telegramId: userId }).select("hasReceivedTest testServiceStatus").lean();
    if (existing?.hasReceivedTest || existing?.testServiceStatus === "completed") {
      await showStatus("⚠️ شما قبلاً این سرویس را دریافت کرده‌اید.");
    } else if (["provisioning", "manual_review"].includes(existing?.testServiceStatus)) {
      await showStatus("⏳ درخواست قبلی شما هنوز در حال بررسی است؛ لطفاً برای جلوگیری از ساخت تکراری با پشتیبانی تماس بگیرید.");
    } else {
      await showStatus("❌ درخواست در حال حاضر ثبت نشد. لطفاً دوباره تلاش کنید.");
    }
    return;
  }

  let panelResponseReceived = false;
  try {
    await showStatus("⏳ در حال ساخت سرویس ...", { busy: true });
    const data = await createTestServiceApi();
    panelResponseReceived = true;
    const result = data.result;
    const hash = typeof result.hash === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(result.hash) ? result.hash : null;
    const serviceLink = typeof result.sub_link === "string" && result.sub_link.length <= 4096 ? result.sub_link : null;
    const singleLink = Array.isArray(result.tak_links) && typeof result.tak_links[0] === "string" && result.tak_links[0].length <= 4096 ? result.tak_links[0] : "";

    const updated = await User.findOneAndUpdate(
      { telegramId: userId, testServiceAttemptId: attemptId, testServiceStatus: "provisioning" },
      {
        $set: {
          hasReceivedTest: true,
          testServiceStatus: "completed",
          testServiceUsername: result.username,
          testServiceHash: hash,
          testServiceLink: serviceLink,
          testServiceSingleLink: singleLink,
          testServiceNotificationPending: true,
        },
        $push: { services: { username: result.username, purchaseId: attemptId } },
        $addToSet: { completedPurchaseIds: attemptId },
        $inc: { totalServices: 1 },
      },
      { new: true }
    );
    if (!updated) throw new Error("Test-service result could not be committed to the owner account");

    const delivered = await notifyTestServiceOnce(updated, bot);
    await showStatus(
      delivered
        ? "✅ سرویس تست با موفقیت ساخته شد؛ جزئیات اتصال در پیام سرویس ارسال شد."
        : "✅ سرویس ساخته و به حساب شما اضافه شد، اما ارسال لینک با تأخیر روبه‌رو شد. کمی بعد دوباره بررسی کنید."
    );
  } catch (error) {
    const current = await User.findOne({ telegramId: userId, testServiceAttemptId: attemptId }).lean().catch(() => null);

    if (error?.ambiguous || (panelResponseReceived && current?.testServiceStatus !== "completed")) {
      const uncertain = await User.findOneAndUpdate(
        { telegramId: userId, testServiceAttemptId: attemptId, testServiceStatus: "provisioning" },
        { $set: { testServiceStatus: "manual_review" } },
        { new: true }
      ).catch(() => null);
      log("error", "Test service panel result is ambiguous; duplicate request blocked", {
        attemptId,
        errorType: error?.name || "PanelError",
        code: error?.code || "UNKNOWN",
      });
      if (uncertain) await alertAdmin(uncertain, bot, error.code || "PANEL_RESULT_UNKNOWN");
      await showStatus("⏳ وضعیت ساخت سرویس تست از پنل مشخص نیست. برای جلوگیری از ساخت تکراری، درخواست شما تا بررسی پشتیبانی متوقف شده است.");
    } else if (current?.testServiceStatus === "completed") {
      const delivered = await notifyTestServiceOnce(current, bot).catch(() => false);
      await showStatus(
        delivered
          ? "✅ سرویس تست شما آماده است؛ جزئیات اتصال در پیام سرویس ارسال شد."
          : "✅ سرویس تست ساخته و به حساب شما اضافه شد؛ ارسال لینک در حال بازیابی است."
      );
    } else if (current?.testServiceStatus === "provisioning") {
      await User.updateOne(
        { telegramId: userId, testServiceAttemptId: attemptId, testServiceStatus: "provisioning" },
        { $set: { testServiceStatus: "failed", hasReceivedTest: false } }
      ).catch(() => {});
      log("error", "Test service creation failed definitively", {
        attemptId,
        errorType: error?.name || "PanelError",
        code: error?.code || "TEST_SERVICE_FAILED",
      });
      await showStatus("❌ ساخت سرویس تست انجام نشد. لطفاً بعداً دوباره تلاش کنید.");
    } else {
      log("error", "Test service attempt state could not be recovered", {
        attemptId,
        errorType: error?.name || "RecoveryError",
      });
      if (current) await alertAdmin(current, bot, "TEST_SERVICE_STATE_UNAVAILABLE");
      await showStatus("⏳ وضعیت درخواست سرویس تست در حال بررسی است؛ لطفاً دوباره درخواست ساخت نفرستید.");
    }
  }
};

export async function recoverTestServiceAttempts(bot) {
  const stale = new Date(Date.now() - RECOVERY_STALE_MS);
  const pending = await User.find({
    testServiceStatus: "provisioning",
    testServiceStartedAt: { $lt: stale },
  }).limit(50).lean();
  for (const user of pending) {
    const manual = await User.findOneAndUpdate(
      { _id: user._id, testServiceAttemptId: user.testServiceAttemptId, testServiceStatus: "provisioning" },
      { $set: { testServiceStatus: "manual_review" } },
      { new: true }
    );
    if (manual) await alertAdmin(manual, bot, "STALE_PANEL_REQUEST");
  }

  const deliveries = await User.find({
    testServiceStatus: "completed",
    testServiceNotificationPending: true,
  }).limit(50).lean();
  for (const user of deliveries) {
    await notifyTestServiceOnce(user, bot).catch((error) => {
      log("warn", "Test-service notification recovery failed", {
        attemptId: user.testServiceAttemptId,
        errorType: error?.name || "RecoveryError",
      });
    });
  }
}

export default createTestService;
