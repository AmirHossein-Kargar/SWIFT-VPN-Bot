import { getActiveMessage, setActiveMessage } from "../../services/messaging/activeMessageStore.js";
import { WELCOME_MESSAGE } from "../../messages/staticMessages.js";
import { keyboardFor } from "../../keyboards/mainKeyboard.js";
import hideKeyboard from "../../utils/hideKeyboard.js";

/**
 * Render the /start welcome screen as a NEW message, every time. /start is how
 * a user gets back to the menu, so it never depends on an earlier message: a
 * tracked one may be deleted, scrolled out of view or cleared on the user's side
 * only, and Telegram then accepts the edit (or reports "not modified") while the
 * user sees nothing. Buttons pressed afterwards edit this message in place.
 *
 * The inline menu travels on the sendMessage itself. Telegram can only edit
 * messages without reply_markup or with inline keyboards, so a message sent with
 * `remove_keyboard` can never receive the menu afterwards; hideKeyboard clears a
 * legacy Reply Keyboard with its own short-lived message instead. A chat with a
 * tracked screen used the bot recently and has nothing left to clear.
 *
 * @param {import('node-telegram-bot-api')} bot
 * @param {object} params
 * @param {number|string} params.chatId
 * @param {number} [params.userId]
 * @param {string} [params.chatType]
 * @returns {Promise<{messageId: number|null, edited: boolean, sent: boolean}>}
 */
export async function renderWelcome(bot, { chatId, userId, chatType = "private" } = {}) {
  if (chatType === "private" && (await getActiveMessage(chatId)) == null) await hideKeyboard(bot, chatId);

  const sent = await bot.sendMessage(chatId, WELCOME_MESSAGE, keyboardFor(userId, chatType));
  const messageId = sent?.message_id ?? null;
  if (messageId != null) await setActiveMessage(chatId, messageId);
  console.log(JSON.stringify({ service: "bot", event: "start_menu_sent", chatType }));
  return { messageId, edited: false, sent: true };
}

export default renderWelcome;
