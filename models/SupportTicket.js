import mongoose from "mongoose";

/**
 * Canonical lifecycle. Tickets written before the lifecycle was simplified may
 * still carry the aliases below; every reader normalizes them (see
 * normalizeTicketStatus) and the startup migration rewrites them.
 */
export const TICKET_STATUSES = Object.freeze(["open", "pending_customer", "closed"]);
export const LEGACY_STATUS_ALIASES = Object.freeze({ pending: "pending_customer", resolved: "closed" });
/** Every stored value that means "closed", canonical or legacy. */
export const CLOSED_STATUS_VALUES = Object.freeze(["closed", "resolved"]);

export function normalizeTicketStatus(status) {
  return LEGACY_STATUS_ALIASES[status] || status;
}

const supportTicketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true, maxlength: 16 },
  userTelegramId: { type: String, required: true, index: true },
  subject: { type: String, required: true, maxlength: 120 },
  status: { type: String, enum: TICKET_STATUSES, default: "open", index: true },
  channel: { type: String, enum: ["telegram", "web"], default: "telegram" },
  lastMessageAt: { type: Date, default: Date.now },
  lastMessageBy: { type: String, enum: ["customer", "admin"], default: "customer" },
  // Id of the newest message whose status/activity update was applied; lets a read detect and repair a crash between the two writes.
  lastMessageId: { type: String },
  unreadForAdmin: { type: Number, default: 0, min: 0 },
  unreadForCustomer: { type: Number, default: 0, min: 0 },
  messageCount: { type: Number, default: 0, min: 0 },
  // Creation is two writes (ticket, then its first message). The ticket stays
  // `provisional` (invisible everywhere) until the message exists; `createKey`
  // is the creating event's dedupeKey, unique so twins converge on one ticket.
  provisional: { type: Boolean, default: false },
  createKey: { type: String, maxlength: 120 },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, enum: ["customer", "admin", null], default: null },
  closedByAdminId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });

supportTicketSchema.index({ userTelegramId: 1, lastMessageAt: -1 }, { name: "idx_ticket_user_recent" });
supportTicketSchema.index({ status: 1, lastMessageAt: -1 }, { name: "idx_ticket_status_recent" });
supportTicketSchema.index({ createKey: 1 }, { unique: true, sparse: true, name: "idx_ticket_create_key" });

export default mongoose.models.SupportTicket || mongoose.model("SupportTicket", supportTicketSchema);
