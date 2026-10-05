import { getSession, setSession } from "../config/sessionStore.js";
import User from "../models/User.js";
import { getUnsupportedMediaMessage, getSupportDirectButton } from "../messages/supportContact.js";
import { renderUiScreen } from "../utils/telegramUi.js";

const unsupportedMediaKeyboard = {
  inline_keyboard: [
    ...getSupportDirectButton(),
    [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
  ],
};

async function renderSupportStatus(bot, chatId, userId, session, text, replyMarkup, support) {
  const messageId = session.supportMessageId ?? session.uiMessageId ?? session.mainMessageId ?? session.messageId;
  const rendered = await renderUiScreen(
    bot,
    chatId,
    messageId,
    text,
    { reply_markup: replyMarkup },
    { support, supportMessageId: support ? session.supportMessageId ?? null : null }
  );
  const latest = await getSession(userId);
  await setSession(userId, {
    ...latest,
    support,
    supportMessageId: support ? rendered?.message_id ?? latest.supportMessageId ?? null : null,
  });
  return rendered;
}

const supportMessageHandler = async (bot, msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = await getSession(userId);
  if (!session?.support) return;

  // * GET USER INFO
  const user = await User.findOne({ telegramId: String(userId) });
  const groupId = process.env.GROUP_ID;

  const userInfo =
    `👤 کاربر: ${msg.from.first_name || "نامشخص"}\n` +
    `🔗 یوزرنیم: @${msg.from.username || "ندارد"}\n` +
    ` آیدی عددی: <code>${userId}</code>` +
    (user?.balance !== undefined
      ? `\n💰 موجودی: <code>${user.balance.toLocaleString()} تومان</code>`
      : "");

  let mediaType = "";
  let mediaContent = "";
  let mediaFile = null;

  // * CHECK MESSAGE TYPE
  if (msg.text) {
    mediaType = "📝 متن";
    mediaContent = msg.text;
  } else if (msg.photo && msg.photo.length > 0) {
    mediaType = "🖼 عکس";
    mediaContent = msg.caption || "";
    mediaFile = msg.photo[msg.photo.length - 1]; // Get the largest photo
  } else if (msg.video) {
    mediaType = "🎥 فیلم";
    mediaContent = msg.caption || "";
    mediaFile = msg.video;
  } else {
    // The private message is deleted by the enclosing Telegram message handler
    // after this notice is edited into the existing support UI.
    try {
      await renderSupportStatus(
        bot,
        chatId,
        userId,
        session,
        getUnsupportedMediaMessage(),
        unsupportedMediaKeyboard,
        true
      );
    } catch (error) {
      console.error("❌ Error showing unsupported support media:", error?.name || "TelegramError");
    }
    return;
  }

  try {
    // * SEND TO SUPPORT GROUP
    if (mediaFile) {
      // Send media with caption
      const mediaOptions = {
        caption: `📩 <b>پیام جدید پشتیبانی</b>\n\n${userInfo}${
          mediaContent ? `\n\n${mediaType}:\n${mediaContent}` : ""
        }`,
        parse_mode: "HTML",
      };

      if (mediaType === "🖼 عکس") {
        await bot.sendPhoto(groupId, mediaFile.file_id, mediaOptions);
      } else if (mediaType === "🎥 فیلم") {
        await bot.sendVideo(groupId, mediaFile.file_id, mediaOptions);
      }
    } else {
      // Send text message
      await bot.sendMessage(
        groupId,
        `📩 <b>پیام جدید پشتیبانی</b>\n\n${userInfo}\n\n${mediaType}:\n${mediaContent}`,
        { parse_mode: "HTML" }
      );
    }

    // * SEND CONFIRMATION TO USER by editing the existing support UI.
    await renderSupportStatus(
      bot,
      chatId,
      userId,
      session,
      `✅ ${mediaType} شما با موفقیت برای پشتیبانی ارسال شد`,
      { inline_keyboard: [[{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }]] },
      false
    );
  } catch (error) {
    console.error("❌ Error in supportMessageHandler:", error?.name || "SupportError");
    await renderSupportStatus(
      bot,
      chatId,
      userId,
      session,
      "❌ مشکلی در ارسال پیام به پشتیبانی رخ داد. لطفاً دوباره تلاش کنید.",
      unsupportedMediaKeyboard,
      true
    ).catch(() => {});
  }
};

export default supportMessageHandler;
