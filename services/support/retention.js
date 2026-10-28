/**
 * Deletion eligibility for support tickets. A ticket may be deleted only after
 * it has been closed for DELETE_ELIGIBLE_AFTER_MS, measured from the stored
 * `closedAt` (set by changeStatus at the moment of closing). Creation time and
 * last-message time never count. A closed ticket without a usable `closedAt`
 * (legacy data) is never eligible: the closing time is not guessed.
 *
 * Eligibility is a permission, not a schedule: nothing here deletes anything.
 */
import { CLOSED_STATUS_VALUES } from "../../models/SupportTicket.js";

export const DELETE_ELIGIBLE_AFTER_MS = 72 * 60 * 60 * 1000;

function closedTime(value) {
  const time = value instanceof Date ? value.getTime() : value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

/** @returns {{ eligible: boolean, reason: string, eligibleAt: Date|null }} */
export function ticketDeletionEligibility(ticket, now = new Date()) {
  if (!ticket || !CLOSED_STATUS_VALUES.includes(ticket.status)) {
    return { eligible: false, reason: "not_closed", eligibleAt: null };
  }
  const closed = closedTime(ticket.closedAt);
  if (closed === null) return { eligible: false, reason: "closed_time_unknown", eligibleAt: null };
  const eligibleAt = new Date(closed + DELETE_ELIGIBLE_AFTER_MS);
  if (eligibleAt.getTime() > now.getTime()) return { eligible: false, reason: "retention_not_elapsed", eligibleAt };
  return { eligible: true, reason: "closed_over_72h", eligibleAt };
}

/** Mongo filter equivalent to ticketDeletionEligibility, so the delete itself re-checks atomically. */
export function eligibleTicketFilter(ticketId, now = new Date()) {
  return {
    ticketId,
    status: { $in: [...CLOSED_STATUS_VALUES] },
    closedAt: { $lte: new Date(now.getTime() - DELETE_ELIGIBLE_AFTER_MS) },
  };
}

export const INELIGIBLE_MESSAGES = Object.freeze({
  not_closed: "Only closed tickets can be deleted.",
  closed_time_unknown: "This ticket has no recorded closing time, so it cannot be deleted.",
  retention_not_elapsed: "A ticket can be deleted 72 hours after it was closed.",
});
