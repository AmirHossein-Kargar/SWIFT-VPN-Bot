import mongoose from "mongoose";

/**
 * One closed minute of telemetry from one process (docs/reliability.md), kept for two days, so the 24-hour view survives a
 * restart. A minute with no document is a minute nobody was measuring: the panel reports that as a coverage gap, never as
 * zero traffic. `key` is `<minute epoch ms>:<instance>`, so two processes overlapping during a deploy keep separate rows.
 */
const reliabilityRollupSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, maxlength: 64 },
  minute: { type: Date, required: true },
  series: { type: mongoose.Schema.Types.Mixed, default: {} },
  health: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { minimize: false, versionKey: false });

reliabilityRollupSchema.index({ minute: 1 }, { name: "ttl_reliability_rollup", expireAfterSeconds: 2 * 24 * 60 * 60 });

export default mongoose.models.ReliabilityRollup || mongoose.model("ReliabilityRollup", reliabilityRollupSchema);
