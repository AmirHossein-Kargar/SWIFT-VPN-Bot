// * 🌍 Load env
import "dotenv/config";

// * 🔌 Core
import startBot from "./startBot.js";
import handleCallbackQuery from "./handlers/handleCallbackQuery.js";

// * 📦 Services & Handlers
import handleMessage from "./handlers/onMessage.js";
import { handleSupportGroupReply } from "./handlers/support/groupReply.js";
import { MOCK_TEST_BUTTON, ADMIN_PANEL_BUTTON } from "./keyboards/mainKeyboard.js";
import { legacyMenuAction, runMenuAction } from "./handlers/menuActions.js";
import { parseStartPayload, handleStartPayload } from "./handlers/message/handleStartPayload.js";
import { renderWelcome } from "./handlers/message/handleStart.js";
import supportMessageHandler from "./handlers/supportMessageHandler.js";

// * 📦 Utilities & Config
import { getSession, clearSession } from "./config/sessionStore.js";
import hideKeyboard from "./utils/hideKeyboard.js";
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
import { handleAdminPanelCommand, handleMockTestEntry } from "./handlers/admin/panel.js";
import { isAdminUser } from "./utils/auth.js";
import { touchUserActivity } from "./services/admin/users.js";
import { ensureTelegramUser } from "./services/users/ensureTelegramUser.js";
import { refuseIfBlocked } from "./services/users/accessGate.js";

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
      const account = await ensureTelegramUser(msg.from);
      if (await refuseIfBlocked({ bot, userId, chatType: msg.chat.type, user: account, chatId })) return;
      void touchUserActivity(userId, { now: new Date() });
    }

    // بررسی اینکه آیا پیام از گروه ادمین است
    if (process.env.GROUP_ID && chatId.toString() === process.env.GROUP_ID) {
      // Replies to a ticket message are delivered to that ticket's customer.
      if (msg.reply_to_message && (await handleSupportGroupReply(bot, msg))) return;
      // اگر در این چت گروهی فرآیند فعالی وجود دارد (برای ادمین)، همان هندلر عمومی را صدا بزن
      if (session?.step) {
        await handleMessage(bot, msg);
      } else {
        await handleGroupMessage(bot, msg);
      }
      return;
    }

    // Storefront deep link: /start plan_<id> opens the standard order
    // confirmation for that server-side plan (price is re-read at checkout).
    const startPayload = parseStartPayload(userText);
    if (startPayload && msg.chat?.type === "private") {
      const { messageId } = await renderWelcome(bot, { chatId, userId, chatType: msg.chat.type });
      await handleStartPayload(bot, chatId, startPayload, { messageId });
      return;
    }

    switch (userText) {
      case "/start": {
        // /start is an explicit reset: abandon any half-finished text input.
        if (session?.step) await clearSession(chatId);
        // Edits the chat's single standing screen in place (sends one fresh
        // message only when there is none yet); never a separate loading
        // placeholder, never a deleted message.
        await renderWelcome(bot, { chatId, userId, chatType: msg.chat?.type });
        break;
      }
      case MOCK_TEST_BUTTON: {
        // Admin-only; for anyone else the text is handled like any other input.
        if (msg.chat?.type === "private" && isAdminUser(userId)) {
          await hideKeyboard(bot, chatId);
          await handleMockTestEntry(bot, msg);
        } else {
          await handleMessage(bot, msg);
        }
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
      case ADMIN_PANEL_BUTTON: {
        // New SWIFT admin panel — private chat for allowlisted admins.
        if (isAdminUser(userId)) {
          if (userText === ADMIN_PANEL_BUTTON) await hideKeyboard(bot, chatId);
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
      default: {
        // Legacy Reply Keyboard taps from clients that still show the old
        // keyboard: remove it once, then route to the same action the inline
        // button runs. Private chats only; everything else is ordinary input.
        const legacyAction = msg.chat?.type === "private" ? legacyMenuAction(userText) : null;
        if (legacyAction) {
          await hideKeyboard(bot, chatId);
          await runMenuAction(bot, { action: legacyAction, chatId, userId, chat: msg.chat, from: msg.from });
        } else {
          await handleMessage(bot, msg);
        }
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
    if (await refuseIfBlocked({ bot, userId: query?.from?.id, chatType: query?.message?.chat?.type, query })) return;
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
    // Admin-group photos are ticket replies, handled by the "message" event.
    if (msg.chat?.type !== "private" && process.env.GROUP_ID && String(chatId) === process.env.GROUP_ID) return;
    if (await refuseIfBlocked({ bot, userId, chatType: msg.chat?.type, silent: true })) return;
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
    if (msg.chat?.type !== "private") return;
    if (await refuseIfBlocked({ bot, userId, chatType: msg.chat?.type, silent: true })) return;
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
