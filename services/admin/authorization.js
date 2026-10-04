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
    throw new AdminServiceError("Admin access is required.", { status: 403, code: "forbidden" });
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
    throw new AdminServiceError("Only an allowlisted admin can use this panel.", { status: 403, code: "forbidden" });
  }
  return String(userId);
}

export function assertOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(operationId)) {
    throw new AdminServiceError("A valid idempotency key is required.", { status: 400, code: "invalid_idempotency_key" });
  }
  return operationId;
}

export default { assertAdminUser, isAuthorizedTelegramAdmin, assertTelegramAdmin, assertOperationId };
