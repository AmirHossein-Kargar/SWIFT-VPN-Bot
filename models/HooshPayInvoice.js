import mongoose from "mongoose";

/**
 * HooshPayInvoice
 * ---------------
 * Full lifecycle of a HooshPay payment with two-phase write tracking.
 *
 * Official statuses (per https://hooshpay.xyz/developers):
 *   pending   — awaiting payment
 *   paid      — paid and confirmed
 *   expired   — payment deadline passed
 *   cancelled — cancelled by merchant or user
 *   failed    — payment failed
 *
 * Internal-only status:
 *   reversed  — refund/chargeback detected via webhook
 *
 * Allowed state transitions (enforced by pre-save hook):
 *   pending   → paid | expired | cancelled | failed | reversed
 *   paid      → reversed
 *   expired   → (terminal)
 *   cancelled → (terminal)
 *   failed    → (terminal)
 *   reversed  → (terminal)
 *
 * Phase tracking:
 *   fulfilled       — Phase-1 lock (set atomically by findOneAndUpdate)
 *   balanceCredited — Phase-2 completion (set after User.balance incremented)
 */

const TERMINAL_STATES = new Set(["expired", "cancelled", "failed", "reversed"]);

const ALLOWED_TRANSITIONS = {
  pending:   new Set(["paid", "expired", "cancelled", "failed", "reversed"]),
  paid:      new Set(["reversed"]),
  expired:   new Set(),
  cancelled:  new Set(),
  failed:    new Set(),
  reversed:  new Set(),
};

const hooshPayInvoiceSchema = new mongoose.Schema({
  uid:        { type: String, required: true, unique: true },
  orderId:    { type: String, required: true, unique: true },
  userId:     { type: Number, required: true },
  amount:     { type: Number, required: true },

  // Fee / payable fields from HooshPay API response
  feeMode:       { type: String, enum: ["seller", "buyer", "split"], default: "buyer" },
  feePercent:    { type: Number, default: null },
  feeAmount:     { type: Number, default: null },
  payableAmount: { type: Number, default: null },
  merchantCredit:{ type: Number, default: null },

  // Card info from HooshPay (for card-to-card display)
  cardNumber: { type: String, default: null },
  cardHolder: { type: String, default: null },
  cardBank:   { type: String, default: null },

  paymentUrl: { type: String, required: true },

  // Expiry from HooshPay API
  expiresAt: { type: Date, default: null },

  status: {
    type: String,
    enum: ["pending", "paid", "expired", "cancelled", "failed", "reversed"],
    default: "pending",
  },

  // Tracking code returned by verify endpoint
  trackingCode: { type: String, default: null },

  // Phase-1 lock
  fulfilled:    { type: Boolean, default: false },
  fulfilledAt:  { type: Date, default: null },

  // Phase-2 completion
  balanceCredited:   { type: Boolean, default: false },
  balanceCreditedAt: { type: Date, default: null },

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
// Record the persisted status when a document is hydrated so the pre-save hook
// always knows the real source state. (`this.$__.priorDoc` is internal and not
// reliably populated, which would make every .save() look like a transition
// from an unknown state.)
hooshPayInvoiceSchema.post("init", function (doc) {
  doc.$locals.originalStatus = doc.status;
});

hooshPayInvoiceSchema.pre("save", function (next) {
  // On a new document any initial status is allowed
  if (this.isNew) return next();
  if (!this.isModified("status")) return next();

  const from = this.$locals?.originalStatus ?? this.$__.priorDoc?.status ?? null;
  const to   = this.status;

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
