import mongoose from "mongoose";

/**
 * Mock-test reports. Deliberately a separate collection: nothing here is a
 * payment, balance, revenue figure or customer record, and no financial
 * report or analytics query reads it. Reports expire after 90 days.
 */
const mockTestRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true, maxlength: 64 },
  environment: { type: String, enum: ["mock-isolated"], default: "mock-isolated" },
  actorTelegramId: { type: String, required: true, maxlength: 32 },
  trigger: { type: String, enum: ["telegram", "web", "test"], required: true },
  requestedScenarios: { type: [String], default: [] },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  summary: { type: mongoose.Schema.Types.Mixed, default: {} },
  scenarios: { type: mongoose.Schema.Types.Mixed, default: [] },
  createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
}, { minimize: false, versionKey: false });

mockTestRunSchema.index({ startedAt: -1 }, { name: "idx_mock_test_run_recent" });

export default mongoose.models.MockTestRun || mongoose.model("MockTestRun", mockTestRunSchema);
