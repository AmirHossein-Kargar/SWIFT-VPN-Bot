import mongoose from "mongoose";

/**
 * One reconciliation finding of Money Flow Sentinel (docs/sentinel.md).
 *
 * This collection is an OPINION about the money records, never a money record: nothing in the payment, wallet or order
 * code reads it, and deleting it changes no balance. `fingerprint` is deterministic per problem and subject, so a rerun
 * updates the same row instead of raising a second alert.
 *
 * `state` belongs to the detector: open while the problem reproduces, cleared when a later evaluation no longer finds it.
 * `review` belongs to the people investigating it. Keeping them apart is what stops a human note from hiding a problem
 * that still reproduces, and stops the detector from erasing a human decision.
 */
export const FINDING_CLASSIFICATIONS = Object.freeze(["confirmed", "probable", "informational"]);
export const FINDING_SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
export const FINDING_STATES = Object.freeze(["open", "cleared"]);
export const FINDING_REVIEWS = Object.freeze(["new", "investigating", "remediation_proposed", "resolved", "false_positive"]);
export const FINDING_DIRECTIONS = Object.freeze(["owed_to_customer", "excess_in_wallet", "held", "none"]);

const refSchema = new mongoose.Schema({
  type: { type: String, maxlength: 24 },
  key: { type: String, maxlength: 180 },
}, { _id: false });

const reviewEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  actor: { type: String, maxlength: 32 },
  from: { type: String, maxlength: 24 },
  to: { type: String, maxlength: 24 },
  reason: { type: String, maxlength: 400 },
  optionId: { type: String, default: null, maxlength: 40 },
  operationId: { type: String, default: null, maxlength: 80 },
}, { _id: false });

const sentinelFindingSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, unique: true, maxlength: 220 },
  code: { type: String, required: true, maxlength: 48 },
  category: { type: String, required: true, maxlength: 24 },
  classification: { type: String, enum: FINDING_CLASSIFICATIONS, required: true },
  severity: { type: String, enum: FINDING_SEVERITIES, required: true },
  // 0 = critical ... 4 = info; lets the list sort by severity through an index.
  rank: { type: Number, required: true, min: 0, max: 4 },
  userId: { type: String, required: true, maxlength: 32 },
  subjectType: { type: String, required: true, maxlength: 24 },
  subjectKey: { type: String, required: true, maxlength: 180 },
  // Identity of the money this finding is about, so two views of one payment are never counted twice.
  impactKey: { type: String, default: null, maxlength: 200 },
  amountToman: { type: Number, default: 0, min: 0 },
  direction: { type: String, enum: FINDING_DIRECTIONS, default: "none" },
  expected: { type: String, default: null, maxlength: 300 },
  observed: { type: String, default: null, maxlength: 300 },
  expectedToman: { type: Number, default: null },
  observedToman: { type: Number, default: null },
  // Identifiers, statuses and amounts only (see services/sentinel/rules.js): never links, cards, addresses or payloads.
  facts: { type: mongoose.Schema.Types.Mixed, default: {} },
  refs: { type: [refSchema], default: [] },
  evidenceHash: { type: String, default: null, maxlength: 64 },
  ruleVersion: { type: Number, default: 1 },
  state: { type: String, enum: FINDING_STATES, default: "open" },
  review: { type: String, enum: FINDING_REVIEWS, default: "new" },
  reviewHistory: { type: [reviewEntrySchema], default: [] },
  detections: { type: Number, default: 1, min: 0 },
  reopenCount: { type: Number, default: 0, min: 0 },
  firstDetectedAt: { type: Date, default: Date.now },
  lastDetectedAt: { type: Date, default: Date.now },
  lastCheckedAt: { type: Date, default: Date.now },
  clearedAt: { type: Date, default: null },
  // Set only when cleared: open findings never expire.
  expireAt: { type: Date, default: null },
}, { minimize: false, versionKey: false });

sentinelFindingSchema.index({ state: 1, rank: 1, firstDetectedAt: -1, _id: -1 }, { name: "idx_sentinel_list" });
sentinelFindingSchema.index({ state: 1, lastDetectedAt: -1 }, { name: "idx_sentinel_recent" });
sentinelFindingSchema.index({ state: 1, lastCheckedAt: 1 }, { name: "idx_sentinel_recheck" });
sentinelFindingSchema.index({ userId: 1, state: 1 }, { name: "idx_sentinel_user" });
sentinelFindingSchema.index({ subjectKey: 1, state: 1 }, { name: "idx_sentinel_subject" });
sentinelFindingSchema.index({ expireAt: 1 }, { name: "ttl_sentinel_cleared", expireAfterSeconds: 0 });

export default mongoose.models.SentinelFinding || mongoose.model("SentinelFinding", sentinelFindingSchema);
