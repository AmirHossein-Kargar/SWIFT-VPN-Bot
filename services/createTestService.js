import { randomUUID } from "node:crypto";
import User from "../models/User.js";
import { getTestServiceMessage, guideButtons } from "../messages/staticMessages.js";
import { createTestService as createTestServiceApi } from "../api/wizardApi.js";
import escapeHtml from "../utils/escapeHtml.js";
import { isNotModifiedError } from "./messaging/messageManager.js";
import { subscriptionLink } from "./subscriptionLink.js";

const NOTIFICATION_CLAIM_MS = 5 * 60_000;
const RECOVERY_STALE_MS = 5 * 60_000;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "test-service", level, message, ...meta })
  );
}

const BACK_HOME_KEYBOARD = { inline_keyboard: [[{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }]] };

/**
 * Edit `messageId` (the main-menu screen the customer tapped "🎁 سرویس تست"
 * from) into `text` in place; falls back to sending one fresh message when
 * there is nothing to edit yet, or editing fails (deleted/too old message).
 * Never sends a throwaway placeholder and never deletes a message — every
 * call here replaces the one standing screen, exactly like every other menu
 * action.
 * @returns {Promise<number|null>} the message id now holding `text`, so the
 *   next call in the same request can keep editing it.
 */
async function editOrSend(bot, chatId, messageId, text, keyboard = BACK_HOME_KEYBOARD) {
  const options = { parse_mode: "HTML", reply_markup: keyboard };
  if (messageId != null) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
      return messageId;
    } catch (error) {
      // The screen already shows this text; a second copy would only be noise.
      if (isNotModifiedError(error)) return messageId;
      // Edit failed (deleted, too old, or not a text message) — fall through to a fresh send.
    }
  }
  try {
    const sent = await bot.sendMessage(chatId, text, options);
    return sent?.message_id ?? null;
  } catch {
    return messageId ?? null;
  }
}

async function notifyTestServiceOnce(user, bot, userModel = User) {
  if (!user?.testServiceNotificationPending || !bot?.sendPhoto) return false;
  const now = new Date();
  const stale = new Date(now.getTime() - NOTIFICATION_CLAIM_MS);
  const claimed = await userModel.findOneAndUpdate(
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
    const smartLink = subscriptionLink({ link: claimed.testServiceLink, hash: claimed.testServiceHash }) || "";
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
    await userModel.findOneAndUpdate(
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

/**
 * `deps` is an injection seam for the isolated mock-test harness (in-memory
 * user model and a fake panel adapter) and, for real Telegram callers, the
 * main-menu screen's message id to edit in place throughout (`messageId`).
 */
const createTestService = async (bot, msg, { userModel = User, createApi = createTestServiceApi, messageId } = {}) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  // The screen this whole request edits in place, from "⏳ building…" through
  // to the final status — reassigned as editOrSend resolves to whichever
  // message id actually ended up holding the text (the given one, or a fresh
  // send if editing it was never possible).
  let screenId = messageId;
  try {
    await userModel.updateOne({ telegramId: userId }, { $setOnInsert: { telegramId: userId } }, { upsert: true });
  } catch (error) {
    log("error", "Could not load test-service account", { errorType: error?.name || "DatabaseError" });
    await editOrSend(bot, chatId, screenId, "❌ خطا در ارتباط با پایگاه داده. لطفاً بعداً تلاش کنید.");
    return;
  }

  const attemptId = randomUUID();
  let user;
  try {
    user = await userModel.findOneAndUpdate(
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
    await editOrSend(bot, chatId, screenId, "❌ درخواست در حال حاضر ثبت نشد. لطفاً بعداً تلاش کنید.");
    return;
  }

  if (!user) {
    const existing = await userModel.findOne({ telegramId: userId }).select("hasReceivedTest testServiceStatus").lean();
    if (existing?.hasReceivedTest || existing?.testServiceStatus === "completed") {
      await editOrSend(bot, chatId, screenId, "⚠️ شما قبلاً این سرویس را دریافت کرده‌اید.");
    } else if (["provisioning", "manual_review"].includes(existing?.testServiceStatus)) {
      await editOrSend(bot, chatId, screenId, "⏳ درخواست قبلی شما هنوز در حال بررسی است؛ لطفاً برای جلوگیری از ساخت تکراری با پشتیبانی تماس بگیرید.");
    } else {
      await editOrSend(bot, chatId, screenId, "❌ درخواست در حال حاضر ثبت نشد. لطفاً دوباره تلاش کنید.");
    }
    return;
  }

  let panelResponseReceived = false;
  try {
    screenId = await editOrSend(bot, chatId, screenId, "⏳ در حال ساخت سرویس ...", { inline_keyboard: [] });
    const data = await createApi();
    panelResponseReceived = true;
    const result = data.result;
    const hash = typeof result.hash === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(result.hash) ? result.hash : null;
    const serviceLink = typeof result.sub_link === "string" && result.sub_link.length <= 4096 ? result.sub_link : null;
    const singleLink = Array.isArray(result.tak_links) && typeof result.tak_links[0] === "string" && result.tak_links[0].length <= 4096 ? result.tak_links[0] : "";

    const updated = await userModel.findOneAndUpdate(
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
        $push: { services: { username: result.username, sub_link: serviceLink, purchaseId: attemptId, expiresAt: testServiceExpiry(result) } },
        $addToSet: { completedPurchaseIds: attemptId },
        $inc: { totalServices: 1 },
      },
      { new: true }
    );
    if (!updated) throw new Error("Test-service result could not be committed to the owner account");

    const delivered = await notifyTestServiceOnce(updated, bot, userModel);
    await editOrSend(bot, chatId, screenId, delivered
      ? "✅ سرویس تست شما ساخته شد. لینک اتصال در پیام بعدی ارسال شد."
      : "✅ سرویس ساخته و به حساب شما اضافه شد، اما ارسال لینک با تأخیر روبه‌رو شد. کمی بعد دوباره بررسی کنید.");
  } catch (error) {
    const current = await userModel.findOne({ telegramId: userId, testServiceAttemptId: attemptId }).lean().catch(() => null);

    if (error?.ambiguous || (panelResponseReceived && current?.testServiceStatus !== "completed")) {
      const uncertain = await userModel.findOneAndUpdate(
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
      await editOrSend(bot, chatId, screenId, "⏳ وضعیت ساخت سرویس تست از پنل مشخص نیست. برای جلوگیری از ساخت تکراری، درخواست شما تا بررسی پشتیبانی متوقف شده است.");
    } else if (current?.testServiceStatus === "completed") {
      const delivered = await notifyTestServiceOnce(current, bot, userModel).catch(() => false);
      await editOrSend(bot, chatId, screenId, delivered
        ? "✅ سرویس تست شما ساخته شد. لینک اتصال در پیام بعدی ارسال شد."
        : "✅ سرویس تست ساخته و به حساب شما اضافه شد؛ ارسال لینک در حال بازیابی است.");
    } else if (current?.testServiceStatus === "provisioning") {
      await userModel.updateOne(
        { telegramId: userId, testServiceAttemptId: attemptId, testServiceStatus: "provisioning" },
        { $set: { testServiceStatus: "failed", hasReceivedTest: false } }
      ).catch(() => {});
      log("error", "Test service creation failed definitively", {
        attemptId,
        errorType: error?.name || "PanelError",
        code: error?.code || "TEST_SERVICE_FAILED",
        reason: error?.reason ?? undefined,
      });
      // `Maximum test is N`: the account's tests are switched off or used up, so asking again later will not help.
      await editOrSend(bot, chatId, screenId, error?.reason === "test_unavailable"
        ? "❌ ساخت سرویس تست در حال حاضر فعال نیست."
        : "❌ ساخت سرویس تست انجام نشد. لطفاً بعداً دوباره تلاش کنید.");
    } else {
      log("error", "Test service attempt state could not be recovered", {
        attemptId,
        errorType: error?.name || "RecoveryError",
      });
      if (current) await alertAdmin(current, bot, "TEST_SERVICE_STATE_UNAVAILABLE");
      await editOrSend(bot, chatId, screenId, "⏳ وضعیت درخواست سرویس تست در حال بررسی است؛ لطفاً دوباره درخواست ساخت نفرستید.");
    }
  }
};

/** The provider's own expiry when it gave one. A service with no date stored would read as unknown forever. */
function testServiceExpiry(result) {
  const seconds = Number(result?.service?.expire ?? result?.expiryTime);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

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
