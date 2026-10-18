import mongoose from "mongoose";

const ipnLogSchema = new mongoose.Schema({
  receivedAt: { type: Date, default: Date.now },
  paymentId: { type: String, default: null },
  invoiceId: { type: String, default: null },
  paymentStatus: { type: String, default: null },
  priceAmount: { type: Number, default: null },
  priceCurrency: { type: String, default: null },
  payCurrency: { type: String, default: null },
  payAmount: { type: Number, default: null },
  actuallyPaid: { type: Number, default: null },
}, { _id: false });

const nowPaymentsInvoiceSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: Number, required: true, index: true },
  amountToman: { type: Number, required: true },
  priceAmountCents: { type: Number, required: true },
  priceCurrency: { type: String, required: true },
  payCurrency: { type: String, required: true },
  tomanPerFiat: { type: Number, required: true },
  rateSource: { type: String, required: true },
  invoiceId: { type: String },
  invoiceUrl: { type: String },
  paymentId: { type: String },
  status: {
    type: String,
    enum: [
      "creating",
      "creation_unknown",
      "creation_failed",
      "pending",
      "waiting",
      "confirming",
      "confirmed",
      "sending",
      "partially_paid",
      "finished",
      "failed",
      "expired",
      "refunded",
    ],
    default: "creating",
  },
  providerStatus: { type: String, default: null },
  payAmount: { type: Number, default: null },
  actuallyPaid: { type: Number, default: null },
  apiAttemptedAt: { type: Date, default: null },
  openCreateKey: { type: String },
  balanceCredited: { type: Boolean, default: false },
  balanceCreditedAt: { type: Date, default: null },
  creditLedgerVersion: { type: Number, default: 2 },
  paidAt: { type: Date, default: null },
  lastIpnAt: { type: Date, default: null },
  recoveryStatus: { type: String, enum: ["none", "required", "resolved"], default: "none", index: true },
  recoveryReason: { type: String, default: null, maxlength: 500 },
  recoveryResolvedAt: { type: Date, default: null },
  recoveryResolvedBy: { type: String, default: null },
  retryCount: { type: Number, default: 0, min: 0 },
  lastRetryAt: { type: Date, default: null },
  lastRetryOperationId: { type: String, default: null, maxlength: 80 },
  nextRetryAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, maxlength: 80 },
  notificationPending: { type: Boolean, default: false },
  notificationClaimedAt: { type: Date, default: null },
  notifiedAt: { type: Date, default: null },
  ipnLog: { type: [ipnLogSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

nowPaymentsInvoiceSchema.index(
  { openCreateKey: 1 },
  { unique: true, sparse: true, name: "idx_nowpayments_open_create" },
);
nowPaymentsInvoiceSchema.index(
  { paymentId: 1 },
  { unique: true, sparse: true, name: "idx_nowpayments_payment" },
);
nowPaymentsInvoiceSchema.index(
  { invoiceId: 1 },
  { unique: true, sparse: true, name: "idx_nowpayments_invoice" },
);
nowPaymentsInvoiceSchema.index(
  { status: 1, balanceCredited: 1, createdAt: 1 },
  { name: "idx_nowpayments_recovery" },
);
nowPaymentsInvoiceSchema.index(
  { userId: 1, createdAt: -1 },
  { name: "idx_nowpayments_user_recent" },
);

const NowPaymentsInvoice = mongoose.models.NowPaymentsInvoice
  || mongoose.model("NowPaymentsInvoice", nowPaymentsInvoiceSchema);

export default NowPaymentsInvoice;
