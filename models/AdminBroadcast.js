import mongoose from "mongoose";

const broadcastButtonSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 64 },
  url: { type: String, required: true, maxlength: 2048 },
}, { _id: false });

const adminBroadcastSchema = new mongoose.Schema({
  operationId: { type: String, required: true, unique: true, maxlength: 80 },
  adminTelegramId: { type: String, required: true, index: true },
  message: { type: String, required: true, maxlength: 4096 },
  audience: { type: String, enum: ["all", "active", "expired", "paying", "custom"], required: true, index: true },
  customTelegramIds: { type: [String], default: [] },
  buttons: { type: [broadcastButtonSchema], default: [] },
  status: {
    type: String,
    enum: ["queued", "running", "cancel_requested", "cancelled", "completed", "failed", "interrupted"],
    default: "queued",
    index: true,
  },
  total: { type: Number, default: 0, min: 0 },
  processed: { type: Number, default: 0, min: 0 },
  succeeded: { type: Number, default: 0, min: 0 },
  failed: { type: Number, default: 0, min: 0 },
  lastProcessedId: { type: mongoose.Schema.Types.ObjectId, default: null },
  lastErrorCode: { type: String, default: null, maxlength: 80 },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
}, { minimize: false, versionKey: false });

adminBroadcastSchema.index({ adminTelegramId: 1, createdAt: -1 }, { name: "idx_admin_broadcast_recent" });

export default mongoose.models.AdminBroadcast || mongoose.model("AdminBroadcast", adminBroadcastSchema);
