/**
 * Telegram side of the support workflow: tells customers about admin replies
 * and closures. The admin panel's ticket inbox is the only place conversations
 * are read and answered, so no message body, attachment or customer identity is
 * ever copied into the admin group. The group can optionally receive one
 * content-free "new ticket" alert (SUPPORT_GROUP_ALERTS=1).
 *
 * Persistence has already happened by the time these run, so a Telegram
 * failure never loses a message: the row is marked `failed` and stays visible
 * in the panel. Errors are logged by type/status only — never message text,
 * file ids or user data.
 */
import { recordDelivery } from "./tickets.js";
import {
  SUPPORT_COPY,
  customerStatusLabel,
  groupNewTicketAlert,
  ticketClosedNotice,
} from "../../messages/supportCopy.js";

/** Persian status label for customer-facing surfaces. */
export function statusLabel(status) {
  return customerStatusLabel(status);
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

const HOME_ROW = [{ text: SUPPORT_COPY.backToMenu, callback_data: "back_to_home" }];

/** Buttons under a notification: jump straight into the ticket, or start a new one when it is closed. */
export function customerTicketKeyboard(ticketId, { closed = false } = {}) {
  const row = closed
    ? [{ text: SUPPORT_COPY.newTicket, callback_data: "sup_new" }, { text: SUPPORT_COPY.myTickets, callback_data: "sup_list" }]
    : [{ text: SUPPORT_COPY.viewTicket, callback_data: `sup_open:${ticketId}` }];
  return { inline_keyboard: [row, HOME_ROW] };
}

function panelBaseUrl() {
  const raw = String(process.env.WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(raw) ? raw : null;
}

export function groupAlertsEnabled() {
  return ["1", "true"].includes(String(process.env.SUPPORT_GROUP_ALERTS || "").trim().toLowerCase());
}

/**
 * Optional, content-free heads-up in the admin group that a NEW ticket exists.
 * It carries the ticket id and a panel link only: no subject, text, name,
 * username or Telegram id. Off by default; failures never affect the ticket.
 */
export async function alertNewTicket({ bot, ticketId, groupId = process.env.GROUP_ID }) {
  if (!bot || !groupId || !groupAlertsEnabled()) return false;
  const base = panelBaseUrl();
  try {
    await bot.sendMessage(groupId, groupNewTicketAlert(ticketId), base
      ? { reply_markup: { inline_keyboard: [[{ text: SUPPORT_COPY.groupOpenPanel, url: `${base}/panel/tickets?t=${ticketId}` }]] } }
      : undefined);
    return true;
  } catch (error) {
    logFailure("group_alert_failed", error);
    return false;
  }
}

/**
 * Tells the ticket owner that support replied. The reply itself is read inside
 * the ticket, so the notification carries no message text. Returns true only
 * when Telegram accepted the notification.
 */
export async function deliverToCustomer({ bot, customerId, ticket, message }) {
  if (!bot) return false;
  try {
    await bot.sendMessage(customerId, SUPPORT_COPY.adminReply, { reply_markup: customerTicketKeyboard(ticket.ticketId) });
    await recordDelivery({ dedupeKey: message.dedupeKey, delivery: "sent" });
    return true;
  } catch (error) {
    logFailure("customer_delivery_failed", error);
    await recordDelivery({ dedupeKey: message.dedupeKey, delivery: "failed" }).catch(() => {});
    return false;
  }
}

/** Best-effort notice to the customer when support closes their ticket. Other status changes are internal. */
export async function notifyStatusChange({ bot, customerId, ticket }) {
  if (!bot || ticket.status !== "closed") return false;
  try {
    await bot.sendMessage(customerId, ticketClosedNotice(ticket.ticketId), { reply_markup: customerTicketKeyboard(ticket.ticketId, { closed: true }) });
    return true;
  } catch (error) {
    logFailure("status_notice_failed", error);
    return false;
  }
}
