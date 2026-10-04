/**
 * Cached real-time WizardXray service status.
 *
 * The WizardXray panel is the source of truth for live service state
 * (status, usage, expiry). MongoDB records are the fallback for identity
 * data (traffic plan, purchase date, expiry estimate) and for whenever the
 * panel is unreachable.
 *
 * Behavior:
 *   - Live results are cached per username for WIZARD_STATUS_TTL_SECONDS
 *     (default 90) so rapid taps / menu browsing cannot hammer the panel.
 *   - Concurrent requests for the same username share one in-flight promise.
 *   - Panel failures never throw to the caller: the caller receives a
 *     fallback record with `live: false` plus the safe error code.
 *   - Nothing is ever deleted or mutated here; this module is read-only.
 */
import { findService } from "../api/wizardApi.js";
import User from "../models/User.js";

const DEFAULT_TTL_MS = 90_000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map(); // username -> { expiresAt, promise }
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

// ── Parsing helpers (pure, defensive) ───────────────────────────────────────

/** Parse a size like "1.5", "1.5 GB", "700 MB" into gigabytes. */
export function parseSizeToGb(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value; // already GB
  const text = String(value).trim();
  const match = text.match(/^([\d.,]+)\s*(TB|GB|MB|KB)?/i);
  if (!match) return null;
  const number = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(number)) return null;
  const unit = (match[2] || "GB").toUpperCase();
  if (unit === "TB") return number * 1024;
  if (unit === "GB") return number;
  if (unit === "MB") return number / 1024;
  if (unit === "KB") return number / (1024 * 1024);
  return number;
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
  limited: "🔴 منقضی/محدود شده",
};

export function statusLabel(status) {
  return STATUS_LABELS[String(status || "").toLowerCase()] || "⚠️ نامشخص";
}

/**
 * Normalize a WizardXray /find result into display-safe fields.
 * Returns null when the payload does not describe a service.
 */
export function normalizeServiceResult(result) {
  if (!result || typeof result !== "object") return null;
  const username = typeof result.username === "string" && result.username.trim() ? result.username : null;
  if (!username) return null; // a payload without a username does not describe a service
  const online = result.online_info && typeof result.online_info === "object" ? result.online_info : {};
  const latest = result.latest_info && typeof result.latest_info === "object" ? result.latest_info : {};

  const status = typeof online.status === "string" ? online.status.toLowerCase() : (typeof latest.status === "string" ? latest.status.toLowerCase() : null);
  const totalGb = parseSizeToGb(latest.gig);
  const usedGb = parseSizeToGb(online.usage_converted ?? online.usage ?? latest.usage_converted);
  const remainingGb = totalGb != null && usedGb != null ? Math.max(0, Number((totalGb - usedGb).toFixed(3))) : null;
  const usagePercent = totalGb != null && usedGb != null && totalGb > 0
    ? Math.min(100, Math.max(0, Math.round((usedGb / totalGb) * 100)))
    : null;
  const daysLeft = Number.isFinite(Number(latest.day)) ? Number(latest.day) : null;
  const expireDate = typeof latest.expire_date === "string" && latest.expire_date ? latest.expire_date : null;

  const smartLink = result.hash
    ? `https://iranisystem.com/bot/sub/?hash=${encodeURIComponent(result.hash)}`
    : (typeof result.sub_link === "string" && result.sub_link.length <= 4096 ? result.sub_link : null);

  return {
    username,
    status,
    statusLabel: statusLabel(status),
    totalGbText: formatGb(totalGb),
    usedGbText: formatGb(usedGb),
    remainingGbText: formatGb(remainingGb),
    usagePercent,
    expireDate,
    daysLeft,
    smartLink,
    live: true,
  };
}

/** Build a fallback view from the user's stored service record. */
export function fallbackFromDbRecord(record, { reason } = {}) {
  if (!record) return null;
  const expiresAt = record.expiresAt ? new Date(record.expiresAt) : null;
  const daysLeft = expiresAt
    ? Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;
  return {
    username: record.username || null,
    status: null,
    statusLabel: null,
    totalGbText: record.trafficGb != null ? String(record.trafficGb) : null,
    usedGbText: null,
    remainingGbText: null,
    usagePercent: null,
    expireDate: expiresAt ? expiresAt.toLocaleDateString("fa-IR") : null,
    daysLeft,
    smartLink: record.sub_link || null,
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
  const response = await findService(username);
  // The panel signals a missing service with an explicit rejection; the
  // request() helper translates that into a thrown WizardApiError.
  const normalized = normalizeServiceResult(response?.result);
  if (!normalized?.username) {
    const error = new Error("service_not_found_on_panel");
    error.code = "service_not_found_on_panel";
    throw error;
  }
  return normalized;
}

/**
 * Live status with caching. NEVER throws; callers get
 * { ok, live, data, fetchedAt, errorCode } and decide how to display.
 */
export async function getServiceLiveStatus(username, { maxAgeMs } = {}) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(username)) {
    return { ok: false, live: false, data: null, errorCode: "invalid_username" };
  }
  const now = Date.now();
  const entry = cache.get(username);
  if (entry && entry.expiresAt > now) {
    return { ok: true, live: true, data: entry.data, fetchedAt: entry.fetchedAt, cached: true };
  }

  let promise = inFlight.get(username);
  if (!promise) {
    promise = fetchLive(username)
      .then((data) => {
        cache.set(username, { data, fetchedAt: Date.now(), expiresAt: Date.now() + (maxAgeMs ?? ttlMs()) });
        pruneCache();
        return { ok: true, live: true, data, fetchedAt: Date.now(), cached: false };
      })
      .catch((error) => ({ ok: false, live: false, data: null, errorCode: error?.code || "panel_unreachable" }))
      .finally(() => { inFlight.delete(username); });
    inFlight.set(username, promise);
  }
  return promise;
}

/**
 * Full view for "My Services": live panel data when available, otherwise the
 * user's stored record. Also returns the DB record for identity fields.
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
  if (status.ok && status.live) {
    return { source: "live", data: status.data, record, fetchedAt: status.fetchedAt };
  }
  if (status.errorCode === "service_not_found_on_panel") {
    return { source: "missing", data: null, record, errorCode: status.errorCode };
  }
  return { source: "cached", data: fallbackFromDbRecord(record, { reason: status.errorCode }), record, errorCode: status.errorCode };
}
