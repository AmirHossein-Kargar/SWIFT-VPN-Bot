import mongoose from "mongoose";

/**
 * HooshPay Invoice — stores the full lifecycle of a HooshPay payment.
 *
 * Fields:
 *   uid          — HooshPay's own invoice UID (returned on creation)
 *   orderId      — our unique order identifier sent to HooshPay
 *   userId       — Telegram user ID (Number) of the payer
 *   amount       — amount in Toman (IRR/10)
 *   paymentUrl   — HooshPay hosted payment page URL
 *   status       — current lifecycle state
 *   webhookLog   — array of raw webhook payloads received for audit / replay
 *   fulfilledAt  — timestamp when balance was credited (idempotency guard)
 *   createdAt    — record creation timestamp
 *   paidAt       — timestamp when payment was confirmed
 */
const hooshPayInvoiceSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  userId: { type: Number, required: true, index: true },
  amount: { type: Number, required: true },
  paymentUrl: { type: String, required: true },

  status: {
    type: String,
    enum: ["pending", "paid", "expired", "failed"],
    default: "pending",
    index: true,
  },

  // Anti-replay / idempotency guard — set to true only once per invoice
  fulfilled: { type: Boolean, default: false, index: true },
  fulfilledAt: { type: Date, default: null },

  // Timestamps
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date, default: null },

  // Raw webhook payloads for audit (array keeps every delivery)
  webhookLog: [
    {
      receivedAt: { type: Date, default: Date.now },
      payload: { type: mongoose.Schema.Types.Mixed },
    },
  ],
});

// Auto-expire pending invoices after 24 hours (TTL index on createdAt when status stays pending)
// Note: MongoDB TTL cannot be conditional — we handle cleanup in the recovery cron instead.

const HooshPayInvoice = mongoose.model("HooshPayInvoice", hooshPayInvoiceSchema);
export default HooshPayInvoice;
