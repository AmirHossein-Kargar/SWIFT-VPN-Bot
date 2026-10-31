import mongoose from "mongoose";

export const RELIABILITY_EVENT_SEVERITIES = Object.freeze(["debug", "info", "warning", "error", "critical"]);

/**
 * Operational events of the Service Reliability Center (docs/reliability.md), kept for seven days. Written in batches by
 * services/reliability/store.js from the in-process ring, keyed by `eventId`, so a repeated flush cannot duplicate a row.
 * Nothing here is an input to a money path: dropping this collection changes no balance, order or invoice.
 */
const reliabilityEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, maxlength: 64 },
  at: { type: Date, required: true },
  lastAt: { type: Date, default: null },
  type: { type: String, required: true, maxlength: 48 },
  severity: { type: String, enum: RELIABILITY_EVENT_SEVERITIES, default: "info" },
  component: { type: String, required: true, maxlength: 32 },
  message: { type: String, default: "", maxlength: 200 },
  correlationId: { type: String, default: null, maxlength: 128 },
  orderKey: { type: String, default: null, maxlength: 140 },
  incidentId: { type: String, default: null, maxlength: 64 },
  count: { type: Number, default: 1, min: 1 },
}, { versionKey: false });

reliabilityEventSchema.index({ at: -1 }, { name: "idx_reliability_event_at" });
reliabilityEventSchema.index({ component: 1, at: -1 }, { name: "idx_reliability_event_component" });
reliabilityEventSchema.index({ severity: 1, at: -1 }, { name: "idx_reliability_event_severity" });
reliabilityEventSchema.index({ type: 1, at: -1 }, { name: "idx_reliability_event_type" });
reliabilityEventSchema.index({ orderKey: 1, at: -1 }, { name: "idx_reliability_event_order", partialFilterExpression: { orderKey: { $type: "string" } } });
reliabilityEventSchema.index({ incidentId: 1, at: -1 }, { name: "idx_reliability_event_incident", partialFilterExpression: { incidentId: { $type: "string" } } });
reliabilityEventSchema.index({ at: 1 }, { name: "ttl_reliability_event", expireAfterSeconds: 7 * 24 * 60 * 60 });

export default mongoose.models.ReliabilityEvent || mongoose.model("ReliabilityEvent", reliabilityEventSchema);
