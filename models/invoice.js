import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema({
  paymentId: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: Number,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  paymentType: {
    type: String,
    enum: ["bank", "crypto", "trx", "ton"],
    default: "bank",
  },
  status: {
    type: String,
    enum: ["unpaid", "pending", "waiting_for_approval", "paid", "confirmed", "rejected"],
    default: "unpaid",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  // Manual (card-to-card) confirmation audit trail.
  // Set exactly once by the atomic admin claim in handleCallbackQuery.
  confirmedAt: { type: Date, default: null },
  confirmedBy: { type: String, default: null },
  trackingCode: { type: String, default: null, maxlength: 128 },
  recoveryStatus: { type: String, enum: ["none", "required", "resolved"], default: "none", index: true },
  recoveryReason: { type: String, default: null, maxlength: 500 },
  recoveryResolvedAt: { type: Date, default: null },
  recoveryResolvedBy: { type: String, default: null },
  retryCount: { type: Number, default: 0, min: 0 },
  lastRetryAt: { type: Date, default: null },
  lastRetryOperationId: { type: String, default: null, maxlength: 80 },
  nextRetryAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, maxlength: 80 },
  rejectedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  receiptFileId: { type: String, default: null },
  receiptSubmittedAt: { type: Date, default: null },
  balanceCredited: { type: Boolean, default: false },
  balanceCreditedAt: { type: Date, default: null },
  creditLedgerVersion: { type: Number },
  notificationPending: { type: Boolean, default: false },
  notificationClaimedAt: { type: Date, default: null },
  notifiedAt: { type: Date, default: null },
});

// The admin confirmation callback claims an invoice with a single atomic
// findOneAndUpdate on { paymentId, status: { $ne: "confirmed" } } — paymentId
// already carries a unique index (declared above), which makes that claim
// race-free.

// Receipt-approval queue and admin reports scan by status.
invoiceSchema.index({ status: 1, createdAt: -1 }, { name: "idx_invoice_status_recent" });
invoiceSchema.index({ recoveryStatus: 1, status: 1, createdAt: 1 }, { name: "idx_invoice_recovery" });
invoiceSchema.index({ userId: 1, createdAt: -1 }, { name: "idx_invoice_user_recent" });

const invoice = mongoose.model("invoice", invoiceSchema);
export default invoice;
