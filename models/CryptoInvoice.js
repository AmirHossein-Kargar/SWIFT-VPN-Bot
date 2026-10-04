import mongoose from "mongoose";

/**
 * CryptoInvoice — TRX (Tron) top-up invoices.
 *
 * Lifecycle (enforced atomically by the scanner, not by a document hook):
 *   unpaid ──► paid      (wallet credited exactly once)
 *          └─► rejected  (on-chain transaction reverted)
 *
 * Two-phase credit tracking:
 *   status = "paid"           → Phase-1 claim (exactly one scanner can win)
 *   balanceCredited = true    → Phase-2 complete (wallet incremented)
 * A crash between the two phases leaves { status: "paid", balanceCredited:
 * false }, which the scanner completes on its next cycle.
 */
const cryptoInvoiceSchema = new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true },
  userId: { type: Number, required: true },
  amount: { type: Number, required: true }, // مبلغ تومانی
  usdAmount: { type: Number, required: true }, // مبلغ دلاری
  cryptoAmount: { type: Number, required: true }, // مبلغ ارز دیجیتال (مثل TRX)
  currency: { type: String, required: true },
  paymentType: {
    type: String,
    enum: ["trx", "ton", "usdt", "btc", "eth"],
    default: "trx",
  },
  status: {
    type: String,
    enum: ["unpaid", "paid", "rejected"],
    default: "unpaid",
  },
  // Sparse + unique: an on-chain transaction hash may settle at most ONE invoice.
  // A second invoice attempting to claim the same hash fails with E11000, which
  // the scanner treats as "already consumed".
  transactionHash: { type: String, unique: true, sparse: true },
  confirmedAt: { type: Date },
  rejectedAt: { type: Date },

  // Phase-2 tracking (mirrors models/HooshPayInvoice.js)
  balanceCredited: { type: Boolean, default: false },
  balanceCreditedAt: { type: Date, default: null },
  // Legacy paid invoices without a version are deliberately not auto-replayed.
  creditLedgerVersion: { type: Number },
  legacyReviewAlertedAt: { type: Date, default: null },
  notificationPending: { type: Boolean, default: false },
  notificationClaimedAt: { type: Date, default: null },
  notifiedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
});

// Scanner matching query: { status: "unpaid", paymentType: "trx", currency: "TRX" }
cryptoInvoiceSchema.index(
  { status: 1, paymentType: 1, currency: 1 },
  { name: "idx_crypto_match" }
);

// Crash-recovery sweep: { status: "paid", balanceCredited: false }
cryptoInvoiceSchema.index(
  { status: 1, balanceCredited: 1 },
  { name: "idx_crypto_recovery" }
);

const CryptoInvoice = mongoose.model("CryptoInvoice", cryptoInvoiceSchema);
export default CryptoInvoice;
