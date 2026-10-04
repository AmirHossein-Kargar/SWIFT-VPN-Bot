import mongoose from "mongoose";

const adminAuditLogSchema = new mongoose.Schema({
  operationId: { type: String, required: true, unique: true, maxlength: 80 },
  actorTelegramId: { type: String, required: true, index: true },
  action: { type: String, required: true, maxlength: 80 },
  targetType: { type: String, default: null, maxlength: 40 },
  targetId: { type: String, default: null, maxlength: 160 },
  targetUserId: { type: String, default: null, maxlength: 32 },
  status: { type: String, enum: ["started", "succeeded", "failed", "interrupted"], default: "started", index: true },
  ipAddress: { type: String, default: null, maxlength: 64 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  errorCode: { type: String, default: null, maxlength: 80 },
  createdAt: { type: Date, default: Date.now, index: true },
  completedAt: { type: Date, default: null },
}, { minimize: false, versionKey: false });

adminAuditLogSchema.index({ actorTelegramId: 1, createdAt: -1 }, { name: "idx_admin_audit_actor_recent" });
adminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 }, { name: "idx_admin_audit_target_recent" });

export default mongoose.models.AdminAuditLog || mongoose.model("AdminAuditLog", adminAuditLogSchema);
