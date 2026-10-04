// * 🌍 Load env
import "dotenv/config";

// * 🔌 Core
import startBot from "./startBot.js";
import handleCallbackQuery from "./handlers/handleCallbackQuery.js";
import handleContact from "./handlers/contactHandler.js";

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
import { getSession, setSession } from "./config/sessionStore.js";
import hideKeyboard from "./utils/hideKeyboard.js";
import { WELCOME_MESSAGE } from "./messages/staticMessages.js";

// * 📦 Models
import User from "./models/User.js";

// * 📦 API
import { StatusApi } from "./api/wizardApi.js";
import showStatusApi from "./handlers/admin/showStatusApi.js";

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
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const userText = msg.text;
    const session = await getSession(chatId);

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
        // پنل مدیریت فقط در گروه ادمین قابل استفاده است
        await bot.sendMessage(
          chatId,
          "⛔️ پنل مدیریت فقط در گروه ادمین در دسترس است. لطفاً دستور را در گروه ارسال کنید."
        );
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
        const user = await User.findOne({ telegramId: userId });
        if (!user || !user.phoneNumber) {
          await handleContact(bot, msg, async () => {
            await showPaymentMethods(bot, chatId);
          });
        } else {
          await showPaymentMethods(bot, chatId);
        }
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

// * ☎️ Contact Handler
bot.on("contact", async (msg) => {
  try {
    await handleContact(bot, msg);
  } catch (err) {
    console.error("❌ Error in bot.on('contact'):", err);
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, "❌ مشکلی در ذخیره شماره تلفن رخ داد.");
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

// * 🔊 Voice Handler (unsupported media types for support)
bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = await getSession(userId);

  if (session?.support) {
    try {
      // Delete the unsupported message
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (deleteError) {
        console.log("❗️خطا در حذف پیام voice:", deleteError.message);
        // Continue even if message deletion fails
      }

      // Edit the previous support message to show error
      if (session.supportMessageId) {
        try {
          await bot.editMessageText(
            `❌ این فایل مجاز نیست!\n\n▫️ جهت ارتباط به صورت مستقیم:\n🔰 @Swift_servicebot\n\n‼️ قبل از ارسال پیام به پشتیبانی، قوانین و مقررات سرویس‌ دهی را مطالعه کنید.\n\n📝 لطفاً پیام پشتیبانی خود را در همین چت تایپ و ارسال کنید.\n\n✅ فایل‌های مجاز: متن، عکس، فیلم`,
            {
              chat_id: chatId,
              message_id: session.supportMessageId,
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🏠 بازگشت به منوی اصلی",
                      callback_data: "back_to_home",
                    },
                  ],
                ],
              },
            }
          );
        } catch (editError) {
          console.log("❗️خطا در ویرایش پیام پشتیبانی:", editError.message);
        }
      }
    } catch (error) {
      console.error("❌ Error deleting unsupported voice message:", error);
    }
  }
});

// * 🎥 Video Note Handler (unsupported media types for support)
bot.on("video_note", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = await getSession(userId);

  if (session?.support) {
    try {
      // Delete the unsupported message
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (deleteError) {
        console.log("❗️خطا در حذف پیام video_note:", deleteError.message);
        // Continue even if message deletion fails
      }

      // Edit the previous support message to show error
      if (session.supportMessageId) {
        try {
          await bot.editMessageText(
            `❌ این فایل مجاز نیست!\n\n▫️ جهت ارتباط به صورت مستقیم:\n🔰 @Swift_servicebot\n\n‼️ قبل از ارسال پیام به پشتیبانی، قوانین و مقررات سرویس‌ دهی را مطالعه کنید.\n\n📝 لطفاً پیام پشتیبانی خود را در همین چت تایپ و ارسال کنید.\n\n✅ فایل‌های مجاز: متن، عکس، فیلم`,
            {
              chat_id: chatId,
              message_id: session.supportMessageId,
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🏠 بازگشت به منوی اصلی",
                      callback_data: "back_to_home",
                    },
                  ],
                ],
              },
            }
          );
        } catch (editError) {
          console.log("❗️خطا در ویرایش پیام پشتیبانی:", editError.message);
        }
      }
    } catch (error) {
      console.error("❌ Error deleting unsupported video_note message:", error);
    }
  }
});

// * 📄 Document Handler (unsupported media types for support)
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = await getSession(userId);

  if (session?.support) {
    try {
      // Delete the unsupported message
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (deleteError) {
        console.log("❗️خطا در حذف پیام document:", deleteError.message);
        // Continue even if message deletion fails
      }

      // Edit the previous support message to show error
      if (session.supportMessageId) {
        try {
          await bot.editMessageText(
            `❌ این فایل مجاز نیست!\n\n▫️ جهت ارتباط به صورت مستقیم:\n🔰 @Swift_servicebot\n\n‼️ قبل از ارسال پیام به پشتیبانی، قوانین و مقررات سرویس‌ دهی را مطالعه کنید.\n\n📝 لطفاً پیام پشتیبانی خود را در همین چت تایپ و ارسال کنید.\n\n✅ فایل‌های مجاز: متن، عکس، فیلم`,
            {
              chat_id: chatId,
              message_id: session.supportMessageId,
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🏠 بازگشت به منوی اصلی",
                      callback_data: "back_to_home",
                    },
                  ],
                ],
              },
            }
          );
        } catch (editError) {
          console.log("❗️خطا در ویرایش پیام پشتیبانی:", editError.message);
        }
      }
    } catch (error) {
      console.error("❌ Error deleting unsupported document message:", error);
    }
  }
});
