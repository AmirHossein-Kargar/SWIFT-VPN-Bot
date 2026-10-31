import mongoose from "mongoose";

export const INCIDENT_SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);
export const INCIDENT_STATES = Object.freeze(["open", "resolved"]);

/**
 * One operational problem. A problem that continues is one row, however many checks saw it: `fingerprint` is `code:subject`
 * and the partial unique index allows one open row per fingerprint, so a rerun or a second process lands on the same row.
 * `incidentId` is assigned in memory, so an outage of MongoDB itself can be written down after the fact.
 * Resolved rows expire after 90 days. Nothing in the payment, wallet or order code reads this collection.
 */
const reliabilityIncidentSchema = new mongoose.Schema({
  incidentId: { type: String, required: true, unique: true, maxlength: 64 },
  fingerprint: { type: String, required: true, maxlength: 96 },
  code: { type: String, required: true, maxlength: 48 },
  group: { type: String, required: true, maxlength: 48 },
  component: { type: String, required: true, maxlength: 32 },
  severity: { type: String, enum: INCIDENT_SEVERITIES, required: true },
  rank: { type: Number, required: true, min: 0, max: 3 },
  state: { type: String, enum: INCIDENT_STATES, default: "open" },
  title: { type: String, required: true, maxlength: 160 },
  summary: { type: String, default: "", maxlength: 400 },
  firstDetectedAt: { type: Date, required: true },
  lastDetectedAt: { type: Date, required: true },
  resolvedAt: { type: Date, default: null },
  escalatedAt: { type: Date, default: null },
  detections: { type: Number, default: 1, min: 1 },
  reopenCount: { type: Number, default: 0, min: 0 },
  evidence: { type: [new mongoose.Schema({ label: { type: String, maxlength: 80 }, value: { type: String, maxlength: 200 }, source: { type: String, maxlength: 80 } }, { _id: false })], default: [] },
  affectedOrders: { type: Number, default: null, min: 0 },
  orderKeys: { type: [String], default: [] },
  timeline: { type: [new mongoose.Schema({ at: Date, kind: { type: String, maxlength: 24 }, note: { type: String, maxlength: 200 } }, { _id: false })], default: [] },
}, { minimize: false, versionKey: false });

reliabilityIncidentSchema.index({ fingerprint: 1 }, { name: "uniq_reliability_open_fingerprint", unique: true, partialFilterExpression: { state: "open" } });
reliabilityIncidentSchema.index({ state: 1, rank: 1, lastDetectedAt: -1 }, { name: "idx_reliability_incident_list" });
reliabilityIncidentSchema.index({ component: 1, lastDetectedAt: -1 }, { name: "idx_reliability_incident_component" });
reliabilityIncidentSchema.index({ resolvedAt: 1 }, { name: "ttl_reliability_incident", expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { state: "resolved" } });

export default mongoose.models.ReliabilityIncident || mongoose.model("ReliabilityIncident", reliabilityIncidentSchema);
