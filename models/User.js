import mongoose from "mongoose";
const userSchema = new mongoose.Schema({
  firstName: { type: String, default: null },
  lastName: { type: String, default: null },
  username: { type: String, default: null },
  telegramId: { type: String, required: true, unique: true },
  phoneNumber: { type: String, default: null },
  balance: { type: Number, default: 0 },
  successfulPayments: { type: Number, default: 0 },
  // Durable idempotency ledger for wallet credits. A payment ID is added in the
  // same atomic update as its balance increment, allowing recovery after a
  // crash without either losing or repeating a credit.
  appliedPaymentKeys: { type: [String], default: [] },
  // Purchase ledger keys make wallet reservations/refunds and service commits
  // idempotent across retries and process restarts.
  appliedPurchaseReservations: { type: [String], default: [] },
  refundedPurchaseIds: { type: [String], default: [] },
  completedPurchaseIds: { type: [String], default: [] },
  totalServices: { type: Number, default: 0 },
  hasReceivedTest: { type: Boolean, default: false },
  testServiceAttemptId: { type: String, default: null },
  testServiceStatus: { type: String, enum: [null, "provisioning", "manual_review", "completed", "failed"], default: null },
  testServiceStartedAt: { type: Date, default: null },
  testServiceUsername: { type: String, default: null },
  testServiceHash: { type: String, default: null },
  testServiceLink: { type: String, default: null },
  testServiceSingleLink: { type: String, default: null },
  testServiceNotificationPending: { type: Boolean, default: false },
  testServiceNotificationClaimedAt: { type: Date, default: null },
  testServiceNotifiedAt: { type: Date, default: null },
  services: [
    {
      username: String,
      purchaseId: { type: String, default: null },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  hasDiscount: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
});

// ── Indexes ───────────────────────────────────────────────────────────────────
// telegramId already carries a unique index from `unique: true` above; it backs
// every balance lookup and the atomic reserve/refund writes.
//
// Multikey index on the embedded services array. Service-ownership checks
// (utils/auth.js + handleCallbackQuery) run on every user service action:
//   User.findOne({ telegramId, "services.username": username })
userSchema.index({ "services.username": 1 }, { name: "idx_user_service_username" });

export default mongoose.model("User", userSchema);
