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
import keyboard from "./keyboards/mainKeyboard.js";
import sendServiceSelectionMenu from "./services/manageServices/sendServiceSelectionMenu.js";
import showPaymentMethods from "./handlers/message/showPaymentMethods.js";
import supportMessageHandler from "./handlers/supportMessageHandler.js";

// * 📦 Utilities & Config
import { getSession } from "./config/sessionStore.js";
import hideKeyboard from "./utils/hideKeyboard.js";
import { WELCOME_MESSAGE } from "./messages/staticMessages.js";
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
  try {
    await bot.editMessageText(getUnsupportedMediaMessage(), {
      chat_id: chatId,
      message_id: session.supportMessageId,
      reply_markup,
    });
  } catch (editError) {
    console.log("❗️خطا در ویرایش پیام پشتیبانی:", editError.message);
    await bot
      .sendMessage(chatId, getUnsupportedMediaMessage(), { reply_markup })
      .catch(() => {});
  }
}

// * 📦 API
import showStatusApi from "./handlers/admin/showStatusApi.js";
import { handleAdminPanelCommand } from "./handlers/admin/panel.js";
import { isAdminUser } from "./utils/auth.js";
import { touchUserActivity } from "./services/admin/users.js";
import { ensureTelegramUser } from "./services/users/ensureTelegramUser.js";

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
    dependency: error?.dependency,
    stage: error?.stage,
    errorType: error?.errorType || error?.name || "StartupError",
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
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const userText = msg.text;
    const session = await getSession(chatId);

    // Register the minimum Telegram account data needed for wallet ownership.
    // Contact/phone sharing is neither requested nor processed.
    if (msg.chat?.type === "private" && userId) {
      await ensureTelegramUser(msg.from);
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
        await bot.sendMessage(chatId, WELCOME_MESSAGE, keyboard);
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
        await createTestService(bot, msg);
        break;
      case "🛒 خرید سرویس":
        await handleBuyService(bot, chatId);
        break;
      case "💰 افزایش موجودی": {
        await hideKeyboard(bot, chatId);
        await showPaymentMethods(bot, chatId);
        break;
      }
      case "👤 پروفایل من":
        await handleProfile(bot, chatId, userId);
        break;
      case "📖 راهنما":
        await handleGuide(bot, chatId);
        break;
      case "🛠 پشتیبانی":
        await handleSupport(bot, chatId, userId);
        break;
      case "📦 سرویس‌های من":
        await sendServiceSelectionMenu(bot, chatId, userId);
        break;
      default:
        await handleMessage(bot, msg);
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
      await bot.sendMessage(
        msg.chat.id,
        "❌ خطایی رخ داد. لطفاً دوباره تلاش کنید."
      );
    } catch { /* chat unreachable — nothing more we can do */ }
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
    const chatId = msg.chat?.id;
    // Support sessions are keyed by user id. Payment sessions are keyed by
    // chat id. Those are the same in private chats; in a group they are not.
    const userSession = userId == null ? {} : await getSession(userId);
    const chatSession = chatId != null && String(chatId) !== String(userId)
      ? await getSession(chatId)
      : userSession;

    if (userSession?.support) {
      await supportMessageHandler(bot, msg);
      return;
    }

    const receiptSession = chatSession?.step === "waiting_for_receipt_image" ? chatSession : userSession;
    if (receiptSession?.step === "waiting_for_receipt_image") {
      const handleBankRecipt = (
        await import("./paymentHandlers/handleBankRecipt.js")
      ).default;
      await handleBankRecipt(bot, msg, receiptSession);
    }
  } catch (err) {
    console.error("❌ Error in bot.on('photo'):", err.message);
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
  }
});

function registerUnsupportedMedia(event, label) {
  bot.on(event, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const session = await getSession(userId);
    if (!session?.support) return;
    try {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (deleteError) {
        console.log(`❗️خطا در حذف پیام ${label}:`, deleteError.message);
      }
      await showUnsupportedMediaNotice(bot, chatId, session);
    } catch (error) {
      console.error(`❌ Error deleting unsupported ${label} message:`, error);
    }
  });
}

registerUnsupportedMedia("voice", "voice");
registerUnsupportedMedia("video_note", "video_note");
registerUnsupportedMedia("document", "document");
