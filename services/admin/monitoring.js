import { createHmac, randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import SystemHealth from "../../models/SystemHealth.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import redisClient, { isRedisReady, getRedisError } from "../../config/redisClient.js";
import { default as botInstance } from "../../config/botInstance.js";
import { StatusApi, getAccount, getHosts, panelPingMs, quotePrice } from "../../api/wizardApi.js";
import { probeHooshPay } from "../hooshpay/hooshpayClient.js";
import { canonicalPayload } from "../hooshpay/verifySignature.js";
import { readNowPaymentsConfig } from "../nowpayments/money.js";
import { probeNowPayments } from "../nowpayments/nowpaymentsClient.js";
import { signNowPaymentsIpn } from "../nowpayments/signature.js";
import { getSellablePlans } from "../plans.js";
import { providerCost } from "../wizardAccount.js";
import { assertAdminUser } from "./authorization.js";
import { jobStates, worstState } from "../reliability/health.js";
import { WEBHOOK_PROBE_TOKEN, observeJob, observePollingError, telemetry } from "../reliability/telemetry.js";

const CHECK_TIMEOUT_MS = 8_000;
/** Locations and the sample quote change rarely, and each is one more call to the provider. */
const WIZARD_DEEP_CHECK_MS = 5 * 60_000;
const CACHE_TTL_MS = 30_000;
const PERSIST_INTERVAL_MS = 60_000;
const MEMORY_CACHE = new Map();
let lastPersistAt = 0;

const INTERNAL_SERVICES = new Set(["webhook", "background-jobs"]);
const CRITICAL_SERVICES = ["mongodb", "redis", "telegram", "wizardxray"];
const REDIS_PROBE_KEY = `health:probe:${process.pid}`;

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

const WIZARD_REASONS = {
  auth_invalid: "WizardXray rejected the API key",
  auth_missing: "WizardXray did not accept the API key header",
  api_disabled: "The WizardXray web service is switched off",
};

function safeError(error) {
  const name = error?.name || "Error";
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (WIZARD_REASONS[error?.reason]) return WIZARD_REASONS[error.reason];
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

/**
 * A Redis that answers PING can still refuse writes (out of memory, read-only), which would break sessions and locks while reading
 * healthy. So this also writes one expiring key of its own and reads it back. It holds no data, and every run overwrites it.
 */
async function checkRedis({ client = redisClient, ready = isRedisReady } = {}) {
  const started = nowMs();
  try {
    if (!client || !ready()) throw new Error(getRedisError()?.name || "not connected");
    const reply = await withTimeout(client.ping(), CHECK_TIMEOUT_MS, "redis ping");
    if (reply !== "PONG") throw new Error("unexpected ping reply");
    const stamp = String(nowMs());
    await withTimeout(client.set(REDIS_PROBE_KEY, stamp, { EX: 120 }), CHECK_TIMEOUT_MS, "redis write");
    if ((await withTimeout(client.get(REDIS_PROBE_KEY), CHECK_TIMEOUT_MS, "redis read")) !== stamp) throw new Error("a written value did not read back");
    return { status: classify(nowMs() - started, 300, null), latencyMs: nowMs() - started, error: null };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

let wizardDeepCheck = null;

/**
 * The slower half of the WizardXray check: can it name a location, and does `price` agree with the prices `me` reports? Those
 * two are what a purchase depends on after the connection itself. Both are reads. Kept for a few minutes because a provider
 * should not be asked once a minute what rarely changes.
 */
async function wizardDeepCheckResult(account) {
  if (wizardDeepCheck && nowMs() - wizardDeepCheck.at < WIZARD_DEEP_CHECK_MS) return wizardDeepCheck.value;
  const issues = [];
  let locations = null;
  try {
    const hosts = await withTimeout(getHosts(), CHECK_TIMEOUT_MS, "wizard hosts");
    locations = hosts.filter((host) => !host.disabled).length;
    if (!locations) issues.push("WizardXray lists no enabled location");
  } catch (error) {
    if (error?.reason !== "hosts_unavailable") throw error;
    locations = 0;
    issues.push("WizardXray lists no location, or could not reach its service panel");
  }
  const quote = await withTimeout(quotePrice(1, 1), CHECK_TIMEOUT_MS, "wizard price");
  const expected = providerCost(account, { gig: 1, days: 1 });
  if (expected !== null && quote.price !== expected) issues.push("WizardXray's quote disagrees with its own price list");
  const value = { locations, issues };
  wizardDeepCheck = { at: nowMs(), value };
  return value;
}

/** The cheapest thing on sale, at the provider's price. Null when the catalog cannot say. */
async function cheapestOrderCost(account) {
  try {
    const plans = await getSellablePlans();
    const costs = plans.map((plan) => providerCost(account, { gig: plan.gig, days: plan.days })).filter((cost) => cost !== null);
    return costs.length ? Math.min(...costs) : null;
  } catch {
    return null;
  }
}

/**
 * Whether WizardXray can fulfil an order, which takes more than an answer on a port. `status` says the bot still reaches the
 * service panel, `me` proves the key and gives the prices, and the rest asks whether the next sale could be provisioned. Every
 * call is a read: no check here creates or changes a service.
 */
async function checkWizardXray() {
  const started = nowMs();
  try {
    // `status` decides whether the panel is up. `me` failing alone leaves orders working, so it is a problem and not an outage,
    // unless it is the key that was refused, which `status` would have refused too.
    const [status, account] = await withTimeout(Promise.all([StatusApi(), getAccount().catch((error) => ({ failed: error }))]), CHECK_TIMEOUT_MS, "wizard status");
    const result = status?.result || {};
    if (result.system && result.system !== "connected") throw new Error("the panel reports it cannot reach its service server");
    const latencyMs = nowMs() - started;
    const issues = [];
    if (latencyMs > 2_500) issues.push(`WizardXray took ${latencyMs} ms`);
    if (account.failed) {
      issues.push(`WizardXray answered, but its account details could not be read (${safeError(account.failed)}); unlimited stays off sale`);
      return { status: "degraded", latencyMs, error: issues.join("; "), details: { panelPingMs: panelPingMs(result) } };
    }
    const deep = await wizardDeepCheckResult(account).catch((error) => ({ locations: null, issues: [`A WizardXray read failed: ${safeError(error)}`] }));
    issues.push(...deep.issues);
    const cheapest = await cheapestOrderCost(account);
    if (cheapest !== null && account.balance !== null && account.balance < cheapest) issues.push("The WizardXray wallet cannot fund the cheapest plan; new orders will wait for funds");
    return {
      status: issues.length ? "degraded" : "healthy",
      latencyMs,
      error: issues.join("; ") || null,
      details: {
        panelPingMs: panelPingMs(result),
        activeServices: Number.isFinite(Number(result.count_active_services)) ? Number(result.count_active_services) : null,
        totalServices: Number.isFinite(Number(result.count_services)) ? Number(result.count_services) : null,
        balanceToman: account.balance,
        unlimitedEnabled: account.limits.unlimitedEnabled,
        locations: deep.locations,
      },
    };
  } catch (error) {
    return { status: "down", latencyMs: null, error: error?.message === "the panel reports it cannot reach its service server" ? "WizardXray cannot reach its service server" : safeError(error) };
  }
}

const notConfigured = (message) => ({ status: "unknown", latencyMs: null, error: message, details: { configured: false } });

/** A real request with the real key. Constructing a client, which is all this used to do, proves only that a variable is set. */
async function checkHooshPay() {
  const started = nowMs();
  if (!process.env.HOOSHPAY_API_KEY?.trim()) return notConfigured("HOOSHPAY_API_KEY is not configured");
  try {
    const answer = await withTimeout(probeHooshPay(), CHECK_TIMEOUT_MS, "hooshpay balance");
    const latencyMs = nowMs() - started;
    if (!answer.authorized) return { status: "down", latencyMs, error: "HooshPay rejected the API key" };
    if (answer.blocked) return { status: "down", latencyMs, error: "HooshPay reports the account is blocked" };
    if (answer.unavailable) return { status: "down", latencyMs, error: "HooshPay reports the gateway is disabled or has no card available" };
    if (!answer.recognized) return { status: "degraded", latencyMs, error: "HooshPay answered, but not in a recognizable form" };
    return { status: classify(latencyMs, 3_000, null), latencyMs, error: null, details: { configured: true } };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

/** The public liveness read, then a read that needs the key. */
async function checkNowPayments({ transport } = {}) {
  const started = nowMs();
  let config;
  try {
    config = readNowPaymentsConfig();
  } catch {
    return { status: "down", latencyMs: null, error: "NOWPayments configuration is invalid" };
  }
  if (!config) return notConfigured("NOWPayments configuration is incomplete");
  try {
    const answer = await withTimeout(probeNowPayments({ apiKey: config.apiKey, baseURL: config.baseURL, transport }), CHECK_TIMEOUT_MS, "nowpayments status");
    const latencyMs = nowMs() - started;
    if (!answer.reachable) return { status: "down", latencyMs, error: `NOWPayments status answered ${answer.status}` };
    if (!answer.authorized) return { status: "down", latencyMs, error: "NOWPayments rejected the API key" };
    return { status: classify(latencyMs, 3_000, null), latencyMs, error: null, details: { configured: true } };
  } catch (error) {
    return { status: "down", latencyMs: null, error: safeError(error) };
  }
}

/**
 * The webhook path, end to end, through this server's own routes. Each configured provider gets one correctly signed callback
 * naming an invoice that cannot exist, with a status that credits nothing. The only passing answer is 404 `invoice_not_found`,
 * which can only come after the route, the JSON parser, the signature check against the configured secret and a MongoDB lookup
 * have all worked. A wrong secret answers 401, a missing one 503, a database outage 503.
 *
 * It cannot touch money: the id is 24 random bytes, no record can match it, and neither handler writes for an unknown invoice.
 * The handlers are not changed by this and run exactly as they do for the provider.
 */
async function checkWebhookPath({ port = process.env.PORT || 3000, env = process.env } = {}) {
  const callback = async (path, body, signatureHeader, sign) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reliability-probe": WEBHOOK_PROBE_TOKEN, [signatureHeader]: sign(body) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const answer = await response.json().catch(() => null);
    return response.status === 404 && answer?.error === "invoice_not_found" ? null : `answered ${response.status}`;
  };
  const reference = () => `probe_${randomBytes(24).toString("hex")}`;
  const providers = [];
  if (env.HOOSHPAY_WEBHOOK_SECRET) {
    providers.push(["HooshPay", () => callback("/api/hooshpay/webhook", { invoice: reference(), order_id: reference(), status: "failed", event: "payment.failed" }, "X-HooshPay-Signature",
      (body) => createHmac("sha256", env.HOOSHPAY_WEBHOOK_SECRET).update(canonicalPayload(body), "utf8").digest("hex"))]);
  }
  if (env.NOWPAYMENTS_IPN_SECRET?.trim()) {
    // A well-formed order id: anything else is refused before the invoice lookup this check exists to exercise.
    providers.push(["NOWPayments", () => callback("/api/nowpayments/ipn", { order_id: `NP-${randomUUID()}`, payment_id: reference(), payment_status: "failed" }, "x-nowpayments-sig",
      (body) => signNowPaymentsIpn(body, env.NOWPAYMENTS_IPN_SECRET))]);
  }
  if (!providers.length) return notConfigured("No webhook secret is configured");

  const started = nowMs();
  const failures = [];
  await Promise.all(providers.map(async ([label, run]) => {
    try {
      const problem = await run();
      if (problem) failures.push(`${label} ${problem}`);
    } catch (error) {
      failures.push(`${label} did not answer (${error?.name || "Error"})`);
    }
  }));
  const latencyMs = nowMs() - started;
  return {
    status: failures.length === providers.length ? "down" : failures.length ? "degraded" : "healthy",
    latencyMs,
    error: failures.length ? `A signed test callback failed: ${failures.join("; ")}` : null,
    details: { configured: true, providers: providers.length, lastSuccessAt: lastWebhookSuccessAt, lastFailureAt: lastWebhookFailureAt, lastError: lastWebhookError },
  };
}

/**
 * Whether the bot can still post to a real chat. `getMe` proves the token; it does not prove sending. `sendChatAction` to the admin
 * group is the one send-class call that leaves no message: admins see "typing" for a few seconds, a few times an hour. It does
 * not prove that one customer's chat works, which nothing but delivering to it can.
 */
async function checkDeliveryPath() {
  const bot = botInstance.bot;
  const groupId = process.env.GROUP_ID;
  if (!groupId) return notConfigured("GROUP_ID is not configured");
  if (!bot?.sendChatAction) return { status: "unknown", latencyMs: null, error: "The bot has not started", details: { configured: true } };
  const started = nowMs();
  try {
    await withTimeout(bot.sendChatAction(groupId, "typing"), CHECK_TIMEOUT_MS, "telegram sendChatAction");
    return { status: "healthy", latencyMs: nowMs() - started, error: null, details: { configured: true } };
  } catch (error) {
    return { status: "down", latencyMs: null, error: `Telegram refused a send to the admin group (${safeError(error)})` };
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
  observePollingError({ status: Number.isInteger(status) ? status : null });
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
export const ORDER_STALE_MS = 10 * 60_000;
export const ORDER_SETTLE_MS = 2 * 60_000; // grace for delivery/alert/refund that normally finish within seconds

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
    const staleBefore = new Date(Date.now() - ORDER_STALE_MS);
    const settledBefore = new Date(Date.now() - ORDER_SETTLE_MS);
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
  webhook: checkWebhookPath,
};

/** Separate because it posts to the admin group, so only the monitor's slow timer may run it, never a page refresh. */
export { CHECKERS as HEALTH_CHECKERS, checkDeliveryPath };

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
  const jobs = backgroundJobsHealth();
  extended.push({ name: "background-jobs", ...jobs, lastSuccessAt: null, lastFailureAt: null, lastErrorMessage: null });

  // The same critical set as the Service Reliability Center, so the two pages cannot disagree about what "down" means.
  const criticalDown = extended.filter((service) => CRITICAL_SERVICES.includes(service.name) && service.status === "down");
  // An integration this deployment does not use is not a problem with this deployment. Anything else short of healthy is.
  const counted = extended.filter((service) => service.details?.configured !== false);
  return {
    generatedAt: new Date().toISOString(),
    overall: criticalDown.length ? "down" : (counted.some((service) => service.status !== "healthy") ? "degraded" : "healthy"),
    services: extended,
    notes: {
      webhook: "هر بار یک فراخوان امضاشدهٔ آزمایشی برای فاکتوری ناموجود از مسیر واقعی Webhook می‌گذرد؛ هیچ مبلغی تغییر نمی‌کند.",
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

let jobStats = {};

export function recordJobRun(job, { ok, meta = {} } = {}) {
  observeJob(job, { ok, skipped: meta?.skipped ?? null });
  jobStats[job] = {
    lastRunAt: new Date().toISOString(),
    ok: Boolean(ok),
    ...meta,
  };
}

export function getRecordedJobStats() {
  return { ...jobStats };
}

const JOB_STATUS = { healthy: "healthy", degraded: "degraded", failed: "down", stale: "degraded", unknown: "unknown" };

/** Every job on the schedule, judged by the same rules as the Service Reliability Center. This used to look at two of them. */
function backgroundJobsHealth({ now = nowMs(), env = process.env } = {}) {
  const jobs = jobStates(telemetry.jobs(), { now, startedAt: telemetry.startedAt, env });
  const worst = jobs.length ? worstState(jobs.map((job) => job.state)) : "unknown";
  const named = jobs.filter((job) => job.state === worst && worst !== "healthy");
  return {
    status: JOB_STATUS[worst] ?? "unknown",
    error: named.length ? `${named.map((job) => job.label).join(", ")}: ${named[0].reason}` : null,
    details: { jobs: jobs.map((job) => ({ name: job.name, label: job.label, state: job.state, lastRunAt: job.lastRunAt })) },
    lastCheckedAt: new Date(now).toISOString(),
  };
}

export function resetHealthCacheForTests() {
  MEMORY_CACHE.clear();
  lastPersistAt = 0;
  wizardDeepCheck = null;
  lastWebhookSuccessAt = null;
  lastWebhookFailureAt = null;
  lastWebhookError = null;
  lastPollingError = null;
  jobStats = {};
}

export { INTERNAL_SERVICES };
