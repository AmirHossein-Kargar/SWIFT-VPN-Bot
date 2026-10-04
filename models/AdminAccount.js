import mongoose from "mongoose";

/**
 * Database-backed additional administrators.
 *
 * The env `ADMINS` list stays the fail-closed bootstrap source of authority
 * (no ADMINS => no admins). This collection only EXTENDS that set, and the
 * owner is always defined by the environment (OWNER_TELEGRAM_ID or the first
 * entry of ADMINS), so an owner can never be locked out or removed via the
 * database.
 */
const adminAccountSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, maxlength: 20 },
  // Informational role. True owner authority is resolved from the environment.
  role: { type: String, enum: ["owner", "admin"], default: "admin" },
  displayName: { type: String, default: null, maxlength: 120 },
  addedBy: { type: String, required: true, maxlength: 20 },
  addedAt: { type: Date, default: Date.now },
  removedAt: { type: Date, default: null, index: true },
  removedBy: { type: String, default: null, maxlength: 20 },
});

adminAccountSchema.index({ telegramId: 1, removedAt: 1 }, { name: "idx_admin_account_active" });

const AdminAccount =
  mongoose.models.AdminAccount || mongoose.model("AdminAccount", adminAccountSchema);

export default AdminAccount;
