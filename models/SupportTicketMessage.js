import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema({
  kind: { type: String, enum: ["photo", "video"], required: true },
  fileId: { type: String, required: true, maxlength: 256 },
  fileSize: { type: Number, default: null },
}, { _id: false });

const supportTicketMessageSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, index: true },
  author: { type: String, enum: ["customer", "admin"], required: true },
  authorAdminId: { type: String, default: null },
  text: { type: String, default: "", maxlength: 4000 },
  attachment: { type: attachmentSchema, default: null },
  // Unique per inbound event (Telegram chat+message id, or a web operation id)
  // so a redelivered update or a double-submitted form cannot add a second row.
  dedupeKey: { type: String, required: true, unique: true, maxlength: 120 },
  // Ids of the copies posted in the admin group, used to route a Telegram
  // "reply" back to this ticket after a restart.
  groupMessageIds: { type: [Number], default: [] },
  delivery: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

supportTicketMessageSchema.index({ ticketId: 1, createdAt: 1 }, { name: "idx_ticket_message_order" });
supportTicketMessageSchema.index({ groupMessageIds: 1 }, { name: "idx_ticket_message_group" });

export default mongoose.models.SupportTicketMessage || mongoose.model("SupportTicketMessage", supportTicketMessageSchema);
