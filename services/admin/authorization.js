import { isAdmin, isAdminUser } from "../../utils/auth.js";

export class AdminServiceError extends Error {
  constructor(message, { status = 400, code = "admin_request_failed" } = {}) {
    super(message);
    this.name = "AdminServiceError";
    this.status = status;
    this.code = code;
    this.safeMessage = message;
  }
}

export function assertAdminUser(actorId) {
  if (!isAdminUser(actorId)) {
    throw new AdminServiceError("دسترسی مدیر لازم است.", { status: 403, code: "forbidden" });
  }
  return String(actorId);
}

/** Private chats are allowlisted by ADMINS; group actions retain the GROUP_ID guard. */
export function isAuthorizedTelegramAdmin({ chatId, userId, chatType }) {
  if (chatType === "private") return isAdminUser(userId);
  return isAdmin(chatId, userId);
}

export function assertTelegramAdmin({ chatId, userId, chatType }) {
  if (!isAuthorizedTelegramAdmin({ chatId, userId, chatType })) {
    throw new AdminServiceError("فقط مدیران مجاز می‌توانند از این پنل استفاده کنند.", { status: 403, code: "forbidden" });
  }
  return String(userId);
}

export function assertOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(operationId)) {
    throw new AdminServiceError("کلید عملیات معتبر لازم است.", { status: 400, code: "invalid_idempotency_key" });
  }
  return operationId;
}

export default { assertAdminUser, isAuthorizedTelegramAdmin, assertTelegramAdmin, assertOperationId };
