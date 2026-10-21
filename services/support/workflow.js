/**
 * Orchestration shared by every entry point (Telegram bot, customer web area,
 * admin panel): persist first, then deliver. A redelivered event is detected
 * by its dedupeKey and never forwarded twice.
 */
import escapeHtml from "../../utils/escapeHtml.js";
import {
  createTicket,
  addCustomerMessage,
  addAdminReply,
  changeStatus,
} from "./tickets.js";
import { forwardToAdminGroup, deliverToCustomer, notifyStatusChange, statusLabel } from "./delivery.js";

export async function customerOpenTicket({ bot, from, userId, subject, text, attachment, dedupeKey, channel }, deps) {
  const result = await createTicket({ userId, subject, text, attachment, dedupeKey, channel }, deps);
  if (result.duplicate) return { ...result, forwarded: null };
  const forwarded = await forwardToAdminGroup({
    bot, ticket: result.ticket, message: result.message, from, userTelegramId: String(userId),
  });
  return { ...result, forwarded };
}

export async function customerReply({ bot, from, userId, ticketId, text, attachment, dedupeKey }, deps) {
  const result = await addCustomerMessage({ ticketId, userId, text, attachment, dedupeKey }, deps);
  if (result.duplicate) return { ...result, forwarded: null };
  const forwarded = await forwardToAdminGroup({
    bot, ticket: result.ticket, message: result.message, from, userTelegramId: String(userId),
  });
  return { ...result, forwarded };
}

export async function adminReply({ bot, adminId, ticketId, text, attachment, dedupeKey }, deps) {
  const result = await addAdminReply({ ticketId, adminId, text, attachment, dedupeKey }, deps);
  if (result.duplicate) return { ...result, delivered: null };
  const delivered = await deliverToCustomer({
    bot, customerId: result.customerId, ticket: result.ticket, message: result.message,
  });
  return { ...result, delivered };
}

export async function adminSetStatus({ bot, ticketId, status }, deps) {
  const result = await changeStatus({ ticketId, status, actor: { role: "admin" } }, deps);
  if (result.changed) await notifyStatusChange({ bot, customerId: result.customerId, ticket: result.ticket });
  return result;
}

/** Customer close/reopen. Support is told in the admin group so a closed ticket never lingers unnoticed. */
export async function customerSetStatus({ bot, userId, ticketId, status, groupId = process.env.GROUP_ID }, deps) {
  const result = await changeStatus({ ticketId, status, actor: { role: "customer", id: userId } }, deps);
  if (result.changed && bot && groupId) {
    try {
      await bot.sendMessage(groupId, `🎫 تیکت <b>${escapeHtml(ticketId)}</b> توسط مشتری تغییر وضعیت یافت: ${statusLabel(result.ticket.status)}`, { parse_mode: "HTML" });
    } catch (error) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), service: "support", level: "error", event: "group_notice_failed", errorType: error?.name || "Error" }));
    }
  }
  return result;
}
