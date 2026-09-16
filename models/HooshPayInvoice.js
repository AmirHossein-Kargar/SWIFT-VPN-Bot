import mongoose from "mongoose";

/**
 * HooshPay Invoice — full lifecycle of a HooshPay payment.
 *
 * Two-phase delivery tracking (fixes crash-between-writes risk):
 *   fulfilled      — set to true when the DB write for fulfilled started (atomic lock)
 *   balanceCredited — set to true only after User.balance was actually incremented
 *
 * Recovery cron queries: { fulfilled: true, balanceCredited: false }
 * and re-runs the balance credit step safely.
 */
const hooshPayInvoiceSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  userId: { type: Number, required: true, index: true },
  amount: { type: Number, required: true },
  paymentUrl: { type: String, required: true },

  status: {
    type: String,
    enum: ["pending", "paid", "expired", "failed", "reversed"],
    default: "pending",
    index: true,
  },

  // Phase-1 lock: flipped atomically by findOneAndUpdate({fulfilled:false})
  fulfilled: { type: Boolean, default: false, index: true },
  fulfilledAt: { type: Date, default: null },

  // Phase-2 confirmation: set AFTER User.balance has been incremented
  balanceCredited: { type: Boolean, default: false, index: true },
  balanceCreditedAt: { type: Date, default: null },

  // Timestamps
  createdAt: { type: Date, default: Date.now, index: true },
  paidAt: { type: Date, default: null },

  // Raw webhook payloads for audit/replay (one entry per delivery)
  webhookLog: [
    {
      receivedAt: { type: Date, default: Date.now },
      payload: { type: mongoose.Schema.Types.Mixed },
    },
  ],
});

const HooshPayInvoice = mongoose.model("HooshPayInvoice", hooshPayInvoiceSchema);
export default HooshPayInvoice;
