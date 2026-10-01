const hideKeyboard = async (bot, chatId) => {
  try {
    const tempMsg = await bot.sendMessage(chatId, "⏳", {
      reply_markup: {
        remove_keyboard: true,
      },
    });
   
   await new Promise(resolve => setTimeout(resolve, 100))
   
    // Delete the message after sending
    await bot.deleteMessage(chatId, tempMsg.message_id).catch(() => {});
  } catch (error) {
    // Cosmetic helper — never let a failure here break the calling flow.
    console.warn("⚠️ hideKeyboard failed:", error.message);
  }
};
export default hideKeyboard;
