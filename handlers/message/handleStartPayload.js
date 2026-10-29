import confirmOrder from "../../services/buyService/confirmOrder.js";
import { getSellablePlanById } from "../../services/plans.js";

/**
 * Parse the payload of a Telegram deep link (`/start <payload>`). Telegram
 * limits payloads to 64 characters of [A-Za-z0-9_-]; anything else is ignored.
 */
export function parseStartPayload(text) {
  const match = /^\/start(?:@[A-Za-z0-9_]{1,64})?\s+([A-Za-z0-9_-]{1,64})$/.exec(String(text ?? "").trim());
  return match ? match[1] : null;
}

/**
 * Resolve a storefront "plan_<id>" payload to a currently sold customer plan.
 * Only the plan ID travels in the link: price, traffic and duration are read
 * from the server catalog here and again at checkout (confirm_order_).
 */
export async function planFromStartPayload(payload) {
  const match = /^plan_([A-Za-z0-9][A-Za-z0-9_-]{0,58})$/.exec(String(payload ?? ""));
  if (!match) return null;
  // storefront: true keeps legacy ids (plan_test) out of links while honouring publication state.
  return getSellablePlanById(match[1], { storefront: true });
}

/**
 * Show the standard order confirmation for a storefront plan link.
 *
 * @param {object} [options]
 * @param {number} [options.messageId] - edit this exact message (the welcome
 *   screen just rendered for the same /start update) into the order
 *   confirmation instead of sending a second message, when that is possible.
 */
export async function handleStartPayload(bot, chatId, payload, { messageId } = {}) {
  if (!String(payload ?? "").startsWith("plan_")) return false;
  const plan = await planFromStartPayload(payload);

  if (!plan) {
    const text = "❌ این پلن در حال حاضر فعال نیست. لطفاً از منوی «🛒 خرید سرویس» یک پلن انتخاب کنید.";
    if (messageId != null) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        return true;
      } catch (error) {
        console.warn(`[handleStartPayload] failed to edit the welcome screen (${error?.name || "TelegramError"})`);
      }
    }
    await bot.sendMessage(chatId, text);
    return true;
  }

  const { message, replyMarkup } = confirmOrder(plan);
  if (messageId != null) {
    try {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      return true;
    } catch (error) {
      console.warn(`[handleStartPayload] failed to edit the welcome screen into the order confirmation (${error?.name || "TelegramError"})`);
    }
  }
  await bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
  return true;
}

export default handleStartPayload;
