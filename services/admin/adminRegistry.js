/**
 * Multi-admin registry.
 *
 * Design constraints (fail-closed, no lockout):
 *   - `ADMINS` env remains the authoritative bootstrap allowlist. With no
 *     `ADMINS` configured nobody is an admin, regardless of the database.
 *   - The OWNER is resolved from the environment: `OWNER_TELEGRAM_ID` if set,
 *     otherwise the FIRST entry of `ADMINS`. The owner can never be removed
 *     or demoted through the database.
 *   - This collection only ADDS extra admins on top of the env list.
 *   - The in-memory cache is refreshed every ADMIN_CACHE_TTL (default 60s)
 *     and immediately after every mutation. If the database is unreachable
 *     the last known cache is kept; on a fresh start with the database down,
 *     only the env allowlist applies (fail-closed).
 *
 * utils/auth.js stays free of imports: the registry injects itself as the
 * "additional admin provider" when this module is first imported, so the
 * synchronous authorization path everywhere (Telegram handlers, web sessions)
 * automatically honors database-added admins.
 */
import { randomUUID } from "node:crypto";
import AdminAccount from "../../models/AdminAccount.js";
import { getAdminIds, setAdditionalAdminProvider } from "../../utils/auth.js";
import { runAuditedAction } from "./audit.js";

const DEFAULT_REFRESH_MS = 60_000;

/** Error shaped for the web/Telegram admin error handlers (duck-typed). */
class AdminRegistryError extends Error {
  constructor(message, { status = 400, code = "admin_registry_failed" } = {}) {
    super(message);
    this.name = "AdminRegistryError";
    this.status = status;
    this.code = code;
    this.safeMessage = message;
  }
}

// ── In-memory cache ─────────────────────────────────────────────────────────
// Map<telegramId, { telegramId, role, displayName, addedBy, addedAt }>
const cache = new Map();
let cacheLoaded = false;
let refreshTimer = null;

function refreshIntervalMs() {
  const configured = Number(process.env.ADMIN_CACHE_TTL_SECONDS || 60);
  return Number.isInteger(configured) && configured >= 5 && configured <= 3600
    ? configured * 1000
    : DEFAULT_REFRESH_MS;
}

export function resetAdminRegistryForTests(model = null) {
  cache.clear();
  cacheLoaded = false;
  injectedModel = model;
}

// Test seam: allows unit tests to run without MongoDB.
let injectedModel = null;
function model() {
  return injectedModel || AdminAccount;
}

async function loadActiveAdmins() {
  return model()
    .find({ removedAt: null })
    .select("telegramId role displayName addedBy addedAt -_id")
    .lean()
    .maxTimeMS(5000);
}

export async function refreshAdminCache() {
  try {
    const rows = await loadActiveAdmins();
    const next = new Map();
    for (const row of rows) {
      const id = String(row.telegramId ?? "").trim();
      if (/^[1-9]\d{0,19}$/.test(id) && !getAdminIds().includes(Number(id))) {
        next.set(id, { ...row, telegramId: id });
      }
    }
    cache.clear();
    for (const [key, value] of next) cache.set(key, value);
    cacheLoaded = true;
    return { ok: true, count: cache.size };
  } catch (error) {
    // Keep the last known cache (fail-safe for running processes); a fresh
    // process simply stays env-only until the database is reachable.
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      service: "admin-registry",
      level: "error",
      message: "Admin cache refresh failed; using last known state",
      errorType: error?.name || "DatabaseError",
    }));
    return { ok: false, count: cache.size };
  }
}

function ensureRefreshLoop() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { void refreshAdminCache(); }, refreshIntervalMs());
  refreshTimer.unref?.();
}

// ── Owner resolution (environment-only) ─────────────────────────────────────

export function getOwnerTelegramIds() {
  const explicit = String(process.env.OWNER_TELEGRAM_ID || "").trim();
  if (/^[1-9]\d{0,19}$/.test(explicit)) return [explicit];
  const first = getAdminIds()[0];
  return first ? [String(first)] : [];
}

export function isOwnerUser(userId) {
  const id = String(userId ?? "").trim();
  return getOwnerTelegramIds().includes(id);
}

// ── Synchronous authorization hooks ─────────────────────────────────────────

/** True when the ID is an active database-added admin (env admins excluded). */
export function isRegisteredAdmin(userId) {
  const id = String(userId ?? "").trim();
  return cache.has(id);
}

export function isAdditionalAdmin(userId) {
  return isRegisteredAdmin(userId);
}

// Inject into the fail-closed authorization path (utils/auth stays import-free).
setAdditionalAdminProvider(isRegisteredAdmin);

// ── Listing ─────────────────────────────────────────────────────────────────

export async function listAdmins({ actorId } = {}) {
  if (!actorId) throw new AdminRegistryError("دسترسی مدیر لازم است.", { status: 403, code: "forbidden" });
  ensureRefreshLoop();
  if (!cacheLoaded) await refreshAdminCache();

  const ownerIds = getOwnerTelegramIds();
  const envAdmins = getAdminIds().map((id) => ({
    telegramId: String(id),
    source: "environment",
    role: ownerIds.includes(String(id)) ? "owner" : "admin",
    displayName: null,
    addedBy: null,
    addedAt: null,
  }));
  const dbAdmins = [...cache.values()].map((row) => ({
    telegramId: row.telegramId,
    source: "database",
    role: ownerIds.includes(row.telegramId) ? "owner" : row.role || "admin",
    displayName: row.displayName || null,
    addedBy: row.addedBy || null,
    addedAt: row.addedAt || null,
  }));
  const seen = new Set(envAdmins.map((a) => a.telegramId));
  return [...envAdmins, ...dbAdmins.filter((a) => !seen.has(a.telegramId))];
}

// ── Mutations (owner-only, audited, idempotent) ─────────────────────────────

function assertOwnerActor(actorId) {
  const id = String(actorId ?? "").trim();
  if (!id || !isOwnerUser(id)) {
    throw new AdminRegistryError("این عملیات فقط برای مالک اصلی ربات مجاز است.", { status: 403, code: "owner_only" });
  }
  return id;
}

function parseTelegramId(value) {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,19}$/.test(id)) {
    throw new AdminRegistryError("شناسه تلگرام نامعتبر است. یک عدد مثبت وارد کنید.", { status: 400, code: "invalid_admin_id" });
  }
  return id;
}

export async function addAdmin({ actorId, operationId, telegramId, displayName = null, ipAddress = null } = {}) {
  const owner = assertOwnerActor(actorId);
  const id = parseTelegramId(telegramId);
  if (isOwnerUser(id)) {
    throw new AdminRegistryError("این شناسه مالک اصلی است و از قبل دسترسی کامل دارد.", { status: 409, code: "admin_already_owner" });
  }
  const safeName = displayName != null ? String(displayName).trim().slice(0, 120) || null : null;

  const { result } = await runAuditedAction({
    actorTelegramId: owner,
    operationId: operationId || `ADMIN-ADD-${randomUUID()}`,
    action: "ADMIN_ADDED",
    targetType: "admin",
    targetId: id,
    ipAddress,
    metadata: { telegramId: id, displayName: safeName },
    resumeStarted: true,
    execute: async () => {
      const existing = await model().findOne({ telegramId: id }).lean();
      if (existing?.removedAt == null) {
        return { ok: true, alreadyPresent: true, auditSummary: { alreadyPresent: true } };
      }
      await model().updateOne(
        { telegramId: id },
        { $set: { role: "admin", displayName: safeName, addedBy: owner, addedAt: new Date(), removedAt: null, removedBy: null } }
      );
      await refreshAdminCache();
      return { ok: true, auditSummary: { telegramId: id } };
    },
  });
  return result;
}

export async function removeAdmin({ actorId, operationId, telegramId, ipAddress = null } = {}) {
  const owner = assertOwnerActor(actorId);
  const id = parseTelegramId(telegramId);
  if (isOwnerUser(id)) {
    throw new AdminRegistryError("مالک اصلی را نمی‌توان حذف کرد. برای تغییر مالک، متغیر محیطی ADMINS را ویرایش کنید.", { status: 403, code: "owner_protected" });
  }
  if (getAdminIds().includes(Number(id))) {
    throw new AdminRegistryError("این مدیر در متغیر محیطی ADMINS تعریف شده است؛ برای حذف آن، تنظیمات سرور را ویرایش کنید.", { status: 409, code: "admin_from_environment" });
  }

  const { result } = await runAuditedAction({
    actorTelegramId: owner,
    operationId: operationId || `ADMIN-REMOVE-${randomUUID()}`,
    action: "ADMIN_REMOVED",
    targetType: "admin",
    targetId: id,
    ipAddress,
    metadata: { telegramId: id },
    resumeStarted: true,
    execute: async () => {
      const updated = await model().findOneAndUpdate(
        { telegramId: id, removedAt: null },
        { $set: { removedAt: new Date(), removedBy: owner } },
        { new: true }
      );
      if (!updated) {
        return { ok: true, alreadyRemoved: true, auditSummary: { alreadyRemoved: true } };
      }
      await refreshAdminCache();
      return { ok: true, auditSummary: { telegramId: id } };
    },
  });
  return result;
}

// Start the background refresh loop lazily but eagerly enough that a running
// bot picks up database changes within the TTL.
ensureRefreshLoop();
