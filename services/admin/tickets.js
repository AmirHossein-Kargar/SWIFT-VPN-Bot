/**
 * Admin-panel operations on support tickets. Reads require an allowlisted
 * admin; replies and status changes are audited and idempotent per
 * operationId, so a double click or a retried request cannot send a second
 * reply (the audit row short-circuits the replay and the message dedupeKey is
 * derived from the same operationId).
 */
import { default as botInstance } from "../../config/botInstance.js";
import { assertAdminUser } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { listAdminTickets, getAdminTicket, getTicketUpdates } from "../support/tickets.js";
import { adminReply, adminSetStatus } from "../support/workflow.js";

export async function listSupportTickets({ actorId, status, query, unreadOnly, page, pageSize }) {
  assertAdminUser(actorId);
  return listAdminTickets({ status: status || undefined, query, unreadOnly: unreadOnly === true || unreadOnly === "1", page, pageSize });
}

export async function getSupportTicket({ actorId, ticketId }) {
  assertAdminUser(actorId);
  return getAdminTicket({ ticketId });
}

export async function getSupportTicketUpdates({ actorId, ticketId, afterId, markRead }) {
  assertAdminUser(actorId);
  return getTicketUpdates({ audience: "admin", ticketId, afterId, markRead: markRead === true || markRead === "1" });
}

export async function replyToSupportTicket({ actorId, operationId, ticketId, text, ipAddress, bot = botInstance.bot, auditModel }) {
  assertAdminUser(actorId);
  const { result, replayed } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "TICKET_REPLY",
    targetType: "ticket",
    targetId: ticketId,
    ipAddress,
    metadata: { channel: "web" },
    auditModel,
    execute: async () => {
      const outcome = await adminReply({ bot, adminId: actorId, ticketId, text, dedupeKey: `web-admin:${operationId}` });
      return {
        ticketId,
        delivered: outcome.duplicate ? null : outcome.delivered,
        auditSummary: { ticketId, delivered: outcome.duplicate ? null : outcome.delivered },
      };
    },
  });
  return { ticketId, delivered: result?.delivered ?? null, replayed };
}

export async function setSupportTicketStatus({ actorId, operationId, ticketId, status, ipAddress, bot = botInstance.bot, auditModel }) {
  assertAdminUser(actorId);
  const { result, replayed } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "TICKET_STATUS",
    targetType: "ticket",
    targetId: ticketId,
    ipAddress,
    metadata: { channel: "web", status },
    auditModel,
    execute: async () => {
      const outcome = await adminSetStatus({ bot, ticketId, status });
      return { ticketId, status: outcome.ticket.status, auditSummary: { ticketId, status: outcome.ticket.status } };
    },
  });
  return { ticketId, status: result?.status ?? status, replayed };
}
