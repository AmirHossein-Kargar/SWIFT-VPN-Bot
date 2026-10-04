import mongoose from "mongoose";
import SystemHealth from "../../models/SystemHealth.js";
import redisClient, { isRedisReady, getRedisError } from "../../config/redisClient.js";
import { default as botInstance } from "../../config/botInstance.js";
import { StatusApi } from "../../api/wizardApi.js";
import { verifyInvoice as apiVerifyInvoice } from "../hooshpay/hooshpayClient.js";
import { createHooshPayClient } from "../hooshpay/hooshpayClient.js";
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

async function checkTelegram() {
  const started = nowMs();
  try {
    const bot = botInstance.bot;
    if (!bot) throw new Error("bot not started");
    const me = await withTimeout(bot.getMe(), CHECK_TIMEOUT_MS, "telegram getMe");
    if (!me?.id) throw new Error("unexpected getMe reply");
    return { status: classify(nowMs() - started, 2_000, null), latencyMs: nowMs() - started, error: null };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

const CHECKERS = {
  mongodb: checkMongo,
  redis: checkRedis,
  wizardxray: checkWizardXray,
  hooshpay: checkHooshPay,
  telegram: checkTelegram,
};

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
  jobStats = {};
}

export { INTERNAL_SERVICES };
