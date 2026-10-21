/**
 * One-time migration helper: clears a persistent Reply Keyboard that an older
 * version of the bot left in the user's Telegram client. Telegram can only
 * remove it by sending a message that carries `remove_keyboard`, so a minimal
 * placeholder is sent and deleted immediately. Inline menus never need this.
 */
const hideKeyboard = async (bot, chatId) => {
  try {
    const tempMsg = await bot.sendMessage(chatId, "⏳", {
      reply_markup: { remove_keyboard: true },
    });
    if (tempMsg?.message_id != null) {
      await bot.deleteMessage(chatId, tempMsg.message_id).catch(() => {});
    }
  } catch (error) {
    // Cosmetic helper — never let a failure here break the calling flow.
    console.warn("⚠️ hideKeyboard failed:", error.message);
  }
};
export default hideKeyboard;
