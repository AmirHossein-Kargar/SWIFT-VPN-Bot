import AdminAuditLog from "../../models/AdminAuditLog.js";
import { assertAdminUser, assertOperationId, AdminServiceError } from "./authorization.js";

const SECRET_KEY = /(secret|password|credential|authorization|cookie|session|token|api.?key|private.?key|config|link|url|hash)/i;

function safeString(value, limit = 160) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (/https?:\/\/|\b[A-Za-z0-9_-]{32,}\b/i.test(text)) return "[redacted]";
  return text.slice(0, limit);
}

export function sanitizeAuditValue(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? null : "[truncated]";
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 30)) {
      if (SECRET_KEY.test(key)) continue;
      out[String(key).slice(0, 80)] = sanitizeAuditValue(child, depth + 1);
    }
    return out;
  }
  return null;
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : error?.name;
  return String(code || "admin_operation_failed").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function logFailure(error, { action, operationId, actorTelegramId }) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "admin",
    level: "error",
    message: "Admin action failed",
    action,
    operationId,
    actorTelegramId: String(actorTelegramId),
    errorType: error?.name || "Error",
    code: safeErrorCode(error),
  }));
}

/**
 * Persist an audit intent before executing a mutation. operationId is unique;
 * balance/product/broadcast operations may explicitly opt into safe resume.
 */
export async function runAuditedAction({
  actorTelegramId,
  operationId,
  action,
  targetType = null,
  targetId = null,
  targetUserId = null,
  ipAddress = null,
  metadata = {},
  resumeStarted = false,
  execute,
  auditModel = AdminAuditLog,
}) {
  const actor = assertAdminUser(actorTelegramId);
  const opId = assertOperationId(operationId);
  if (typeof action !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(action)) {
    throw new AdminServiceError("عملیات مدیریت نامعتبر است.", { status: 400, code: "invalid_action" });
  }
  if (typeof execute !== "function") throw new TypeError("An audited action requires an execute function");

  const fields = {
    operationId: opId,
    actorTelegramId: actor,
    action,
    targetType: targetType ? String(targetType).slice(0, 40) : null,
    targetId: targetId == null ? null : safeString(targetId, 160),
    targetUserId: targetUserId == null ? null : safeString(targetUserId, 32),
    ipAddress: ipAddress ? safeString(ipAddress, 64) : null,
    metadata: sanitizeAuditValue(metadata) || {},
  };

  let audit;
  let resumed = false;
  try {
    audit = await auditModel.create(fields);
  } catch (error) {
    if (error?.code !== 11000) throw new AdminServiceError("سیستم گزارش عملیات در دسترس نیست؛ عملیات اجرا نشد.", { status: 503, code: "audit_unavailable" });
    audit = await auditModel.findOne({ operationId: opId });
    if (!audit || String(audit.actorTelegramId) !== actor || audit.action !== action) {
      throw new AdminServiceError("این کلید عملیات قبلاً استفاده شده است.", { status: 409, code: "idempotency_conflict" });
    }
    if (audit.status === "succeeded") return { result: audit.result, replayed: true };
    if (audit.status !== "started" || !resumeStarted) {
      throw new AdminServiceError("این عملیات در حال انجام است یا نیازمند بررسی دستی است.", { status: 409, code: "action_in_progress" });
    }
    resumed = true;
  }

  try {
    const result = await execute({ audit, resumed });
    audit.status = "succeeded";
    audit.result = sanitizeAuditValue(result?.auditSummary ?? result?.summary ?? { ok: true });
    audit.completedAt = new Date();
    await audit.save();
    return { result, replayed: resumed };
  } catch (error) {
    const code = safeErrorCode(error);
    try {
      await auditModel.updateOne(
        { _id: audit._id, status: "started" },
        { $set: { status: "failed", errorCode: code, completedAt: new Date() } }
      );
    } catch (auditError) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(), service: "admin", level: "error",
        message: "Could not finalize admin audit record", operationId: opId,
        errorType: auditError?.name || "DatabaseError",
      }));
    }
    logFailure(error, { action, operationId: opId, actorTelegramId: actor });
    if (error instanceof AdminServiceError) throw error;
    throw new AdminServiceError("عملیات درخواستی به صورت امن قابل انجام نشد.", {
      status: Number.isInteger(error?.status) ? error.status : 503,
      code,
    });
  }
}

export async function listAuditLogs({ page = 1, pageSize = 25, action, actorTelegramId, targetId, model = AdminAuditLog } = {}) {
  const safePage = Math.max(1, Math.min(100_000, Number(page) || 1));
  const safeSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const query = {};
  if (action != null && action !== "") {
    if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(action)) {
      throw new AdminServiceError("فیلتر گزارش عملیات نامعتبر است.", { status: 400, code: "invalid_action_filter" });
    }
    query.action = action;
  }
  if (actorTelegramId && /^\d{1,20}$/.test(String(actorTelegramId))) query.actorTelegramId = String(actorTelegramId);
  if (targetId && typeof targetId === "string") query.targetId = targetId.slice(0, 160);
  const [items, total] = await Promise.all([
    model.find(query).sort({ createdAt: -1, _id: -1 }).skip((safePage - 1) * safeSize).limit(safeSize)
      .select("actorTelegramId action targetType targetId targetUserId status ipAddress metadata result errorCode createdAt completedAt")
      .lean(),
    model.countDocuments(query),
  ]);
  return { items: items.map((item) => sanitizeAuditValue(item)), page: safePage, pageSize: safeSize, total };
}

export { safeErrorCode };
