/**
 * Permanent removal of support tickets and their messages.
 *
 *  - deleteTickets: eligible (closed 72h+) tickets only. The ticket row is
 *    removed with a conditional delete that re-checks eligibility in the same
 *    atomic operation, so a stale selection can never remove an ineligible
 *    ticket. Its messages are removed right after; a crash in between leaves
 *    orphan messages that a retry (or clearAllTickets) cleans up.
 *  - clearAllTickets: the whole history, in bounded batches, restricted to
 *    tickets that existed when it started (tickets created meanwhile are kept
 *    and reported). Safe to run again after a partial failure.
 *
 * Only SupportTicket and SupportTicketMessage are touched; audit logs, users,
 * payments etc. are other collections. Audit and authorization live in
 * services/admin/tickets.js.
 */
import { getSupportModels, isValidTicketId, SupportError } from "./tickets.js";
import { eligibleTicketFilter, INELIGIBLE_MESSAGES, ticketDeletionEligibility } from "./retention.js";

export const MAX_BULK_DELETE = 20;
export const CLEAR_BATCH_SIZE = 200;
export const CLEAR_CONFIRMATION_PHRASE = "CLEAR ALL TICKET HISTORY";

const fail = (message, code, status = 400) => new SupportError(message, { status, code, adminMessage: message });

async function deleteOneTicket({ Ticket, Message }, ticketId, now) {
  if (!isValidTicketId(ticketId)) return { ticketId, outcome: "skipped", reason: "invalid_id" };
  const ticket = await Ticket.findOne({ ticketId }).lean();
  if (!ticket) {
    // Already gone: sweep any messages a crashed earlier delete left behind.
    await Message.deleteMany({ ticketId });
    return { ticketId, outcome: "skipped", reason: "not_found" };
  }
  const { eligible, reason } = ticketDeletionEligibility(ticket, now);
  if (!eligible) return { ticketId, outcome: "skipped", reason };
  const removed = await Ticket.deleteOne(eligibleTicketFilter(ticketId, now));
  if (!removed?.deletedCount) return { ticketId, outcome: "skipped", reason: "changed" };
  await Message.deleteMany({ ticketId });
  return { ticketId, outcome: "deleted" };
}

/** @returns {{ requested, deleted, deletedIds, skipped: {ticketId, reason}[], failed: {ticketId}[] }} */
export async function deleteTickets({ ticketIds, now = new Date() }, deps = {}) {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) throw fail("Select at least one ticket.", "no_tickets_selected");
  if (ticketIds.length > MAX_BULK_DELETE) throw fail(`At most ${MAX_BULK_DELETE} tickets can be deleted at once.`, "too_many_tickets");
  if (!ticketIds.every((id) => typeof id === "string")) throw fail("Invalid ticket selection.", "invalid_selection");
  const ids = [...new Set(ticketIds)];
  const models = getSupportModels(deps);

  const deletedIds = [];
  const skipped = [];
  const failed = [];
  for (const ticketId of ids) {
    try {
      const result = await deleteOneTicket(models, ticketId, now);
      if (result.outcome === "deleted") deletedIds.push(ticketId);
      else skipped.push({ ticketId, reason: result.reason });
    } catch {
      failed.push({ ticketId });
    }
  }
  return { requested: ids.length, deleted: deletedIds.length, deletedIds, skipped, failed };
}

export function assertClearConfirmation(phrase) {
  if (typeof phrase !== "string" || phrase !== CLEAR_CONFIRMATION_PHRASE) {
    throw fail(`Type "${CLEAR_CONFIRMATION_PHRASE}" exactly to confirm.`, "confirmation_required");
  }
}

/**
 * @returns {{ complete: boolean, deletedTickets, deletedMessages, remaining, newerKept, errorCode }}
 * `complete` is true only when no ticket that existed at the start remains.
 */
export async function clearAllTickets({ startedAt = new Date() } = {}, deps = {}) {
  const { Ticket, Message } = getSupportModels(deps);
  const existed = { createdAt: { $lte: startedAt } };
  let deletedTickets = 0;
  let deletedMessages = 0;
  let errorCode = null;
  try {
    for (;;) {
      const batch = await Ticket.find(existed).sort({ _id: 1 }).limit(CLEAR_BATCH_SIZE).lean();
      if (batch.length === 0) break;
      const ids = batch.map((ticket) => ticket.ticketId);
      const messages = await Message.deleteMany({ ticketId: { $in: ids } });
      const tickets = await Ticket.deleteMany({ ticketId: { $in: ids } });
      deletedMessages += messages?.deletedCount ?? 0;
      deletedTickets += tickets?.deletedCount ?? 0;
      if (!tickets?.deletedCount) throw Object.assign(new Error("no progress"), { code: "clear_no_progress" });
    }
    // Orphan messages (a crashed earlier delete): those whose ticket no longer exists.
    let cursor = null;
    for (;;) {
      const filter = { createdAt: { $lte: startedAt }, ...(cursor ? { _id: { $gt: cursor } } : {}) };
      const page = await Message.find(filter).sort({ _id: 1 }).limit(CLEAR_BATCH_SIZE).lean();
      if (page.length === 0) break;
      cursor = page[page.length - 1]._id;
      const ids = [...new Set(page.map((message) => message.ticketId))];
      const live = new Set((await Ticket.find({ ticketId: { $in: ids } }).lean()).map((ticket) => ticket.ticketId));
      const orphans = ids.filter((id) => !live.has(id));
      if (orphans.length) deletedMessages += (await Message.deleteMany({ ticketId: { $in: orphans }, createdAt: { $lte: startedAt } }))?.deletedCount ?? 0;
    }
  } catch (error) {
    errorCode = typeof error?.code === "string" ? error.code : "clear_interrupted";
  }
  let remaining = null;
  let newerKept = null;
  try {
    [remaining, newerKept] = await Promise.all([
      Ticket.countDocuments(existed),
      Ticket.countDocuments({ createdAt: { $gt: startedAt } }),
    ]);
  } catch {
    errorCode = errorCode || "verification_failed";
  }
  return { complete: errorCode === null && remaining === 0, deletedTickets, deletedMessages, remaining, newerKept, errorCode };
}

export function describeSkip(reason) {
  return INELIGIBLE_MESSAGES[reason]
    || { not_found: "Ticket no longer exists.", invalid_id: "Invalid ticket id.", changed: "Ticket changed and was not deleted." }[reason]
    || "Skipped.";
}
