// * 🌍 Load env
import "dotenv/config";

// * 🔌 Core
import startBot from "./startBot.js";
import handleCallbackQuery from "./handlers/handleCallbackQuery.js";

// * 📦 Services & Handlers
import createTestService from "./services/createTestService.js";
import handleBuyService from "./services/buyService/buyService.js";
import handleGuide from "./handlers/message/handleGuide.js";
import handleMessage from "./handlers/onMessage.js";
import handleProfile from "./handlers/message/handleProfile.js";
import handleSupport from "./handlers/message/handleSupport.js";
import showHome from "./handlers/message/showHome.js";
import sendServiceSelectionMenu from "./services/manageServices/sendServiceSelectionMenu.js";
import showPaymentMethods from "./handlers/message/showPaymentMethods.js";
import supportMessageHandler from "./handlers/supportMessageHandler.js";

// * 📦 Utilities & Config
import { getSession, setSession } from "./config/sessionStore.js";
import { renderUiScreen, deleteIncomingPrivateMessage, isPrivateUserMessage } from "./utils/telegramUi.js";
import ensureTelegramUser from "./services/users/ensureTelegramUser.js";
import { getUnsupportedMediaMessage, getSupportDirectButton } from "./messages/supportContact.js";

/** Edit the standing support notice with the unsupported-media message. */
async function showUnsupportedMediaNotice(bot, chatId, session) {
  if (!session?.supportMessageId) return;
  const reply_markup = {
    inline_keyboard: [
      ...getSupportDirectButton(),
      [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
    ],
  };
  const rendered = await renderUiScreen(
    bot,
    chatId,
    session.supportMessageId ?? session.uiMessageId ?? session.mainMessageId,
    getUnsupportedMediaMessage(),
    { reply_markup },
    { support: true }
  ).catch(() => null);
  if (rendered?.message_id != null) {
    const latest = await getSession(chatId);
    await setSession(chatId, { ...latest, supportMessageId: Number(rendered.message_id) });
  }
}

// * 📦 API
import { StatusApi } from "./api/wizardApi.js";
import showStatusApi from "./handlers/admin/showStatusApi.js";
import { handleAdminPanelCommand } from "./handlers/admin/panel.js";
import { isAdminUser } from "./utils/auth.js";
import { touchUserActivity } from "./services/admin/users.js";

// * ⚙️ Configuration report
// Resolves platform-provided variable names (Railway's MONGO_URL / REDIS_URL /
// REDISHOST / ...) and aborts with an actionable list if anything fatal is
// missing. Admin authorization itself lives in utils/auth.js (fail-closed).
import { assertRequiredEnv } from "./config/env.js";
assertRequiredEnv();

// * 🚀 Start Bot
let bot;
try {
  bot = await startBot();
} catch (error) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "startup",
    level: "fatal",
    message: "Application startup failed",
    errorType: error?.name || "StartupError",
    code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
  }));
  process.exit(1);
}

// * 🏠 Initialize Group Manager
import { handleGroupMessage } from "./handlers/admin/groupManager.js";

// * 📨 Message Handler
// Every inbound update is contained: a failure in one handler must never take
// down the bot or leave the user without feedback.
bot.on("message", async (msg) => {
  // Photo/video and unsupported media have dedicated handlers below; they must
  // finish forwarding/receipt processing before their private input is deleted.
  const hasDedicatedMediaHandler = Boolean(
    msg.photo || msg.video || msg.voice || msg.video_note || msg.document
  );
  let session = {};
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const userText = msg.text;
    session = await getSession(chatId);
    const uiMessageId = session.uiMessageId ?? session.mainMessageId ?? session.messageId;

    // Best-effort activity tracking for admin dashboards (throttled).
    if (msg.chat?.type === "private" && userId) {
      void touchUserActivity(userId, { now: new Date() });
    }

    // بررسی اینکه آیا پیام از گروه ادمین است
    if (process.env.GROUP_ID && chatId.toString() === process.env.GROUP_ID) {
      // اگر در این چت گروهی فرآیند فعالی وجود دارد (برای ادمین)، همان هندلر عمومی را صدا بزن
      if (session?.step) {
        await handleMessage(bot, msg);
      } else {
        await handleGroupMessage(bot, msg);
      }
      return;
    }

    switch (userText) {
      case "/start": {
        if (msg.chat?.type === "private" && userId) {
          await ensureTelegramUser(msg.from).catch(() => {});
        }
        await showHome(bot, chatId, uiMessageId);
        break;
      }
      case "/panel":
      case "پنل": {
        // پنل مدیریت: برای ادمین‌های مجاز در چت خصوصی هم در دسترس است
        if (isAdminUser(userId)) {
          await handleAdminPanelCommand(bot, msg);
        } else {
          await bot.sendMessage(
            chatId,
            "⛔️ پنل مدیریت فقط برای ادمین‌های مجاز در دسترس است."
          );
        }
        break;
      }
      case "/admin":
      case "👑 SWIFT ADMIN": {
        // New SWIFT admin panel — private chat for allowlisted admins.
        if (isAdminUser(userId)) {
          await handleAdminPanelCommand(bot, msg);
        } else {
          await bot.sendMessage(chatId, "⛔️ این دستور فقط برای ادمین‌های مجاز فعال است.");
        }
        break;
      }
      case "/status": {
        await showStatusApi(bot, msg);
        break;
      }
      case "🎁 سرویس تست":
        await createTestService(bot, msg, { uiMessageId });
        break;
      case "🛒 خرید سرویس":
        await handleBuyService(bot, chatId, uiMessageId);
        break;
      case "💰 افزایش موجودی":
        await showPaymentMethods(bot, chatId, uiMessageId);
        break;
      case "👤 پروفایل من":
        await handleProfile(bot, chatId, userId, { messageId: uiMessageId, telegramUser: msg.from });
        break;
      case "📖 راهنما":
        await handleGuide(bot, chatId, uiMessageId);
        break;
      case "🛠 پشتیبانی":
        await handleSupport(bot, chatId, userId, uiMessageId);
        break;
      case "📦 سرویس‌های من":
        await sendServiceSelectionMenu(bot, chatId, userId, uiMessageId);
        break;
      default:
        if (session?.support && !msg.text && !hasDedicatedMediaHandler) {
          await supportMessageHandler(bot, msg);
        } else {
          await handleMessage(bot, msg);
        }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        service: "bot",
        level: "error",
        message: "Unhandled error in message handler",
        error: err.message,
      })
    );
    try {
      if (msg.chat?.type === "private") {
        await renderUiScreen(
          bot,
          msg.chat.id,
          session.uiMessageId ?? session.mainMessageId ?? session.messageId,
          "❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.",
          { reply_markup: { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }]] } }
        );
      } else {
        await bot.sendMessage(msg.chat.id, "❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.");
      }
    } catch { /* chat unreachable — nothing more we can do */ }
  } finally {
    // Delete after the command/input has been consumed; Telegram failures must
    // not affect an already-completed payment, order, or support action.
    if (!hasDedicatedMediaHandler && isPrivateUserMessage(msg)) {
      await deleteIncomingPrivateMessage(bot, msg);
    }
  }
});

// * 🔘 Callback Query Handler
bot.on("callback_query", async (query) => {
  try {
    await handleCallbackQuery(bot, query);
  } catch (err) {
    console.error("❌ Error in bot.on('callback_query'):", err);
  }
});

// * 🖼️ Photo Handler (for receipt uploads and support)
bot.on("photo", async (msg) => {
  try {
    const userId = msg.from?.id;
    const session = await getSession(userId);

    // Check if user is in support mode
    if (session?.support) {
      await supportMessageHandler(bot, msg);
      return;
    }

    // Handle receipt uploads
    if (session?.step === "waiting_for_receipt_image") {
      const handleBankRecipt = (
        await import("./paymentHandlers/handleBankRecipt.js")
      ).default;
      await handleBankRecipt(bot, msg, session);
    }
  } catch (err) {
    console.error("❌ Error in bot.on('photo'):", err.message);
  } finally {
    if (isPrivateUserMessage(msg)) await deleteIncomingPrivateMessage(bot, msg);
  }
});

// * 🎥 Video Handler (for support)
bot.on("video", async (msg) => {
  try {
    const userId = msg.from?.id;
    const session = await getSession(userId);

    if (session?.support) {
      await supportMessageHandler(bot, msg);
    }
  } catch (err) {
    console.error("❌ Error in bot.on('video'):", err.message);
  } finally {
    if (isPrivateUserMessage(msg)) await deleteIncomingPrivateMessage(bot, msg);
  }
});

// * 🔊 Voice Handler (unsupported media types for support)
bot.on("voice", async (msg) => {
  try {
    const session = await getSession(msg.from?.id ?? msg.chat.id);
    if (session?.support) await showUnsupportedMediaNotice(bot, msg.chat.id, session);
  } catch (error) {
    console.error("❌ Error handling unsupported voice message:", error?.message || error);
  } finally {
    if (isPrivateUserMessage(msg)) await deleteIncomingPrivateMessage(bot, msg);
  }
});

// * 🎥 Video Note Handler (unsupported media types for support)
bot.on("video_note", async (msg) => {
  try {
    const session = await getSession(msg.from?.id ?? msg.chat.id);
    if (session?.support) await showUnsupportedMediaNotice(bot, msg.chat.id, session);
  } catch (error) {
    console.error("❌ Error handling unsupported video note:", error?.message || error);
  } finally {
    if (isPrivateUserMessage(msg)) await deleteIncomingPrivateMessage(bot, msg);
  }
});

// * 📄 Document Handler (unsupported media types for support)
bot.on("document", async (msg) => {
  try {
    const session = await getSession(msg.from?.id ?? msg.chat.id);
    if (session?.support) await showUnsupportedMediaNotice(bot, msg.chat.id, session);
  } catch (error) {
    console.error("❌ Error handling unsupported document:", error?.message || error);
  } finally {
    if (isPrivateUserMessage(msg)) await deleteIncomingPrivateMessage(bot, msg);
  }
});
