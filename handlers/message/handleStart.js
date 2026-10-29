import { renderInterface } from "../../services/messaging/messageManager.js";
import { getActiveMessage, setActiveMessage } from "../../services/messaging/activeMessageStore.js";
import { WELCOME_MESSAGE } from "../../messages/staticMessages.js";
import { keyboardFor } from "../../keyboards/mainKeyboard.js";

/**
 * Render the /start welcome screen as the chat's single standing message:
 * edit the tracked screen in place when one exists, otherwise send exactly
 * one fresh message — never a throwaway placeholder that is sent and
 * immediately deleted.
 *
 * A legacy Reply Keyboard left by an older bot version can only be cleared
 * by a message that carries `remove_keyboard`, and Telegram does not allow
 * that flag and an inline keyboard on the same `reply_markup`. So on the one
 * occasion this chat has no tracked screen yet, the welcome text is sent
 * with `remove_keyboard` first (one visible message, already showing the
 * real welcome text) and the inline menu is attached to that same message
 * right after with `editMessageReplyMarkup` — never a second message.
 *
 * @param {import('node-telegram-bot-api')} bot
 * @param {object} params
 * @param {number|string} params.chatId
 * @param {number} [params.userId]
 * @param {string} [params.chatType]
 * @returns {Promise<{messageId: number|null, edited: boolean, sent: boolean}>}
 */
export async function renderWelcome(bot, { chatId, userId, chatType = "private" } = {}) {
  const kb = keyboardFor(userId, chatType);

  if (chatType !== "private") {
    // Group chats never carry the legacy per-user Reply Keyboard, so there is
    // nothing to clear — plain edit-or-send navigation is enough.
    return renderInterface(bot, { chatId, text: WELCOME_MESSAGE, options: kb });
  }

  const existing = await getActiveMessage(chatId);
  if (existing != null) {
    const result = await renderInterface(bot, { chatId, text: WELCOME_MESSAGE, options: kb });
    if (result.edited) return result;
    // Edit failed inside renderInterface (message gone/too old) and it has
    // already sent a replacement with the inline menu attached — a chat that
    // already had a tracked screen already went through the one-time
    // keyboard-clear below in the past, so nothing further to do here.
    return result;
  }

  const sent = await bot.sendMessage(chatId, WELCOME_MESSAGE, { reply_markup: { remove_keyboard: true } });
  const messageId = sent?.message_id ?? null;
  if (messageId != null) {
    try {
      await bot.editMessageReplyMarkup(kb.reply_markup, { chat_id: chatId, message_id: messageId });
    } catch (error) {
      console.warn(`[handleStart] failed to attach the main menu keyboard (${error?.name || "TelegramError"})`);
    }
    await setActiveMessage(chatId, messageId);
  }
  return { messageId, edited: false, sent: true };
}

export default renderWelcome;
