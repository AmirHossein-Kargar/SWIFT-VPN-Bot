/**
 * Cached real-time WizardXray service status.
 *
 * The WizardXray panel is the source of truth for live service state (status, usage, expiry). MongoDB records are the fallback
 * for identity data and for whenever the panel is unreachable.
 *
 * Three kinds of answer, kept apart because they mean different things to a customer:
 *   live    `info` with source "panel"
 *   stale   `info` with source "cache": the panel answered from its own stored copy, so usage may be old
 *   cached  our own record, because the panel could not be reached at all
 *
 * Behavior:
 *   - Live results are cached per username for WIZARD_STATUS_TTL_SECONDS (default 90) so rapid taps / menu browsing cannot
 *     hammer the panel. A stale answer is not cached: the next look should try again.
 *   - Anything that changes a service calls invalidateServiceStatus, or the customer would be shown the link they just revoked.
 *   - Concurrent requests for the same username share one in-flight promise.
 *   - Panel failures never throw to the caller: the caller receives a non-live record plus a safe error code.
 *   - Nothing is ever deleted or mutated here; this module is read-only.
 */
import { getServiceInfo, normalizeService } from "../api/wizardApi.js";
import User from "../models/User.js";
import { subscriptionLink } from "./subscriptionLink.js";
import { isUnlimitedTraffic } from "../utils/serviceTerms.js";

const DEFAULT_TTL_MS = 90_000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map(); // username -> { expiresAt, data, fetchedAt }
const inFlight = new Map(); // username -> Promise

function ttlMs() {
  const configured = Number(process.env.WIZARD_STATUS_TTL_SECONDS || 90);
  return Number.isInteger(configured) && configured >= 15 && configured <= 600
    ? configured * 1000
    : DEFAULT_TTL_MS;
}

export function resetWizardStatusCacheForTests() {
  cache.clear();
  inFlight.clear();
}

/**
 * Forget one service after a change. A lookup already on its way may have read the old state, so it is disowned too: it still
 * answers whoever asked, but it no longer fills the cache.
 */
export function invalidateServiceStatus(username) {
  cache.delete(username);
  inFlight.delete(username);
}

function formatGb(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 100) / 100);
}

export const STATUS_LABELS = {
  active: "🟢 فعال",
  disabled: "⚪️ غیرفعال",
  inactive: "⚪️ غیرفعال",
  limited: "🔴 حجم تمام شده (محدود)",
  expired: "⛔️ منقضی شده",
  on_hold: "🕓 در انتظار اولین اتصال",
};

export function statusLabel(status) {
  return STATUS_LABELS[String(status || "").toLowerCase()] || "⚠️ نامشخص";
}

/**
 * A provider service object as display-safe fields, or null when it does not describe a service. Accepts the raw object or one
 * already normalized. For an unlimited service there is no total, no remainder and no percentage: those fields are null, never
 * zero, so nothing downstream can show an exhausted quota.
 */
export function normalizeServiceResult(input) {
  const service = input && typeof input === "object" && "subLink" in input ? input : normalizeService(input);
  if (!service) return null;
  const { unlimited } = service;
  const total = unlimited ? null : service.dataLimitGb;
  const used = service.usedGb;
  const remaining = unlimited ? null : service.remainingGb ?? (total != null && used != null ? Math.max(0, total - used) : null);
  const usagePercent = !unlimited && total > 0 && used != null ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : null;
  return {
    username: service.username,
    status: service.status,
    statusLabel: statusLabel(service.status),
    unlimited,
    test: service.test,
    totalGbText: formatGb(total),
    usedGbText: formatGb(used),
    remainingGbText: formatGb(remaining),
    usagePercent,
    expireDate: service.expireJalali,
    daysLeft: service.daysLeft,
    smartLink: service.subLink,
    live: service.live,
  };
}

/** Build a fallback view from the user's stored service record. */
export function fallbackFromDbRecord(record, { reason } = {}) {
  if (!record) return null;
  const expiresAt = record.expiresAt ? new Date(record.expiresAt) : null;
  const daysLeft = expiresAt
    ? Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;
  const unlimited = isUnlimitedTraffic(record.trafficGb);
  return {
    username: record.username || null,
    status: null,
    statusLabel: null,
    unlimited,
    totalGbText: record.trafficGb != null && !unlimited ? String(record.trafficGb) : null,
    usedGbText: null,
    remainingGbText: null,
    usagePercent: null,
    expireDate: expiresAt ? expiresAt.toLocaleDateString("fa-IR") : null,
    daysLeft,
    smartLink: subscriptionLink({ link: record.sub_link }),
    createdAt: record.createdAt || null,
    live: false,
    fallbackReason: reason || "panel_unreachable",
  };
}

// ── Cache core ──────────────────────────────────────────────────────────────

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function fetchLive(username) {
  try {
    return normalizeServiceResult(await getServiceInfo(username));
  } catch (error) {
    if (error?.reason === "service_not_found") {
      const missing = new Error("service_not_found_on_panel");
      missing.code = "service_not_found_on_panel";
      throw missing;
    }
    throw error;
  }
}

/**
 * Live status with caching. NEVER throws; callers get { ok, live, data, fetchedAt, errorCode } and decide how to display.
 * `live` is false for the panel's stored copy, even though `ok` and `data` are present.
 */
export async function getServiceLiveStatus(username, { maxAgeMs, fresh = false } = {}) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(username)) {
    return { ok: false, live: false, data: null, errorCode: "invalid_username" };
  }
  const now = Date.now();
  const entry = cache.get(username);
  if (!fresh && entry && entry.expiresAt > now) {
    return { ok: true, live: true, data: entry.data, fetchedAt: entry.fetchedAt, cached: true };
  }

  let promise = inFlight.get(username);
  if (!promise) {
    promise = fetchLive(username)
      .then((data) => {
        const fetchedAt = Date.now();
        if (data.live && inFlight.get(username) === promise) {
          cache.set(username, { data, fetchedAt, expiresAt: fetchedAt + (maxAgeMs ?? ttlMs()) });
          pruneCache();
        }
        return { ok: true, live: data.live, data, fetchedAt, cached: false };
      })
      .catch((error) => ({ ok: false, live: false, data: null, errorCode: error?.code || "panel_unreachable" }))
      .finally(() => { if (inFlight.get(username) === promise) inFlight.delete(username); });
    inFlight.set(username, promise);
  }
  return promise;
}

/**
 * Full view for "My Services": live panel data when available, otherwise the panel's stored copy, otherwise the user's own
 * record. Also returns the DB record for identity fields.
 */
export async function getServiceView(username, telegramId) {
  const [status, user] = await Promise.all([
    getServiceLiveStatus(username),
    telegramId
      ? User.findOne({ telegramId: String(telegramId), "services.username": username })
          .select("services.$ telegramId")
          .lean()
      : User.findOne({ "services.username": username }).select("services.$ telegramId").lean(),
  ]);
  const record = user?.services?.[0] || null;
  if (status.ok) {
    const data = status.data.smartLink ? status.data : { ...status.data, smartLink: subscriptionLink({ link: record?.sub_link }) };
    return { source: status.live ? "live" : "stale", data, record, fetchedAt: status.fetchedAt };
  }
  if (status.errorCode === "service_not_found_on_panel") {
    return { source: "missing", data: null, record, errorCode: status.errorCode };
  }
  return { source: "cached", data: fallbackFromDbRecord(record, { reason: status.errorCode }), record, errorCode: status.errorCode };
}
