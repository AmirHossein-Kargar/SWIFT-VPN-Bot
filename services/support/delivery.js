/**
 * Telegram side of the support workflow: copies customer messages into the
 * admin group (with the ticket id) and delivers admin replies to customers.
 *
 * Persistence has already happened by the time these run, so a Telegram
 * failure never loses a message: the row is marked `failed` and stays visible
 * in the panel. Errors are logged by type/status only — never message text,
 * file ids or user data.
 */
import escapeHtml from "../../utils/escapeHtml.js";
import { recordGroupMessage, recordDelivery } from "./tickets.js";

const STATUS_LABELS = Object.freeze({
  open: "🟢 باز",
  pending: "🟡 در انتظار پاسخ مشتری",
  resolved: "🔵 حل‌شده",
  closed: "⚫️ بسته",
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function logFailure(event, error) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "support",
    level: "error",
    event,
    errorType: error?.name || "Error",
    status: Number(error?.response?.statusCode) || undefined,
  }));
}

function customerLabel(from) {
  const name = from?.first_name ? escapeHtml(String(from.first_name).slice(0, 40)) : "نامشخص";
  const username = from?.username ? `@${escapeHtml(from.username)}` : "ندارد";
  return { name, username };
}

/** Header placed at the top of every copy in the admin group; the ticket id is what admins reply against. */
export function buildGroupHeader({ ticket, from, userTelegramId }) {
  const { name, username } = customerLabel(from);
  return (
    `🎫 <b>تیکت ${escapeHtml(ticket.ticketId)}</b> — ${statusLabel(ticket.status)}\n` +
    `📌 ${escapeHtml(ticket.subject)}\n` +
    `👤 ${name} | ${username} | <code>${escapeHtml(userTelegramId)}</code>\n` +
    `↩️ برای پاسخ، روی همین پیام «Reply» بزنید.`
  );
}

/**
 * Posts a customer message into the admin group. Returns true when Telegram
 * accepted every part; the group message ids are stored for reply routing.
 */
export async function forwardToAdminGroup({ bot, groupId = process.env.GROUP_ID, ticket, message, from, userTelegramId }) {
  if (!groupId || !bot) {
    await recordDelivery({ dedupeKey: message.dedupeKey, delivery: "failed" }).catch(() => {});
    return false;
  }
  const header = buildGroupHeader({ ticket, from, userTelegramId });
  const body = message.text ? `\n\n${escapeHtml(message.text)}` : "";
  try {
    const sent = [];
    if (message.attachment) {
      const send = message.attachment.kind === "photo" ? bot.sendPhoto.bind(bot) : bot.sendVideo.bind(bot);
      sent.push(await send(groupId, message.attachment.fileId, { caption: header, parse_mode: "HTML" }));
      if (message.text) {
        sent.push(await bot.sendMessage(groupId, `💬 ${escapeHtml(message.text)}`, {
          parse_mode: "HTML",
          reply_to_message_id: sent[0].message_id,
        }));
      }
    } else {
      sent.push(await bot.sendMessage(groupId, `${header}${body}`, { parse_mode: "HTML" }));
    }
    for (const item of sent) {
      await recordGroupMessage({ dedupeKey: message.dedupeKey, groupMessageId: item?.message_id });
    }
    return true;
  } catch (error) {
    logFailure("group_forward_failed", error);
    await recordDelivery({ dedupeKey: message.dedupeKey, delivery: "failed" }).catch(() => {});
    return false;
  }
}

export function customerTicketKeyboard(ticketId, { closed = false } = {}) {
  const row = closed
    ? [{ text: "🔓 بازگشایی تیکت", callback_data: `sup_reopen:${ticketId}` }]
    : [
        { text: "💬 ادامه گفتگو", callback_data: `sup_open:${ticketId}` },
        { text: "🔒 بستن تیکت", callback_data: `sup_close:${ticketId}` },
      ];
  return { inline_keyboard: [row, [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }]] };
}

/** Sends an admin reply to the ticket owner. Returns true only when Telegram accepted it. */
export async function deliverToCustomer({ bot, customerId, ticket, message }) {
  if (!bot) return false;
  const header = `🎫 <b>پاسخ پشتیبانی — تیکت ${escapeHtml(ticket.ticketId)}</b>`;
  const reply_markup = customerTicketKeyboard(ticket.ticketId);
  try {
    if (message.attachment) {
      const send = message.attachment.kind === "photo" ? bot.sendPhoto.bind(bot) : bot.sendVideo.bind(bot);
      const caption = `${header}${message.text ? `\n\n${escapeHtml(message.text).slice(0, 800)}` : ""}`;
      await send(customerId, message.attachment.fileId, { caption, parse_mode: "HTML", reply_markup });
    } else {
      await bot.sendMessage(customerId, `${header}\n\n${escapeHtml(message.text)}`, { parse_mode: "HTML", reply_markup });
    }
    await recordDelivery({ dedupeKey: message.dedupeKey, delivery: "sent" });
    return true;
  } catch (error) {
    logFailure("customer_delivery_failed", error);
    await recordDelivery({ dedupeKey: message.dedupeKey, delivery: "failed" }).catch(() => {});
    return false;
  }
}

/** Best-effort notice to the customer when support changes the ticket status. */
export async function notifyStatusChange({ bot, customerId, ticket }) {
  if (!bot) return false;
  try {
    await bot.sendMessage(customerId, `🎫 وضعیت تیکت <b>${escapeHtml(ticket.ticketId)}</b> تغییر کرد: ${statusLabel(ticket.status)}`, {
      parse_mode: "HTML",
      reply_markup: customerTicketKeyboard(ticket.ticketId, { closed: ticket.status === "closed" }),
    });
    return true;
  } catch (error) {
    logFailure("status_notice_failed", error);
    return false;
  }
}
