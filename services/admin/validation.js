import { AdminServiceError } from "./authorization.js";

export function parsePositiveInteger(value, { name = "value", min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AdminServiceError(`«${name}» باید عددی صحیح بین ${min} تا ${max} باشد.`, { status: 400, code: `invalid_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` });
  }
  return number;
}

export function requireTelegramId(value) {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new AdminServiceError("شناسه تلگرام معتبر لازم است.", { status: 400, code: "invalid_user_id" });
  }
  return id;
}

export function requireServiceUsername(value) {
  const username = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(username)) throw new AdminServiceError("شناسه سرویس VPN معتبر لازم است.", { status: 400, code: "invalid_service_id" });
  return username;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parsePagination(query = {}) {
  const pageValue = Number(query.page ?? 1);
  const sizeValue = Number(query.pageSize ?? query.limit ?? 25);
  return {
    page: Number.isSafeInteger(pageValue) ? Math.max(1, Math.min(1_000_000, pageValue)) : 1,
    pageSize: Number.isSafeInteger(sizeValue) ? Math.max(1, Math.min(100, sizeValue)) : 25,
  };
}

export function requireReason(value, { min = 5, max = 240, name = "reason" } = {}) {
  const reason = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  if (reason.length < min || reason.length > max) {
    throw new AdminServiceError(`«${name}» باید بین ${min} تا ${max} نویسه باشد.`, { status: 400, code: `invalid_${name}` });
  }
  return reason;
}

export function validPageFilter(value, allowed, fallback = "all") {
  return allowed.includes(value) ? value : fallback;
}
