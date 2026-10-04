import mongoose from "mongoose";

const systemHealthSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, maxlength: 40 },
  status: { type: String, enum: ["healthy", "degraded", "down", "unknown"], default: "unknown" },
  lastCheckedAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  latencyMs: { type: Number, default: null, min: 0 },
  lastError: { type: String, default: null, maxlength: 160 },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { minimize: false, versionKey: false });

export default mongoose.models.SystemHealth || mongoose.model("SystemHealth", systemHealthSchema);
