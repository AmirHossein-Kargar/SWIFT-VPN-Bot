/**
 * Admin-group side of the ticket workflow. An authorized admin replies (Telegram
 * "Reply") to the bot's copy of a ticket message and the reply is delivered to
 * that ticket's customer. Reply-to is matched against stored group message ids,
 * so routing survives restarts. Replying "/resolve", "/close", "/reopen" or
 * "/pending" changes the status instead. Returns true when the message was a
 * ticket reply (handled or rejected) so no other group handler also runs.
 */
import { isAdmin } from "../../utils/auth.js";
import { findTicketByGroupMessage, SupportError } from "../../services/support/tickets.js";
import { adminReply, adminSetStatus } from "../../services/support/workflow.js";
import { logSupportError } from "./supportFlow.js";

const COMMANDS = Object.freeze({ "/resolve": "resolved", "/close": "closed", "/reopen": "open", "/pending": "pending" });

function extractReply(msg) {
  if (typeof msg.text === "string" && msg.text) return { text: msg.text, attachment: null };
  if (msg.photo?.length) {
    const photo = msg.photo[msg.photo.length - 1];
    return { text: msg.caption || "", attachment: { kind: "photo", fileId: photo.file_id, fileSize: photo.file_size } };
  }
  if (msg.video) return { text: msg.caption || "", attachment: { kind: "video", fileId: msg.video.file_id, fileSize: msg.video.file_size } };
  return null;
}

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

  const say = (text) => bot.sendMessage(msg.chat.id, text, { reply_to_message_id: msg.message_id }).catch(() => {});

  try {
    const command = typeof msg.text === "string" ? COMMANDS[msg.text.trim().split(/[\s@]/)[0].toLowerCase()] : null;
    if (command) {
      await adminSetStatus({ bot, ticketId: ticket.ticketId, status: command });
      await say(`✅ وضعیت تیکت ${ticket.ticketId} تغییر کرد.`);
      return true;
    }
    const content = extractReply(msg);
    if (!content) {
      await say("⚠️ فقط متن، عکس و فیلم قابل ارسال به مشتری است.");
      return true;
    }
    const result = await adminReply({
      bot,
      adminId: msg.from.id,
      ticketId: ticket.ticketId,
      text: content.text,
      attachment: content.attachment,
      dedupeKey: `tg-admin:${msg.chat.id}:${msg.message_id}`,
    });
    if (result.duplicate) return true;
    await say(result.delivered
      ? `✅ پاسخ به مشتری (تیکت ${ticket.ticketId}) ارسال شد.`
      : `⚠️ پاسخ در تیکت ${ticket.ticketId} ذخیره شد اما ارسال به مشتری ناموفق بود (ممکن است ربات را مسدود کرده باشد).`);
  } catch (error) {
    if (error instanceof SupportError) {
      await say(`⚠️ ${error.safeMessage}`);
    } else {
      logSupportError("group_reply_failed", error);
      await say("❌ خطا در پردازش پاسخ. دوباره تلاش کنید.");
    }
  }
  return true;
}
