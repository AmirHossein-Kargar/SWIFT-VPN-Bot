import mongoose from "mongoose";

/**
 * One document per background job: an owner-checked lease (see services/jobLease.js) and the job's
 * resumable progress. The lease fields are only ever written through jobLease.js, never from job code.
 */
const jobCheckpointSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, maxlength: 64 },
  leaseOwner: { type: String, default: null, maxlength: 80 },
  leaseUntil: { type: Date, default: null },
  state: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false, versionKey: false });

export default mongoose.models.JobCheckpoint || mongoose.model("JobCheckpoint", jobCheckpointSchema);
