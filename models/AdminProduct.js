import mongoose from "mongoose";

const adminProductSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true, maxlength: 64 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  durationDays: { type: Number, required: true, min: 1, max: 3650 },
  trafficGb: { type: Number, required: true, min: 1, max: 100_000 },
  priceToman: { type: Number, required: true, min: 1, max: 2_000_000_000 },
  costToman: { type: Number, required: true, min: 0, max: 2_000_000_000 },
  enabled: { type: Boolean, default: true, index: true },
  displayOrder: { type: Number, default: 0, index: true },
  createdByOperationId: { type: String, default: null, unique: true, sparse: true, maxlength: 80 },
  createdBy: { type: String, default: null, maxlength: 32 },
  updatedBy: { type: String, default: null, maxlength: 32 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false, versionKey: false });

adminProductSchema.index({ enabled: 1, displayOrder: 1 }, { name: "idx_admin_products_enabled_order" });

export default mongoose.models.AdminProduct || mongoose.model("AdminProduct", adminProductSchema);
