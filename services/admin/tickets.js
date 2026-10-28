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
import { assertClearConfirmation, clearAllTickets, deleteTickets, describeSkip } from "../support/deletion.js";
import { isOwnerUser } from "./adminRegistry.js";

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
  const data = await asAdmin(() => listAdminTickets({ status: status || undefined, query, unreadOnly: unreadOnly === true || unreadOnly === "1", page, pageSize }));
  return { ...data, canClearHistory: isOwnerUser(actorId) };
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

// ── Deletion ────────────────────────────────────────────────────────────────

const deletionShape = (r) => ({
  requested: r?.requested ?? 0,
  deleted: r?.deleted ?? 0,
  deletedIds: Array.isArray(r?.deletedIds) ? r.deletedIds : [],
  skipped: (Array.isArray(r?.skipped) ? r.skipped : []).map((item) => ({ ticketId: item.ticketId, reason: item.reason, message: describeSkip(item.reason) })),
  failed: Array.isArray(r?.failed) ? r.failed : [],
});

/** Deletes eligible tickets (closed 72h+). Any allowlisted admin; eligibility is re-checked per ticket at delete time. */
export async function deleteSupportTickets({ actorId, operationId, ticketIds, ipAddress, auditModel }) {
  assertAdminUser(actorId);
  const single = Array.isArray(ticketIds) && ticketIds.length === 1;
  const { result, replayed } = await asAdmin(() => runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: single ? "TICKET_DELETE" : "TICKET_BULK_DELETE",
    targetType: "ticket",
    targetId: single ? ticketIds[0] : null,
    ipAddress,
    metadata: { channel: "web", requested: Array.isArray(ticketIds) ? ticketIds.length : 0, ticketIds: Array.isArray(ticketIds) ? ticketIds.filter((id) => typeof id === "string").slice(0, 20) : [] },
    auditModel,
    execute: async () => {
      const outcome = await deleteTickets({ ticketIds }).catch((error) => { throw adminFailure(error); });
      if (single && outcome.deleted === 0) {
        const reason = outcome.skipped[0]?.reason;
        throw new AdminServiceError(outcome.failed.length ? "The ticket could not be deleted. Try again." : describeSkip(reason), { status: outcome.failed.length ? 503 : 409, code: outcome.failed.length ? "delete_failed" : `ticket_not_deletable_${reason}` });
      }
      return { ...outcome, auditSummary: outcome };
    },
  }));
  return { ...deletionShape(result), replayed };
}

let clearInFlight = false;

/** Owner-only, phrase-confirmed removal of the entire ticket history (open tickets included). */
export async function clearSupportHistory({ actorId, operationId, confirmation, ipAddress, auditModel }) {
  assertAdminUser(actorId);
  if (!isOwnerUser(actorId)) {
    throw new AdminServiceError("Only the primary owner can clear the ticket history.", { status: 403, code: "owner_only" });
  }
  try { assertClearConfirmation(confirmation); } catch (error) { throw adminFailure(error); }
  if (clearInFlight) throw new AdminServiceError("A history clear is already running.", { status: 409, code: "action_in_progress" });
  clearInFlight = true;
  try {
    const { result, replayed } = await asAdmin(() => runAuditedAction({
      actorTelegramId: actorId,
      operationId,
      action: "TICKET_HISTORY_CLEAR",
      targetType: "ticket_history",
      ipAddress,
      metadata: { channel: "web" },
      auditModel,
      execute: async () => {
        const outcome = await clearAllTickets();
        return { ...outcome, auditSummary: outcome };
      },
    }));
    return {
      complete: result?.complete === true,
      deletedTickets: result?.deletedTickets ?? 0,
      deletedMessages: result?.deletedMessages ?? 0,
      remaining: result?.remaining ?? null,
      newerKept: result?.newerKept ?? null,
      errorCode: result?.errorCode ?? null,
      replayed,
    };
  } finally {
    clearInFlight = false;
  }
}
