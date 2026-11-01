import mongoose from "mongoose";

const adminProductSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true, maxlength: 64 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  durationDays: { type: Number, required: true, min: 1, max: 3650 },
  // 0 is unlimited traffic, which the provider must have switched on for this account (services/plans.js gates the sale).
  trafficGb: { type: Number, required: true, min: 0, max: 10_000 },
  priceToman: { type: Number, required: true, min: 1, max: 2_000_000_000 },
  costToman: { type: Number, required: true, min: 0, max: 2_000_000_000 },
  // enabled: available for NEW purchases (bot + storefront checkout).
  // published: listed on the public storefront. Neither affects customers who already bought.
  enabled: { type: Boolean, default: true, index: true },
  published: { type: Boolean, default: true },
  // Soft-delete marker. Absent = never archived; null = restored. Archived products are never sellable.
  archivedAt: { type: Date },
  archivedBy: { type: String, default: null, maxlength: 32 },
  // Set while a permanent delete is in progress; purchases refuse a locked product (see deleteProduct).
  deleteLockedAt: { type: Date },
  // Optimistic-concurrency counter; every admin write increments it.
  revision: { type: Number, default: 0, min: 0 },
  lastOperationId: { type: String, default: null, maxlength: 80 },
  displayOrder: { type: Number, default: 0, index: true },
  // No default: a stored null would still be indexed by the sparse unique index, so only one operation-less
  // product (e.g. a seeded one) could ever exist. Absent means "not created through the admin API".
  createdByOperationId: { type: String, default: undefined, unique: true, sparse: true, maxlength: 80 },
  createdBy: { type: String, default: null, maxlength: 32 },
  updatedBy: { type: String, default: null, maxlength: 32 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false, versionKey: false });

adminProductSchema.index({ enabled: 1, displayOrder: 1 }, { name: "idx_admin_products_enabled_order" });

export default mongoose.models.AdminProduct || mongoose.model("AdminProduct", adminProductSchema);
