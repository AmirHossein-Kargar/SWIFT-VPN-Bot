/**
 * Orchestration shared by every entry point (Telegram bot, customer web area,
 * admin panel): persist first, then notify. A redelivered event is detected by
 * its dedupeKey and never notified twice.
 *
 * Conversations are not forwarded anywhere: admins read and answer them in the
 * panel's ticket inbox (see delivery.js for the only Telegram side effects).
 */
import {
  createTicket,
  addCustomerMessage,
  addAdminReply,
  changeStatus,
} from "./tickets.js";
import { alertNewTicket, deliverToCustomer, notifyStatusChange } from "./delivery.js";

export async function customerOpenTicket({ bot, userId, subject, text, attachment, dedupeKey, channel }, deps) {
  const result = await createTicket({ userId, subject, text, attachment, dedupeKey, channel }, deps);
  if (result.created) await alertNewTicket({ bot, ticketId: result.ticket.ticketId });
  return result;
}

export async function customerReply({ userId, ticketId, text, attachment, dedupeKey }, deps) {
  return addCustomerMessage({ ticketId, userId, text, attachment, dedupeKey }, deps);
}

export async function adminReply({ bot, adminId, ticketId, text, attachment, dedupeKey }, deps) {
  const result = await addAdminReply({ ticketId, adminId, text, attachment, dedupeKey }, deps);
  if (result.duplicate) return { ...result, delivered: null };
  const delivered = await deliverToCustomer({
    bot, customerId: result.customerId, ticket: result.ticket, message: result.message,
  });
  return { ...result, delivered };
}

export async function adminSetStatus({ bot, ticketId, status, adminId }, deps) {
  const result = await changeStatus({ ticketId, status, actor: { role: "admin", id: adminId } }, deps);
  if (result.changed) await notifyStatusChange({ bot, customerId: result.customerId, ticket: result.ticket });
  return result;
}

/** Customer-initiated close. Reopening is deliberately not offered: a closed ticket is final. */
export async function customerSetStatus({ userId, ticketId, status }, deps) {
  return changeStatus({ ticketId, status, actor: { role: "customer", id: userId } }, deps);
}
