import confirmOrder from "../../services/buyService/confirmOrder.js";
import { customerPlans, getCustomerPlanById } from "../../services/plans.js";

const ACTIVE_PLAN_IDS = new Set(customerPlans.map((plan) => plan.id));

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
export function planFromStartPayload(payload) {
  const match = /^plan_([a-z][a-z0-9_]{0,31})$/.exec(String(payload ?? ""));
  if (!match || !ACTIVE_PLAN_IDS.has(match[1])) return null;
  return getCustomerPlanById(match[1]);
}

/** Show the standard order confirmation for a storefront plan link. */
export async function handleStartPayload(bot, chatId, payload) {
  if (!String(payload ?? "").startsWith("plan_")) return false;
  const plan = planFromStartPayload(payload);
  if (!plan) {
    await bot.sendMessage(chatId, "❌ این پلن در حال حاضر فعال نیست. لطفاً از منوی «🛒 خرید سرویس» یک پلن انتخاب کنید.");
    return true;
  }
  const { message, replyMarkup } = confirmOrder(plan);
  await bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
  return true;
}

export default handleStartPayload;
