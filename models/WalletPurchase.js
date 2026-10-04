import mongoose from "mongoose";

const walletPurchaseSchema = new mongoose.Schema({
  purchaseId: { type: String, required: true, unique: true },
  telegramId: { type: String, required: true, index: true },
  planId: { type: String, required: true },
  planName: { type: String, default: "" },
  gig: { type: Number, required: true },
  days: { type: Number, required: true },
  amount: { type: Number, required: true },
  status: {
    type: String,
    enum: ["reserving", "reserved", "provisioning", "uncertain", "provisioned", "completed", "refund_pending", "refunded", "failed", "manual_review"],
    default: "reserving",
    index: true,
  },
  reservedAt: { type: Date, default: null },
  provisioningStartedAt: { type: Date, default: null },
  serviceUsername: { type: String, default: null },
  serviceHash: { type: String, default: null },
  serviceLink: { type: String, default: null },
  singleLink: { type: String, default: null },
  errorCode: { type: String, default: null },
  refundedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  notificationPending: { type: Boolean, default: false },
  notificationClaimedAt: { type: Date, default: null },
  notifiedAt: { type: Date, default: null },
  recoveryClaimedAt: { type: Date, default: null },
  adminAlertedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, { minimize: false });

walletPurchaseSchema.index({ status: 1, createdAt: 1 }, { name: "idx_wallet_purchase_recovery" });
walletPurchaseSchema.index({ telegramId: 1, createdAt: -1 }, { name: "idx_wallet_purchase_user_recent" });

export default mongoose.models.WalletPurchase || mongoose.model("WalletPurchase", walletPurchaseSchema);
