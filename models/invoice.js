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
});

// The admin confirmation callback claims an invoice with a single atomic
// findOneAndUpdate on { paymentId, status: { $ne: "confirmed" } } — paymentId
// already carries a unique index (declared above), which makes that claim
// race-free.

// Receipt-approval queue and admin reports scan by status.
invoiceSchema.index({ status: 1, createdAt: -1 }, { name: "idx_invoice_status_recent" });

const invoice = mongoose.model("invoice", invoiceSchema);
export default invoice;
