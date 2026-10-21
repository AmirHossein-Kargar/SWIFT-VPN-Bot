/**
 * Enforces admin-initiated blocks at the bot's user-facing entry points
 * (messages, callback buttons, photo/video uploads).
 *
 * Scope, deliberately narrow:
 *  - Only blocks set by an admin count. broadcast.js sets isBanned with
 *    blockedBy: "system" when a user has blocked the BOT itself (Telegram
 *    403); treating that as a ban would permanently lock out every user who
 *    ever muted the bot and later came back.
 *  - Allowlisted admins are never gated.
 *  - Payment webhooks / IPN, recovery crons and fulfillment are NOT gated:
 *    money a blocked user already paid is still credited to their wallet.
 *  - Fails open on a lookup error (the block is a moderation tool, not a
 *    security boundary: payments and provisioning carry their own checks),
 *    so a database blip can never take the whole bot down for everyone.
 */
import User from "../../models/User.js";
import { isAdminUser } from "../../utils/auth.js";
import { getSupportDirectButton } from "../../messages/supportContact.js";

export const BLOCKED_NOTICE = "⛔️ دسترسی شما به ربات توسط پشتیبانی محدود شده است. در صورت نیاز با پشتیبانی تماس بگیرید.";

export function isAdminBanned(user) {
  return Boolean(user?.isBanned) && user?.blockedBy !== "system";
}

export async function loadAccessState(telegramId, { userModel = User } = {}) {
  try {
    return await userModel.findOne({ telegramId: String(telegramId) }).select("isBanned blockedBy").lean();
  } catch {
    return null;
  }
}

function blockedReplyMarkup() {
  const buttons = getSupportDirectButton();
  return buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {};
}

/**
 * @param {object} options
 * @param {boolean} [options.silent] - refuse without replying. Used by the
 *   photo/video handlers: node-telegram-bot-api also emits "message" for the
 *   same update, and that handler already sends the notice.
 * @returns {Promise<boolean>} true when the update was refused (caller must stop).
 */
export async function refuseIfBlocked({ bot, userId, chatType, user, query, chatId, userModel, silent = false } = {}) {
  if (chatType !== "private" || !userId || isAdminUser(userId)) return false;
  const state = user ?? (await loadAccessState(userId, { userModel }));
  if (!isAdminBanned(state)) return false;
  if (silent) return true;
  try {
    if (query?.id) {
      await bot.answerCallbackQuery(query.id, { text: BLOCKED_NOTICE, show_alert: true });
    } else if (chatId != null) {
      await bot.sendMessage(chatId, BLOCKED_NOTICE, blockedReplyMarkup());
    }
  } catch { /* chat unreachable — the refusal itself still stands */ }
  return true;
}
