import hideKeyboard from "../../utils/hideKeyboard.js";
import { showSupportMenu, logSupportError } from "../support/supportFlow.js";

/**
 * "🛠 پشتیبانی" button. The support menu is a single message that is edited in
 * place by the sup_* callbacks. There is deliberately no temporary "loading"
 * message and no delayed follow-up: the old two-step flow (placeholder, then a
 * 1s timer that replaced it) left the placeholder on screen whenever the user
 * navigated away, tapped twice, or the process restarted before the timer ran.
 */
const handleSupport = async (bot, chatId, userId) => {
  try {
    await hideKeyboard(bot, chatId);
    await showSupportMenu(bot, chatId, userId);
  } catch (error) {
    logSupportError("support_entry_failed", error);
    await bot.sendMessage(chatId, "❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.").catch(() => {});
  }
};

export default handleSupport;
