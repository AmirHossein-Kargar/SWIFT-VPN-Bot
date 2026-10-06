import mongoose from "mongoose";

const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  reserving: new Set(["reserved", "failed", "refund_pending"]),
  reserved: new Set(["provisioning", "failed", "refund_pending"]),
  provisioning: new Set(["uncertain", "provisioned", "refund_pending", "manual_review"]),
  uncertain: new Set(["manual_review"]),
  provisioned: new Set(["completed"]),
  refund_pending: new Set(["refunded"]),
  completed: new Set(),
  failed: new Set(),
  refunded: new Set(),
  // A still-running create call can return a valid result after a stale worker
  // marked its reservation for review; that specific forward transition is safe.
  manual_review: new Set(["provisioned"]),
});

/**
 * Purchase status changes are deliberately forward-only. Same-state updates
 * are allowed for idempotent bookkeeping; terminal states cannot be reopened.
 */
export function isAllowedWalletPurchaseTransition(from, to) {
  return from === to || Boolean(ALLOWED_STATUS_TRANSITIONS[from]?.has(to));
}

function nextStatusFromUpdate(update) {
  if (!update || typeof update !== "object") return undefined;
  if (update.$unset && Object.hasOwn(update.$unset, "status")) return null;
  if (update.$set && Object.hasOwn(update.$set, "status")) return update.$set.status;
  if (update.$setOnInsert && Object.hasOwn(update.$setOnInsert, "status")) return update.$setOnInsert.status;
  if (!Object.keys(update).some((key) => key.startsWith("$")) && Object.hasOwn(update, "status")) return update.status;
  return undefined;
}

function sourceStatusesFromFilter(filter) {
  const status = filter?.status;
  if (typeof status === "string") return [status];
  if (typeof status?.$eq === "string") return [status.$eq];
  if (Array.isArray(status?.$in) && status.$in.every((value) => typeof value === "string")) return status.$in;
  return null;
}

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "Financial and plan values must be safe integers",
};

const walletPurchaseSchema = new mongoose.Schema({
  // purchaseId is both the durable order ID and the idempotency key. UI adapters
  // should derive/reuse it for retries of the same user action; legacy records
  // retain their existing randomly generated IDs.
  purchaseId: { type: String, required: true, unique: true },
  telegramId: { type: String, required: true, index: true, maxlength: 32 },
  planId: { type: String, required: true, maxlength: 64 },
  planName: { type: String, default: "", maxlength: 120 },
  gig: { type: Number, required: true, min: 1, validate: safeInteger },
  days: { type: Number, required: true, min: 1, validate: safeInteger },
  amount: { type: Number, required: true, min: 1, validate: safeInteger },
  status: {
    type: String,
    enum: ["reserving", "reserved", "provisioning", "uncertain", "provisioned", "completed", "refund_pending", "refunded", "failed", "manual_review"],
    default: "reserving",
    index: true,
  },
  // The WalletPurchase row is the financial audit record for its atomic User
  // balance reservation/refund. The user ledger arrays provide the atomic
  // idempotency guard; these fields make each monetary transition auditable.
  walletDebitStatus: {
    type: String,
    enum: ["not_debited", "reserved", "finalized", "refunded"],
    default: "not_debited",
  },
  walletDebitedAt: { type: Date, default: null },
  reservedAt: { type: Date, default: null },
  provisioningStartedAt: { type: Date, default: null },
  serviceUsername: { type: String, default: null, maxlength: 128 },
  serviceHash: { type: String, default: null, maxlength: 256 },
  serviceLink: { type: String, default: null, maxlength: 4096 },
  singleLink: { type: String, default: null, maxlength: 4096 },
  provisionedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null, index: true },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: String, default: null },
  errorCode: { type: String, default: null, maxlength: 80 },
  retryCount: { type: Number, default: 0, min: 0 },
  lastRetryAt: { type: Date, default: null },
  lastRetryOperationId: { type: String, default: null, maxlength: 80 },
  nextRetryAt: { type: Date, default: null },
  recoveryStatus: { type: String, enum: ["none", "required", "resolved"], default: "none", index: true },
  recoveryReason: { type: String, default: null, maxlength: 500 },
  recoveryResolvedAt: { type: Date, default: null },
  recoveryResolvedBy: { type: String, default: null },
  refundStatus: { type: String, enum: ["none", "pending", "completed"], default: "none" },
  refundAmount: { type: Number, default: null, min: 0, validate: (value) => value == null || Number.isSafeInteger(value) },
  refundReason: { type: String, default: null, maxlength: 80 },
  refundedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  notificationPending: { type: Boolean, default: false },
  notificationClaimedAt: { type: Date, default: null },
  notifiedAt: { type: Date, default: null },
  recoveryClaimedAt: { type: Date, default: null },
  adminAlertedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, { minimize: false });

// Query updates bypass Mongoose's document validation hooks. Require every
// status mutation to name its source state and follow the forward-only graph.
for (const operation of ["findOneAndUpdate", "updateOne", "updateMany"]) {
  walletPurchaseSchema.pre(operation, function validatePurchaseTransition(next) {
    const target = nextStatusFromUpdate(this.getUpdate());
    if (target === undefined) return next();
    const sources = sourceStatusesFromFilter(this.getQuery());
    if (target === null || !sources || !sources.every((source) => isAllowedWalletPurchaseTransition(source, target))) {
      return next(new Error("WalletPurchase status transition is missing a valid forward-only source state"));
    }
    next();
  });
}

walletPurchaseSchema.index({ status: 1, createdAt: 1 }, { name: "idx_wallet_purchase_recovery" });
walletPurchaseSchema.index({ telegramId: 1, createdAt: -1 }, { name: "idx_wallet_purchase_user_recent" });
walletPurchaseSchema.index({ recoveryStatus: 1, status: 1, createdAt: 1 }, { name: "idx_wallet_purchase_recovery_queue" });

export default mongoose.models.WalletPurchase || mongoose.model("WalletPurchase", walletPurchaseSchema);
