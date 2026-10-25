import { getSession, setSession } from "../config/sessionStore.js";
import { getUnsupportedMediaMessage } from "../messages/supportContact.js";
import { SUPPORT_COPY, ticketCreated, messageRecorded } from "../messages/supportCopy.js";
import { SupportError } from "../services/support/tickets.js";
import { customerOpenTicket, customerReply } from "../services/support/workflow.js";
import { statusLabel } from "../services/support/delivery.js";
import escapeHtml from "../utils/escapeHtml.js";
import { isComposing, withUserLock, logSupportError, menuKeyboard } from "./support/supportFlow.js";

function extractContent(msg) {
  if (typeof msg.text === "string" && msg.text) return { text: msg.text, attachment: null };
  if (msg.photo?.length) {
    const photo = msg.photo[msg.photo.length - 1];
    return { text: msg.caption || "", attachment: { kind: "photo", fileId: photo.file_id, fileSize: photo.file_size } };
  }
  if (msg.video) {
    return { text: msg.caption || "", attachment: { kind: "video", fileId: msg.video.file_id, fileSize: msg.video.file_size } };
  }
  return null;
}

/** Edits the flow's standing message, sending a new one only if Telegram cannot edit it. */
async function confirm(bot, chatId, session, text, reply_markup) {
  const options = { parse_mode: "HTML", reply_markup };
  if (session.supportMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: session.supportMessageId, ...options });
      return session.supportMessageId;
    } catch (error) {
      if (/message is not modified/i.test(String(error?.message))) return session.supportMessageId;
    }
  }
  const sent = await bot.sendMessage(chatId, text, options);
  return sent?.message_id ?? null;
}

/**
 * Customer message while in support compose mode. The message is stored as a
 * ticket message (new ticket, or the ticket opened from the list) and appears
 * in the admin panel's inbox; nothing is copied to the admin group. Replays of
 * the same Telegram message are absorbed by the dedupe key, and a closed ticket
 * is refused by the service no matter what the session still says.
 */
const supportMessageHandler = async (bot, msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  return withUserLock(userId, async () => {
    const session = await getSession(userId);
    if (!isComposing(session)) return;

    const content = extractContent(msg);
    if (!content) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch { /* best effort */ }
      await confirm(bot, chatId, session, getUnsupportedMediaMessage(), menuKeyboard()).catch(() => {});
      return;
    }

    const dedupeKey = `tg:${chatId}:${msg.message_id}`;
    try {
      const input = { bot, userId, text: content.text, attachment: content.attachment, dedupeKey };
      const result = session.supportTicketId
        ? await customerReply({ ...input, ticketId: session.supportTicketId })
        : await customerOpenTicket({ ...input, channel: "telegram" });

      const { ticket } = result;
      const headline = result.created ? `${ticketCreated(escapeHtml(ticket.ticketId))}\n\n${SUPPORT_COPY.ticketCreatedHint}` : messageRecorded(escapeHtml(ticket.ticketId));
      const liveId = await confirm(
        bot,
        chatId,
        session,
        `${headline}\n\n${statusLabel(ticket.status)}`,
        {
          inline_keyboard: [
            [{ text: SUPPORT_COPY.closeTicket, callback_data: `sup_closeq:${ticket.ticketId}` }, { text: SUPPORT_COPY.myTickets, callback_data: "sup_list" }],
            [{ text: SUPPORT_COPY.backToMenu, callback_data: "back_to_home" }],
          ],
        },
      );
      await setSession(userId, {
        ...session,
        support: true,
        supportTicketId: ticket.ticketId,
        supportAt: Date.now(),
        supportMessageId: liveId,
      });
    } catch (error) {
      if (error instanceof SupportError) {
        if (error.code === "ticket_closed" || error.code === "ticket_not_found") {
          await setSession(userId, { ...session, support: false, supportTicketId: null, supportAt: null });
        }
        await bot.sendMessage(chatId, error.safeMessage, {
          reply_markup: error.code === "ticket_closed"
            ? { inline_keyboard: [[{ text: SUPPORT_COPY.newTicket, callback_data: "sup_new" }], [{ text: SUPPORT_COPY.backToMenu, callback_data: "back_to_home" }]] }
            : menuKeyboard(),
        }).catch(() => {});
        return;
      }
      logSupportError("support_message_failed", error);
      await bot.sendMessage(chatId, SUPPORT_COPY.genericError, {
        reply_markup: { inline_keyboard: [[{ text: SUPPORT_COPY.backToMenu, callback_data: "back_to_home" }]] },
      }).catch(() => {});
    }
  });
};

export default supportMessageHandler;
