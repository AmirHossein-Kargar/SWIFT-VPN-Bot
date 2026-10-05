import mongoose from "mongoose";
const userSchema = new mongoose.Schema({
  firstName: { type: String, default: null },
  lastName: { type: String, default: null },
  username: { type: String, default: null },
  telegramId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  successfulPayments: { type: Number, default: 0 },
  // Durable idempotency ledger for wallet credits. A payment ID is added in the
  // same atomic update as its balance increment, allowing recovery after a
  // crash without either losing or repeating a credit.
  appliedPaymentKeys: { type: [String], default: [] },
  // Admin balance adjustments use a durable idempotency ledger just like
  // payment credits, so repeated HTTP callbacks cannot change a balance twice.
  appliedAdminBalanceKeys: { type: [String], default: [] },
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
      sub_link: { type: String, default: null, maxlength: 4096 },
      purchaseId: { type: String, default: null },
      productId: { type: String, default: null },
      trafficGb: { type: Number, default: null },
      createdAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      revokedAt: { type: Date, default: null },
      revokedBy: { type: String, default: null },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  // New records start with a real activity timestamp. Legacy records without
  // this field remain unknown until the bot observes their next interaction.
  lastActivityAt: { type: Date, default: Date.now, index: true },
  referralCode: { type: String, default: null, maxlength: 64 },
  referredByTelegramId: { type: String, default: null, maxlength: 32, index: true },
  blockedAt: { type: Date, default: null },
  blockedBy: { type: String, default: null, maxlength: 32 },
  blockReason: { type: String, default: null, maxlength: 240 },
  hasDiscount: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false, index: true },
});

// ── Indexes ───────────────────────────────────────────────────────────────────
// telegramId already carries a unique index from `unique: true` above; it backs
// every balance lookup and the atomic reserve/refund writes.
//
// Multikey index on the embedded services array. Service-ownership checks
// (utils/auth.js + handleCallbackQuery) run on every user service action:
//   User.findOne({ telegramId, "services.username": username })
userSchema.index({ "services.username": 1 }, { name: "idx_user_service_username" });
userSchema.index({ username: 1 }, { name: "idx_user_username" });
userSchema.index({ createdAt: -1 }, { name: "idx_user_created_recent" });
userSchema.index({ lastActivityAt: -1 }, { name: "idx_user_activity_recent" });
userSchema.index({ isBanned: 1, createdAt: -1 }, { name: "idx_user_blocked_recent" });

export default mongoose.models.User || mongoose.model("User", userSchema);
