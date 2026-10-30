/**
 * Centralized helpers for rendering Telegram "navigation screens" — menus,
 * profile, guide, and similar inline-keyboard flows the user clicks through.
 * The goal is to edit the chat's existing interface message in place instead
 * of sending a new one for every click, cutting chat clutter.
 *
 * Wraps the existing `node-telegram-bot-api` instance passed around the rest
 * of the codebase (bot.js, config/botInstance.js, HTTP-webhook notifiers) —
 * it does not create, replace, or own a bot instance of its own, so it is a
 * drop-in call from either an inbound Telegram update or an HTTP-triggered
 * notification path.
 *
 * NEVER route payment instructions, invoices, receipts, or fulfillment
 * messages through renderInterface(): those must remain their own standalone
 * messages so a user always has a durable, un-edited record of them. This
 * module is for throwaway navigation UI only.
 */
import { getActiveMessage, setActiveMessage, setActiveMessageIfUnchanged } from "./activeMessageStore.js";

const NOT_MODIFIED_PATTERN = /message is not modified/i;

function describeError(error) {
  return String(error?.response?.body?.description || error?.message || "");
}

/** True for Telegram's "no-op edit" error — the screen already shows this content. */
export function isNotModifiedError(error) {
  return NOT_MODIFIED_PATTERN.test(describeError(error));
}

/**
 * Render a navigation screen for a chat: edit the tracked/given message in
 * place when possible, otherwise send a fresh message and start tracking it.
 *
 * Editing is attempted, never assumed to succeed — a message that was
 * deleted, is too old, or (critically) is not a text message (e.g. a photo,
 * such as a QR code) cannot be turned into arbitrary text, so any edit
 * failure other than "not modified" falls back to a normal send instead of
 * throwing. "Not modified" only counts as success for an explicit messageId,
 * the message the user just tapped: a tracked message may be out of view, so
 * leaving it unchanged would answer the user with nothing.
 *
 * @param {import('node-telegram-bot-api')} bot
 * @param {object} params
 * @param {number|string} params.chatId
 * @param {string} params.text
 * @param {object} [params.options] - { reply_markup, parse_mode, disable_web_page_preview }
 * @param {number} [params.messageId] - edit this exact message if given (e.g.
 *   the message id on the callback query that triggered this navigation);
 *   otherwise the chat's last-tracked interface message is used, if any.
 * @returns {Promise<{messageId: number, edited: boolean, sent: boolean, unchanged?: boolean}>}
 */
export async function renderInterface(bot, { chatId, text, options = {}, messageId } = {}) {
  if (!bot?.sendMessage || chatId == null || typeof text !== "string") {
    throw new TypeError("renderInterface requires { bot, chatId, text }");
  }
  const { reply_markup, parse_mode, disable_web_page_preview } = options;
  const explicitMessageId = Number.isSafeInteger(messageId) ? messageId : null;
  const targetMessageId = explicitMessageId ?? (await getActiveMessage(chatId));

  if (targetMessageId != null) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: targetMessageId,
        reply_markup,
        parse_mode,
        disable_web_page_preview,
      });
      // An explicitly supplied messageId comes straight from the current
      // Telegram update, so it is safe to adopt unconditionally; a pointer
      // merely read from the store is already correct and needs no rewrite.
      if (explicitMessageId != null) await setActiveMessage(chatId, explicitMessageId);
      return { messageId: targetMessageId, edited: true, sent: false };
    } catch (error) {
      if (explicitMessageId != null && isNotModifiedError(error)) {
        await setActiveMessage(chatId, explicitMessageId);
        return { messageId: targetMessageId, edited: true, sent: false, unchanged: true };
      }
      console.warn(`[messageManager] editMessageText failed (${error?.name || "TelegramError"}); sending a new message instead`);
      // fall through to the send fallback below
    }
  }

  const sentMessage = await bot.sendMessage(chatId, text, { reply_markup, parse_mode, disable_web_page_preview });
  const sentMessageId = sentMessage?.message_id ?? null;
  if (sentMessageId != null) await setActiveMessageIfUnchanged(chatId, sentMessageId, targetMessageId);
  return { messageId: sentMessageId, edited: false, sent: true };
}

/**
 * Answer a callback query without ever throwing into the caller — an
 * already-answered or expired query must not break the surrounding handler.
 */
export async function answerCallback(bot, queryId, options) {
  if (!bot?.answerCallbackQuery || !queryId) return false;
  try {
    await bot.answerCallbackQuery(queryId, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a message only when the caller explicitly opts in via `allow`.
 * Intended for transient user input (e.g. an admin's one-off text reply that
 * should vanish once consumed) — never for bot-authored payment
 * instructions, invoices, receipts, or fulfillment messages. This function
 * does not guess which case it is; the caller must decide.
 */
export async function safeDeleteUserMessage(bot, chatId, messageId, { allow = false } = {}) {
  if (!allow || !bot?.deleteMessage || chatId == null || messageId == null) return false;
  try {
    await bot.deleteMessage(chatId, messageId);
    return true;
  } catch {
    return false;
  }
}
