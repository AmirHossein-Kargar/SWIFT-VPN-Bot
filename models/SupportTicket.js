import mongoose from "mongoose";

export const TICKET_STATUSES = Object.freeze(["open", "pending", "resolved", "closed"]);

const supportTicketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true, maxlength: 16 },
  userTelegramId: { type: String, required: true, index: true },
  subject: { type: String, required: true, maxlength: 120 },
  status: { type: String, enum: TICKET_STATUSES, default: "open", index: true },
  channel: { type: String, enum: ["telegram", "web"], default: "telegram" },
  lastMessageAt: { type: Date, default: Date.now },
  lastMessageBy: { type: String, enum: ["customer", "admin"], default: "customer" },
  unreadForAdmin: { type: Number, default: 0, min: 0 },
  unreadForCustomer: { type: Number, default: 0, min: 0 },
  messageCount: { type: Number, default: 0, min: 0 },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, enum: ["customer", "admin", null], default: null },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });

supportTicketSchema.index({ userTelegramId: 1, lastMessageAt: -1 }, { name: "idx_ticket_user_recent" });
supportTicketSchema.index({ status: 1, lastMessageAt: -1 }, { name: "idx_ticket_status_recent" });

export default mongoose.models.SupportTicket || mongoose.model("SupportTicket", supportTicketSchema);
