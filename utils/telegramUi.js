import { getSession, setSession } from "../config/sessionStore.js";

/** A customer-facing callback is trusted only in the caller's own 1:1 chat. */
export function isPrivateUserCallback(query) {
  const chat = query?.message?.chat;
  const userId = query?.from?.id;
  return chat?.type === "private" && userId != null && String(chat.id) === String(userId);
}

/** Incoming user messages can be removed only from the user's private chat. */
export function isPrivateUserMessage(message) {
  const chat = message?.chat;
  const userId = message?.from?.id;
  return chat?.type === "private" && userId != null && String(chat.id) === String(userId);
}

/**
 * Best-effort cleanup for private-chat input.
 * Telegram's Bot API allows bots to delete incoming messages in private chats
 * (subject to Telegram's general time/message restrictions); a failure must
 * never block the action the user intended.
 */
export async function deleteIncomingPrivateMessage(bot, message) {
  if (!isPrivateUserMessage(message) || !Number.isSafeInteger(Number(message.message_id))) {
    return false;
  }

  try {
    await bot.deleteMessage(message.chat.id, message.message_id);
    return true;
  } catch {
    return false;
  }
}

function errorDescription(error) {
  return String(
    error?.response?.body?.description ||
    error?.response?.data?.description ||
    error?.message ||
    ""
  );
}

/**
 * Edit the current bot UI message where possible, falling back to one new
 * message only when Telegram cannot edit the existing one. A stale screen is
 * removed after the replacement is safely sent.
 */
export async function editOrSendUiMessage(bot, chatId, messageId, text, options = {}) {
  if (messageId != null && Number.isSafeInteger(Number(messageId))) {
    try {
      await bot.editMessageText(text, {
        ...options,
        chat_id: chatId,
        message_id: Number(messageId),
      });
      return { message_id: Number(messageId), reused: true };
    } catch (error) {
      if (/message is not modified/i.test(errorDescription(error))) {
        return { message_id: Number(messageId), reused: true };
      }
    }
  }

  const sent = await bot.sendMessage(chatId, text, options);
  if (messageId != null && sent?.message_id && Number(messageId) !== Number(sent.message_id)) {
    await bot.deleteMessage(chatId, Number(messageId)).catch(() => {});
  }
  return sent;
}

/** Render a screen in the user's persistent bot message and save its ID. */
export async function renderUiScreen(
  bot,
  chatId,
  messageId,
  text,
  options = {},
  sessionPatch = {}
) {
  const beforeRender = await getSession(chatId);
  const targetMessageId =
    messageId ?? beforeRender.uiMessageId ?? beforeRender.mainMessageId ?? beforeRender.messageId;
  const rendered = await editOrSendUiMessage(bot, chatId, targetMessageId, text, options);

  if (rendered?.message_id != null) {
    const latest = await getSession(chatId);
    const id = Number(rendered.message_id);
    await setSession(chatId, {
      ...latest,
      ...sessionPatch,
      messageId: id,
      uiMessageId: id,
      mainMessageId: id,
    });
  }
  return rendered;
}
