import mongoose from "mongoose";

/**
 * HooshPayInvoice
 * ---------------
 * Full lifecycle of a HooshPay payment with two-phase write tracking.
 *
 * Allowed state transitions (enforced by pre-save hook):
 *   pending  → paid | expired | failed | reversed
 *   paid     → reversed                              (refund only)
 *   expired  → (terminal — no transitions allowed)
 *   failed   → (terminal — no transitions allowed)
 *   reversed → (terminal — no transitions allowed)
 *
 * Phase tracking:
 *   fulfilled      — Phase-1 lock (set atomically by findOneAndUpdate)
 *   balanceCredited — Phase-2 completion (set after User.balance incremented)
 *
 * Compound indexes optimise the two most-frequent query patterns:
 *   - Recovery cron: { fulfilled, balanceCredited, status }
 *   - Expiry cron:   { status, createdAt }
 */

const TERMINAL_STATES = new Set(["expired", "failed", "reversed"]);

const ALLOWED_TRANSITIONS = {
  pending:  new Set(["paid", "expired", "failed", "reversed"]),
  paid:     new Set(["reversed"]),
  expired:  new Set(),
  failed:   new Set(),
  reversed: new Set(),
};

const hooshPayInvoiceSchema = new mongoose.Schema({
  uid:        { type: String, required: true, unique: true },
  orderId:    { type: String, required: true, unique: true },
  userId:     { type: Number, required: true },
  amount:     { type: Number, required: true },
  paymentUrl: { type: String, required: true },

  status: {
    type: String,
    enum: ["pending", "paid", "expired", "failed", "reversed"],
    default: "pending",
  },

  // Phase-1 lock
  fulfilled:    { type: Boolean, default: false },
  fulfilledAt:  { type: Date, default: null },

  // Phase-2 completion
  balanceCredited:    { type: Boolean, default: false },
  balanceCreditedAt:  { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  paidAt:    { type: Date, default: null },

  // Webhook audit log
  webhookLog: [
    {
      receivedAt: { type: Date, default: Date.now },
      payload:    { type: mongoose.Schema.Types.Mixed },
    },
  ],
});

// ── State-transition guard ────────────────────────────────────────────────────
hooshPayInvoiceSchema.pre("save", function (next) {
  if (!this.isModified("status")) return next();

  const from = this.$__.priorDoc?.status ?? null;
  const to   = this.status;

  // On new document, any initial status is allowed
  if (this.isNew) return next();

  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) {
    return next(new Error(`HooshPayInvoice: unknown source status "${from}"`));
  }
  if (!allowed.has(to)) {
    return next(
      new Error(`HooshPayInvoice: illegal transition "${from}" → "${to}" for uid=${this.uid}`)
    );
  }
  next();
});

// Note: findOneAndUpdate/updateMany bypass the pre-save hook by design — those
// paths use direct field sets where transitions are known to be valid (e.g.,
// fulfillHooshOrder always goes pending→paid, cron always goes pending→expired).

// ── Indexes ───────────────────────────────────────────────────────────────────
// Single-field unique indexes (declared inline above via `unique: true`)

// Compound index for recovery cron query:
//   HooshPayInvoice.find({ fulfilled: true, balanceCredited: false, status: "paid" })
hooshPayInvoiceSchema.index(
  { fulfilled: 1, balanceCredited: 1, status: 1 },
  { name: "idx_recovery_cron" }
);

// Compound index for expiry cron query:
//   HooshPayInvoice.find({ status: "pending", createdAt: { $lt: cutoff } })
hooshPayInvoiceSchema.index(
  { status: 1, createdAt: 1 },
  { name: "idx_expiry_cron" }
);

// Index for user invoice lookup (profile, admin search)
hooshPayInvoiceSchema.index({ userId: 1, createdAt: -1 }, { name: "idx_user_recent" });

const HooshPayInvoice = mongoose.model("HooshPayInvoice", hooshPayInvoiceSchema);
export default HooshPayInvoice;
