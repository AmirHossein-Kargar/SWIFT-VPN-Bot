import mongoose from "mongoose";
import SystemHealth from "../../models/SystemHealth.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import redisClient, { isRedisReady, getRedisError } from "../../config/redisClient.js";
import { default as botInstance } from "../../config/botInstance.js";
import { StatusApi } from "../../api/wizardApi.js";
import { createHooshPayClient } from "../hooshpay/hooshpayClient.js";
import { readNowPaymentsConfig } from "../nowpayments/money.js";
import { assertAdminUser } from "./authorization.js";

const CHECK_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30_000;
const PERSIST_INTERVAL_MS = 60_000;
const MEMORY_CACHE = new Map();
let lastPersistAt = 0;

const INTERNAL_SERVICES = new Set(["webhook", "background-jobs"]);

function nowMs() { return Date.now(); }

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeError(error) {
  const name = error?.name || "Error";
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (Number.isInteger(error?.status)) return `HTTP ${error.status} response`;
  if (code === "ETIMEDOUT" || code === "ECONNABORTED") return "مهلت درخواست پایان یافت";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "آدرس سرور قابل تشخیص نیست";
  if (code === "ECONNREFUSED") return "اتصال رد شد";
  return `${name}`;
}

function classify(latencyMs, degradedThresholdMs, error) {
  if (error) return "down";
  if (latencyMs != null && latencyMs > degradedThresholdMs) return "degraded";
  return "healthy";
}

async function checkMongo() {
  const started = nowMs();
  try {
    if (mongoose.connection?.readyState !== 1) throw new Error("not connected");
    await withTimeout(mongoose.connection.db.command({ ping: 1 }), CHECK_TIMEOUT_MS, "mongo ping");
    return { status: classify(nowMs() - started, 800, null), latencyMs: nowMs() - started, error: null };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

async function checkRedis() {
  const started = nowMs();
  try {
    if (!redisClient || !isRedisReady()) throw new Error(getRedisError()?.name || "not connected");
    const reply = await withTimeout(redisClient.ping(), CHECK_TIMEOUT_MS, "redis ping");
    if (reply !== "PONG") throw new Error("unexpected ping reply");
    return { status: classify(nowMs() - started, 300, null), latencyMs: nowMs() - started, error: null };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

async function checkWizardXray() {
  const started = nowMs();
  try {
    const status = await withTimeout(StatusApi(), CHECK_TIMEOUT_MS, "wizard status");
    const result = status?.result || {};
    if (result.system && result.system !== "connected") throw new Error("panel reports it is not connected");
    return {
      status: classify(nowMs() - started, 2_500, null),
      latencyMs: nowMs() - started,
      error: null,
      details: {
        panelPingMs: Number.isFinite(Number(result.ping)) ? Number(result.ping) : null,
        activeServices: Number.isFinite(Number(result.count_active_services)) ? Number(result.count_active_services) : null,
        totalServices: Number.isFinite(Number(result.count_services)) ? Number(result.count_services) : null,
      },
    };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

async function checkHooshPay() {
  const started = nowMs();
  try {
    createHooshPayClient();
    return { status: classify(nowMs() - started, 500, null), latencyMs: nowMs() - started, error: null };
  } catch (error) {
    const notConfigured = /not configured/i.test(String(error?.message || ""));
    return { status: "down", latencyMs: null, error: notConfigured ? "HOOSHPAY_API_KEY is not configured" : safeError(error) };
  }
}

async function checkNowPayments() {
  const started = nowMs();
  try {
    if (!readNowPaymentsConfig()) throw new Error("not configured");
    return { status: classify(nowMs() - started, 500, null), latencyMs: nowMs() - started, error: null };
  } catch (error) {
    const notConfigured = /not configured/i.test(String(error?.message || "")) || error?.code === "not_configured";
    return { status: "down", latencyMs: null, error: notConfigured ? "NOWPayments configuration is incomplete" : safeError(error) };
  }
}

// The bot long-polls (single replica). node-telegram-bot-api emits `polling_error` on every failed getUpdates round and
// has no success event. A 409 is Telegram saying another process is polling with the same token, which silently
// starves this instance of updates.
//
// Recovery needs positive evidence, not silence: a polling error that merely stops arriving can also mean the poll loop
// died. The library stamps `_polling._lastUpdate` after every SUCCESSFUL getUpdates response (empty ones included, about
// every 10 s when idle), so "a success newer than the last error" proves recovery without any extra Telegram call. If the
// installed library does not expose that stamp, fall back to an error-free time window.
const POLLING_ERROR_WINDOW_MS = 2 * 60_000;
const POLLING_STALL_MS = 90_000;
const WEBHOOK_BACKLOG_DEGRADED = 100;
let lastPollingError = null;

export function recordPollingError({ status, code } = {}) {
  lastPollingError = {
    at: nowMs(),
    status: Number.isInteger(status) ? status : null,
    code: typeof code === "string" ? code.slice(0, 40) : null,
  };
}

/**
 * Whether long polling is currently failing, from evidence the running poller already produced.
 * Used by both System Health and /ready so they cannot disagree.
 */
export function getPollingEvidence(bot = botInstance.bot, now = nowMs()) {
  const polling = bot?._polling;
  const hasSuccessSignal = typeof polling?._lastUpdate === "number";
  const lastSuccessAt = hasSuccessSignal && polling._lastUpdate > 0 ? polling._lastUpdate : null;
  const errorAt = lastPollingError?.at ?? null;

  let failing = false;
  if (errorAt !== null) {
    failing = hasSuccessSignal
      // Only a poll that succeeded AFTER the error counts as recovery. `>=` on purpose: the library stamps `_lastUpdate`
      // when the response arrives and BEFORE it processes the updates, so a handler error is reported in the same
      // millisecond as (or later than) its own stamp and must not be mistaken for a later success. A genuinely later
      // success cannot tie with an earlier error: the next poll starts at least `polling.interval` (300 ms) after it.
      ? lastSuccessAt === null || errorAt >= lastSuccessAt
      : now - errorAt < POLLING_ERROR_WINDOW_MS;
  }
  // Polling is meant to be running and no error was reported, yet no poll has completed for far longer than the 10 s long-poll.
  const stalled = !failing && lastSuccessAt !== null && typeof bot?.isPolling === "function" && bot.isPolling()
    && now - lastSuccessAt > POLLING_STALL_MS;

  return {
    failing,
    stalled,
    source: hasSuccessSignal ? "poller" : "error-window",
    lastErrorAgeSec: errorAt === null ? null : Math.max(0, Math.round((now - errorAt) / 1000)),
    lastErrorStatus: lastPollingError?.status ?? null,
    lastErrorCode: lastPollingError?.code ?? null,
    lastSuccessAgeSec: lastSuccessAt === null ? null : Math.max(0, Math.round((now - lastSuccessAt) / 1000)),
  };
}

/** Telegram's last_error_message can echo URLs or tokens; keep a short, scrubbed excerpt only. */
function scrubTelegramText(value) {
  return String(value ?? "")
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function checkTelegram() {
  const started = nowMs();
  try {
    const bot = botInstance.bot;
    if (!bot) throw new Error("bot not started");
    const me = await withTimeout(bot.getMe(), CHECK_TIMEOUT_MS, "telegram getMe");
    if (!me?.id) throw new Error("unexpected getMe reply");
    const latencyMs = nowMs() - started;

    let status = classify(latencyMs, 2_000, null);
    const issues = [];
    const raise = (level, message) => {
      issues.push(message);
      if (level === "down" || status === "healthy") status = level;
    };
    const details = {};

    const evidence = getPollingEvidence(bot);
    details.polling = evidence;
    if (evidence.failing) {
      if (evidence.lastErrorStatus === 409) raise("down", "Another process is polling with this bot token (409 Conflict); keep exactly one replica");
      else raise("degraded", "Long polling is failing; no successful poll since the last error");
    } else if (evidence.stalled) {
      raise("degraded", `No successful long-poll for ${evidence.lastSuccessAgeSec} s`);
    }

    // Read-only and safe next to getUpdates polling (it does not consume updates). The webhook URL itself is never returned.
    try {
      const info = await withTimeout(bot.getWebHookInfo(), CHECK_TIMEOUT_MS, "telegram getWebhookInfo");
      const pending = Number.isFinite(Number(info?.pending_update_count)) ? Number(info.pending_update_count) : null;
      const lastErrorDate = Number(info?.last_error_date);
      details.webhook = {
        registered: Boolean(info?.url),
        pendingUpdates: pending,
        lastErrorAgeSec: Number.isFinite(lastErrorDate) && lastErrorDate > 0 ? Math.max(0, Math.round(nowMs() / 1000 - lastErrorDate)) : null,
        lastErrorMessage: info?.last_error_message ? scrubTelegramText(info.last_error_message) : null,
      };
      if (info?.url) raise("degraded", "A webhook is registered while the bot uses long polling");
      if (pending !== null && pending > WEBHOOK_BACKLOG_DEGRADED) raise("degraded", `${pending} updates are waiting at Telegram`);
    } catch (error) {
      details.webhook = { available: false, reason: safeError(error) };
    }

    return { status, latencyMs, error: issues.join("; ") || null, details };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

// A wallet purchase moves through reserving -> reserved -> provisioning -> provisioned -> completed in seconds
// (docs/reserved-orders.md), so a state only counts as a problem once it has outlived that normal window. Each time field
// is paired with `createdAt` so an order with a null/missing marker is still caught instead of silently never matching.
const STALE_ORDER_MS = 10 * 60_000;
const SETTLE_MS = 2 * 60_000; // grace for delivery/alert/refund that normally finish within seconds

/**
 * Wallet-purchase fulfilment backlog. Counts only, no customer data. A backlog is "degraded" (an admin has something to do)
 * and never "down": it must not turn the overall status red the way MongoDB/Redis/Telegram do.
 *
 * Categories are disjoint (each order has one status) except `alertPending`, which is a SUBSET of `awaitingProvider`.
 * Statuses that are terminal or healthy-in-flight (completed+delivered, refunded, failed, fresh provisioning) are not counted.
 */
async function checkOrderFulfillment() {
  const started = nowMs();
  try {
    if (mongoose.connection?.readyState !== 1) throw new Error("not connected");
    const staleBefore = new Date(Date.now() - STALE_ORDER_MS);
    const settledBefore = new Date(Date.now() - SETTLE_MS);
    const olderThan = (field, before) => ({ $or: [{ [field]: { $lt: before } }, { [field]: null, createdAt: { $lt: before } }] });
    const count = (filter) => withTimeout(WalletPurchase.countDocuments(filter), CHECK_TIMEOUT_MS, "order count");
    const [awaitingProvider, needsReview, refundPending, stalledProvisioning, ledgerStalled, deliveryPending, alertPending, oldest] = await Promise.all([
      count({ status: "awaiting_provider" }),
      count({ status: { $in: ["manual_review", "uncertain"] } }),
      count({ status: "refund_pending", ...olderThan("refundRequestedAt", settledBefore) }),
      count({ status: "provisioning", ...olderThan("provisioningStartedAt", staleBefore) }),
      // Transient ledger steps that only persist after a crash; the recovery job repairs them.
      count({ $or: [
        { status: { $in: ["reserving", "reserved"] }, createdAt: { $lt: staleBefore } },
        { status: "provisioned", ...olderThan("provisionedAt", staleBefore) },
      ] }),
      count({ status: "completed", notificationPending: true, ...olderThan("completedAt", settledBefore) }),
      count({ status: "awaiting_provider", adminAlertPending: true, ...olderThan("awaitingProviderSince", settledBefore) }),
      // Ignore a missing date: ascending sort puts null first, which would hide the real oldest order.
      withTimeout(WalletPurchase.findOne({ status: "awaiting_provider", awaitingProviderSince: { $type: "date" } }).sort({ awaitingProviderSince: 1 }).select("awaitingProviderSince").lean(), CHECK_TIMEOUT_MS, "oldest order"),
    ]);
    const issues = [];
    if (needsReview) issues.push(`${needsReview} order(s) need manual reconciliation with the panel`);
    if (stalledProvisioning) issues.push(`${stalledProvisioning} order(s) stuck in provisioning`);
    if (ledgerStalled) issues.push(`${ledgerStalled} order(s) stuck in an interrupted ledger step`);
    if (refundPending) issues.push(`${refundPending} refund(s) pending`);
    if (awaitingProvider) issues.push(`${awaitingProvider} order(s) waiting for WizardXray funds`);
    if (alertPending) issues.push(`${alertPending} admin alert(s) not delivered`);
    if (deliveryPending) issues.push(`${deliveryPending} service(s) created but not delivered`);
    const oldestSince = oldest?.awaitingProviderSince ? new Date(oldest.awaitingProviderSince).getTime() : null;
    return {
      status: issues.length ? "degraded" : "healthy",
      latencyMs: nowMs() - started,
      error: issues.join("; ") || null,
      details: {
        awaitingProvider,
        needsReview,
        refundPending,
        stalledProvisioning,
        ledgerStalled,
        deliveryPending,
        alertPending,
        oldestAwaitingMinutes: oldestSince ? Math.max(0, Math.round((Date.now() - oldestSince) / 60_000)) : null,
      },
    };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

const CHECKERS = {
  mongodb: checkMongo,
  redis: checkRedis,
  wizardxray: checkWizardXray,
  hooshpay: checkHooshPay,
  nowpayments: checkNowPayments,
  telegram: checkTelegram,
  orders: checkOrderFulfillment,
};

export { CHECKERS as HEALTH_CHECKERS };

async function persistHealth(name, outcome) {
  try {
    await SystemHealth.findOneAndUpdate(
      { name },
      {
        $set: {
          name,
          status: outcome.status,
          lastCheckedAt: new Date(),
          ...(outcome.status === "healthy" || outcome.status === "degraded"
            ? { lastSuccessAt: new Date(), latencyMs: outcome.latencyMs ?? null, lastError: null }
            : { lastFailureAt: new Date(), lastError: (outcome.error || "unknown error").slice(0, 160) }),
          details: outcome.details || {},
        },
      },
      { upsert: true }
    );
  } catch {
    // Health persistence is best-effort; never fail a check because of it.
  }
}

async function loadPersisted(names) {
  // Without a connection Mongoose would buffer this query for ~10 s, freezing the page exactly when MongoDB is the outage.
  if (mongoose.connection?.readyState !== 1) return new Map();
  try {
    const docs = await SystemHealth.find({ name: { $in: names } }).lean();
    return new Map(docs.map((doc) => [doc.name, doc]));
  } catch {
    return new Map();
  }
}

export async function getSystemHealth({ actorId, fresh = false } = {}) {
  assertAdminUser(actorId);
  const names = Object.keys(CHECKERS);
  const now = nowMs();
  const outcomes = new Map();
  const needsCheck = [];
  for (const name of names) {
    const cached = MEMORY_CACHE.get(name);
    if (!fresh && cached && now - cached.checkedAt < CACHE_TTL_MS) outcomes.set(name, cached);
    else needsCheck.push(name);
  }

  if (needsCheck.length) {
    const results = await Promise.all(needsCheck.map(async (name) => {
      const outcome = await CHECKERS[name]();
      return [name, { ...outcome, checkedAt: now }];
    }));
    for (const [name, outcome] of results) {
      outcomes.set(name, outcome);
      MEMORY_CACHE.set(name, outcome);
    }
    const shouldPersist = now - lastPersistAt > PERSIST_INTERVAL_MS;
    if (shouldPersist) {
      lastPersistAt = now;
      for (const [name, outcome] of results) void persistHealth(name, outcome);
    }
  }

  const persisted = await loadPersisted(names);
  const services = names.map((name) => {
    const outcome = outcomes.get(name);
    const record = persisted.get(name);
    return {
      name,
      status: outcome.status,
      latencyMs: outcome.latencyMs ?? null,
      error: outcome.error,
      details: outcome.details || {},
      lastCheckedAt: new Date(outcome.checkedAt).toISOString(),
      lastSuccessAt: record?.lastSuccessAt ? record.lastSuccessAt.toISOString() : null,
      lastFailureAt: record?.lastFailureAt ? record.lastFailureAt.toISOString() : null,
      lastErrorMessage: record?.lastError || null,
    };
  });

  const extended = [...services];
  extended.push({ name: "webhook", ...webhookHealth(), lastSuccessAt: null, lastFailureAt: null, lastErrorMessage: null, details: {} });
  extended.push({ name: "background-jobs", ...backgroundJobsHealth(), lastSuccessAt: null, lastFailureAt: null, lastErrorMessage: null, details: {} });

  const criticalDown = extended.filter((service) => ["mongodb", "redis", "telegram"].includes(service.name) && service.status === "down");
  return {
    generatedAt: new Date().toISOString(),
    overall: criticalDown.length ? "down" : (extended.some((service) => service.status !== "healthy") ? "degraded" : "healthy"),
    services: extended,
    notes: {
      webhook: "سلامت Webhook مربوط به همین فرایند است و پرچم‌های آمادگی اجرا را نشان می‌دهد.",
      "background-jobs": "سلامت کارهای پس‌زمینه مربوط به همین فرایند است؛ زمان آخرین اجرا فقط از فرایند جاری می‌آید.",
    },
  };
}

let lastWebhookSuccessAt = null;
let lastWebhookFailureAt = null;
let lastWebhookError = null;

export function recordWebhookOutcome({ ok, error } = {}) {
  if (ok) {
    lastWebhookSuccessAt = new Date().toISOString();
    lastWebhookError = null;
  } else {
    lastWebhookFailureAt = new Date().toISOString();
    lastWebhookError = error ? String(error).slice(0, 160) : "processing failed";
  }
}

function webhookHealth() {
  const hasBase = Boolean(process.env.WEBHOOK_BASE_URL && process.env.HOOSHPAY_WEBHOOK_SECRET);
  return {
    status: hasBase ? "healthy" : "degraded",
    error: hasBase ? null : "WEBHOOK_BASE_URL or HOOSHPAY_WEBHOOK_SECRET is not configured",
    details: {
      lastSuccessAt: lastWebhookSuccessAt,
      lastFailureAt: lastWebhookFailureAt,
      lastError: lastWebhookError,
      baseUrlConfigured: Boolean(process.env.WEBHOOK_BASE_URL),
      secretConfigured: Boolean(process.env.HOOSHPAY_WEBHOOK_SECRET),
    },
    lastCheckedAt: new Date().toISOString(),
  };
}

let jobStats = {};

export function recordJobRun(job, { ok, meta = {} } = {}) {
  jobStats[job] = {
    lastRunAt: new Date().toISOString(),
    ok: Boolean(ok),
    ...meta,
  };
}

export function getRecordedJobStats() {
  return { ...jobStats };
}

function backgroundJobsHealth() {
  const trx = jobStats["trx-scanner"];
  const hoosh = jobStats["hooshpay-recovery-cron"];
  const staleMs = 15 * 60_000;
  const evaluate = (entry) => {
    if (!entry) return { status: "unknown", error: "no run recorded since process start" };
    const age = Date.now() - new Date(entry.lastRunAt).getTime();
    if (!entry.ok) return { status: "down", error: "last run failed" };
    if (age > staleMs) return { status: "degraded", error: `last run was ${Math.round(age / 60_000)} minutes ago` };
    return { status: "healthy", error: null };
  };
  const trxState = evaluate(trx);
  const hooshState = evaluate(hoosh);
  const status = [trxState.status, hooshState.status].includes("down") ? "down"
    : [trxState.status, hooshState.status].some((value) => value !== "healthy") ? "degraded" : "healthy";
  return {
    status,
    error: [trxState.error, hooshState.error].filter(Boolean).join("; ") || null,
    details: {
      trxScanner: { ...trxState, lastRunAt: trx?.lastRunAt || null },
      hooshpayRecoveryCron: { ...hooshState, lastRunAt: hoosh?.lastRunAt || null },
    },
    lastCheckedAt: new Date().toISOString(),
  };
}

export function resetHealthCacheForTests() {
  MEMORY_CACHE.clear();
  lastPersistAt = 0;
  lastWebhookSuccessAt = null;
  lastWebhookFailureAt = null;
  lastWebhookError = null;
  lastPollingError = null;
  jobStats = {};
}

export { INTERNAL_SERVICES };
