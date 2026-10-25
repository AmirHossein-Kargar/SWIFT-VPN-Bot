/**
 * Admin-panel operations on support tickets. Reads require an allowlisted
 * admin; replies and status changes are audited and idempotent per
 * operationId, so a double click or a retried request cannot send a second
 * reply (the audit row short-circuits the replay and the message dedupeKey is
 * derived from the same operationId).
 *
 * Failures reach the panel in English: SupportError carries both the
 * customer-facing Persian text and an English admin text, and this layer
 * always surfaces the latter (toAdminError).
 */
import { default as botInstance } from "../../config/botInstance.js";
import { AdminServiceError, assertAdminUser } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import {
  listAdminTickets,
  getAdminTicket,
  getTicketUpdates,
  listTicketMessages,
  SupportError,
} from "../support/tickets.js";
import { adminReply, adminSetStatus } from "../support/workflow.js";

/**
 * Ticket failures reach the panel as AdminServiceError with the English text.
 * This matters inside runAuditedAction too: it passes AdminServiceError through
 * but masks any other error behind a generic message.
 */
function adminFailure(error) {
  return error instanceof SupportError ? new AdminServiceError(error.adminMessage, { status: error.status, code: error.code }) : error;
}

async function asAdmin(work) {
  try {
    return await work();
  } catch (error) {
    throw adminFailure(error);
  }
}

export async function listSupportTickets({ actorId, status, query, unreadOnly, page, pageSize }) {
  assertAdminUser(actorId);
  return asAdmin(() => listAdminTickets({ status: status || undefined, query, unreadOnly: unreadOnly === true || unreadOnly === "1", page, pageSize }));
}

export async function getSupportTicket({ actorId, ticketId, limit }) {
  assertAdminUser(actorId);
  return asAdmin(() => getAdminTicket({ ticketId, limit }));
}

export async function getSupportTicketUpdates({ actorId, ticketId, afterId, markRead }) {
  assertAdminUser(actorId);
  return asAdmin(() => getTicketUpdates({ audience: "admin", ticketId, afterId, markRead: markRead === true || markRead === "1" }));
}

export async function getSupportTicketHistory({ actorId, ticketId, beforeId, limit }) {
  assertAdminUser(actorId);
  return asAdmin(() => listTicketMessages({ audience: "admin", ticketId, beforeId, limit }));
}

export async function replyToSupportTicket({ actorId, operationId, ticketId, text, ipAddress, bot = botInstance.bot, auditModel }) {
  assertAdminUser(actorId);
  const { result, replayed } = await asAdmin(() => runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "TICKET_REPLY",
    targetType: "ticket",
    targetId: ticketId,
    ipAddress,
    metadata: { channel: "web" },
    auditModel,
    execute: async () => {
      const outcome = await adminReply({ bot, adminId: actorId, ticketId, text, dedupeKey: `web-admin:${operationId}` }).catch((error) => { throw adminFailure(error); });
      return {
        ticketId,
        status: outcome.ticket.status,
        messageId: outcome.message?._id ? String(outcome.message._id) : null,
        delivered: outcome.duplicate ? null : outcome.delivered,
        auditSummary: { ticketId, status: outcome.ticket.status, delivered: outcome.duplicate ? null : outcome.delivered },
      };
    },
  }));
  return { ticketId, status: result?.status ?? null, messageId: result?.messageId ?? null, delivered: result?.delivered ?? null, replayed };
}

export async function setSupportTicketStatus({ actorId, operationId, ticketId, status, ipAddress, bot = botInstance.bot, auditModel }) {
  assertAdminUser(actorId);
  const { result, replayed } = await asAdmin(() => runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "TICKET_STATUS",
    targetType: "ticket",
    targetId: ticketId,
    ipAddress,
    metadata: { channel: "web", status },
    auditModel,
    execute: async () => {
      const outcome = await adminSetStatus({ bot, ticketId, status, adminId: actorId }).catch((error) => { throw adminFailure(error); });
      return {
        ticketId,
        status: outcome.ticket.status,
        changed: outcome.changed,
        auditSummary: { ticketId, status: outcome.ticket.status, changed: outcome.changed },
      };
    },
  }));
  return { ticketId, status: result?.status ?? status, changed: result?.changed ?? null, replayed };
}
