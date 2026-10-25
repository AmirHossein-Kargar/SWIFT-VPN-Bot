/**
 * Deprecated: replying to a ticket from the admin group.
 *
 * Tickets are answered in the admin panel's inbox, which owns ownership and
 * status checks, audit and delivery. Old group copies of ticket messages still
 * exist in the chat history, so a Telegram "Reply" to one of them (or a
 * /close-style command sent as that reply) is recognised here and answered
 * with a pointer to the panel. Nothing is stored, delivered or changed:
 * this handler never creates a message, never changes a status and never
 * contacts the customer.
 *
 * Returns true when the message was a reply to an old ticket copy from an
 * allow-listed admin (so no other group handler also runs on it). Anyone else,
 * and any reply to a non-ticket message, returns false and is handled as
 * before, which also keeps unrelated group workflows untouched.
 */
import { isAdmin } from "../../utils/auth.js";
import { findTicketByGroupMessage } from "../../services/support/tickets.js";
import { groupRepliesDisabled } from "../../messages/supportCopy.js";
import { logSupportError } from "./supportFlow.js";

export async function handleSupportGroupReply(bot, msg) {
  const repliedTo = msg.reply_to_message?.message_id;
  if (!repliedTo || !msg.from) return false;
  if (!isAdmin(msg.chat.id, msg.from.id)) return false;

  let ticket;
  try {
    ticket = await findTicketByGroupMessage({ groupMessageId: repliedTo });
  } catch (error) {
    logSupportError("group_lookup_failed", error);
    return false;
  }
  if (!ticket) return false;

  await bot.sendMessage(msg.chat.id, groupRepliesDisabled(ticket.ticketId), { reply_to_message_id: msg.message_id }).catch(() => {});
  return true;
}
