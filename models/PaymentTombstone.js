import mongoose from "mongoose";

/**
 * Minimal immutable record kept after a cancelled/failed invoice is removed by
 * the 24h cleanup (services/payments/invoiceCleanup.js).
 *
 * It exists so that (a) a delayed provider notification for a removed invoice
 * is recognised and never credits anything, and (b) investigators can still see
 * that the invoice existed, who it belonged to, its amount and how it ended.
 * It deliberately holds no card data, addresses or payloads.
 */
const lateEventSchema = new mongoose.Schema({
  receivedAt: { type: Date, default: Date.now },
  status: { type: String, default: null, maxlength: 40 },
}, { _id: false });

const paymentTombstoneSchema = new mongoose.Schema({
  provider: { type: String, enum: ["hooshpay", "nowpayments", "bank", "trx"], required: true },
  // Provider-independent local reference (orderId for both providers).
  orderId: { type: String, required: true, maxlength: 80 },
  uid: { type: String, default: null, maxlength: 80 },
  invoiceId: { type: String, default: null, maxlength: 80 },
  paymentId: { type: String, default: null, maxlength: 80 },
  userId: { type: Number, default: null },
  // Same unit as the source invoice (Toman for both providers).
  amountToman: { type: Number, default: null },
  finalStatus: { type: String, required: true, maxlength: 40 },
  invoiceCreatedAt: { type: Date, default: null },
  terminalStatusAt: { type: Date, default: null },
  // Null until the source invoice is actually gone, so an interrupted run is visible.
  deletedAt: { type: Date, default: null },
  lateEventCount: { type: Number, default: 0 },
  lateEvents: { type: [lateEventSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

paymentTombstoneSchema.index({ provider: 1, orderId: 1 }, { unique: true, name: "uniq_tombstone_provider_order" });
paymentTombstoneSchema.index({ provider: 1, uid: 1 }, { name: "idx_tombstone_uid", sparse: true });
paymentTombstoneSchema.index({ provider: 1, paymentId: 1 }, { name: "idx_tombstone_payment", sparse: true });
paymentTombstoneSchema.index({ provider: 1, invoiceId: 1 }, { name: "idx_tombstone_invoice", sparse: true });

export default mongoose.models.PaymentTombstone || mongoose.model("PaymentTombstone", paymentTombstoneSchema);
