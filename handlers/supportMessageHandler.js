import { getSession, setSession } from "../config/sessionStore.js";
import { getUnsupportedMediaMessage } from "../messages/supportContact.js";
import { SupportError } from "../services/support/tickets.js";
import { customerOpenTicket, customerReply } from "../services/support/workflow.js";
import { statusLabel } from "../services/support/delivery.js";
import escapeHtml from "../utils/escapeHtml.js";
import { isComposing, withUserLock, logSupportError, menuKeyboard } from "./support/supportFlow.js";

function extractContent(msg) {
  if (typeof msg.text === "string" && msg.text) return { text: msg.text, attachment: null, label: "📝 پیام" };
  if (msg.photo?.length) {
    const photo = msg.photo[msg.photo.length - 1];
    return { text: msg.caption || "", attachment: { kind: "photo", fileId: photo.file_id, fileSize: photo.file_size }, label: "🖼 عکس" };
  }
  if (msg.video) {
    return { text: msg.caption || "", attachment: { kind: "video", fileId: msg.video.file_id, fileSize: msg.video.file_size }, label: "🎥 فیلم" };
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
 * ticket message (new ticket, or the ticket opened from the list), then
 * forwarded to the admin group. Replays of the same Telegram message are
 * absorbed by the dedupe key.
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
      const input = { bot, from: msg.from, userId, text: content.text, attachment: content.attachment, dedupeKey };
      const result = session.supportTicketId
        ? await customerReply({ ...input, ticketId: session.supportTicketId })
        : await customerOpenTicket({ ...input, channel: "telegram" });

      const { ticket } = result;
      const warning = result.forwarded === false
        ? "\n⚠️ ارسال فوری به تیم پشتیبانی با تأخیر مواجه شد؛ پیام شما ثبت شده و بررسی می‌شود."
        : "";
      const liveId = await confirm(
        bot,
        chatId,
        session,
        `✅ ${content.label} شما در تیکت <b>${escapeHtml(ticket.ticketId)}</b> ثبت شد.\n${statusLabel(ticket.status)}${warning}\n\nمی‌توانید پیام دیگری برای همین تیکت بفرستید.`,
        {
          inline_keyboard: [
            [{ text: "🔒 بستن تیکت", callback_data: `sup_close:${ticket.ticketId}` }, { text: "📂 تیکت‌های من", callback_data: "sup_list" }],
            [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
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
        await bot.sendMessage(chatId, `⚠️ ${error.safeMessage}`, { reply_markup: menuKeyboard() }).catch(() => {});
        return;
      }
      logSupportError("support_message_failed", error);
      await bot.sendMessage(chatId, "❌ مشکلی در ثبت پیام رخ داد. لطفاً دوباره تلاش کنید.", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }]] },
      }).catch(() => {});
    }
  });
};

export default supportMessageHandler;
