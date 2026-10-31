/**
 * The in-process recorder behind the Service Reliability Center.
 *
 * Business code calls the `observe*` functions below from hot paths, including money paths, so three rules hold everywhere
 * in this file: an observer is synchronous, does no I/O and never throws. Memory is bounded by construction: a fixed
 * allow-list of series, a fixed number of minutes, a fixed-size event ring, and a coalescing key for anything that can
 * burst, so a flood of forged webhooks cannot push real events out.
 *
 * This module imports nothing from the application, so api/wizardApi.js and the provider clients can use it without an
 * import cycle. services/reliability/collector.js is the only reader, and the only code that persists what is recorded.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sanitizeCode, sanitizeText } from "./sanitize.js";

const MINUTE = 60_000;
/** One day of minutes plus the few not yet closed; history never needs more. */
export const MAX_MINUTES = 24 * 60 + 5;
export const EVENT_RING_SIZE = 1_000;
export const LATENCY_BOUNDS_MS = Object.freeze([25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 60_000]);

/** A key outside this list is dropped, so no caller, and no request, can grow the series space. */
export const SERIES = Object.freeze([
  "http.admin", "http.panel", "http.store", "http.support", "http.other",
  "webhook.hooshpay", "webhook.nowpayments",
  "provider.wizardxray.create", "provider.wizardxray.read", "provider.wizardxray.write",
  "provider.hooshpay", "provider.nowpayments",
  "telegram.update", "telegram.polling_error", "telegram.delivery",
]);
const KNOWN_SERIES = new Set(SERIES);
const OUTCOMES = new Set(["ok", "error", "rejected", "timeout"]);

const context = new AsyncLocalStorage();

/** Names the order a provider call belongs to, without changing the signature of anything in between. */
export function withTelemetryContext(values, run) {
  return context.run(values, run);
}

export function bucketIndex(ms) {
  for (let index = 0; index < LATENCY_BOUNDS_MS.length; index += 1) if (ms <= LATENCY_BOUNDS_MS[index]) return index;
  return LATENCY_BOUNDS_MS.length;
}

const emptySeries = () => ({ n: 0, ok: 0, err: 0, rej: 0, tmo: 0, sumMs: 0, timed: 0, h: new Array(LATENCY_BOUNDS_MS.length + 1).fill(0) });

export function createTelemetry({ now = Date.now, ringSize = EVENT_RING_SIZE, maxMinutes = MAX_MINUTES, instance = randomBytes(4).toString("hex") } = {}) {
  const minutes = new Map();
  const ring = [];
  const lastOk = new Map();
  const lastFailure = new Map();
  const coalescing = new Map();
  const listeners = new Set();
  const jobs = new Map();
  let sequence = 0;
  let droppedEvents = 0;
  const startedAt = now();

  function minuteFor(at) {
    const t = at - (at % MINUTE);
    let minute = minutes.get(t);
    if (!minute) {
      minute = { t, series: {}, health: {}, flushed: false };
      minutes.set(t, minute);
      while (minutes.size > maxMinutes) minutes.delete(minutes.keys().next().value);
    }
    return minute;
  }

  function observe(key, { outcome = "ok", ms = null } = {}) {
    if (!KNOWN_SERIES.has(key) || !OUTCOMES.has(outcome)) return;
    const at = now();
    const minute = minuteFor(at);
    const series = (minute.series[key] ||= emptySeries());
    series.n += 1;
    if (outcome === "ok") { series.ok += 1; lastOk.set(key, at); }
    else if (outcome === "error") { series.err += 1; lastFailure.set(key, at); }
    else if (outcome === "timeout") { series.tmo += 1; lastFailure.set(key, at); }
    else series.rej += 1;
    if (Number.isFinite(ms) && ms >= 0) {
      series.sumMs += ms;
      series.timed += 1;
      series.h[bucketIndex(ms)] += 1;
    }
    minute.flushed = false;
  }

  function notify(event) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* a slow or broken subscriber must not reach the caller */ }
    }
  }

  /**
   * Record one operational event. `coalesceKey` merges repeats within `coalesceMs` into one row with a count, which is what
   * keeps a burst from filling the ring. Every text field is sanitized here, once, so nothing later has to remember to.
   */
  function emit({ type, severity = "info", component, message, correlationId = null, orderKey = null, incidentId = null, coalesceKey = null, coalesceMs = 60_000, at = now() }) {
    const code = sanitizeCode(type);
    if (!code || !component) return null;
    if (coalesceKey) {
      const existing = coalescing.get(coalesceKey);
      if (existing && at - existing.windowStart < coalesceMs) {
        existing.event.count += 1;
        existing.event.lastAt = new Date(at).toISOString();
        existing.event.dirty = true;
        existing.event.seq = sequence += 1;
        notify(existing.event);
        return existing.event;
      }
    }
    sequence += 1;
    const event = {
      id: `${instance}-${sequence}`,
      seq: sequence,
      at: new Date(at).toISOString(),
      lastAt: null,
      type: code,
      severity,
      component: sanitizeCode(component),
      message: sanitizeText(message, 200),
      correlationId: correlationId == null ? null : sanitizeCode(correlationId, 128),
      orderKey: orderKey == null ? null : sanitizeCode(orderKey, 140),
      incidentId: incidentId == null ? null : sanitizeCode(incidentId, 64),
      count: 1,
      dirty: true,
    };
    ring.push(event);
    if (ring.length > ringSize) {
      const lost = ring.shift();
      if (lost?.dirty) droppedEvents += 1;
    }
    if (coalesceKey) {
      coalescing.set(coalesceKey, { windowStart: at, event });
      if (coalescing.size > 256) coalescing.delete(coalescing.keys().next().value);
    }
    notify(event);
    return event;
  }

  return {
    instance,
    startedAt,
    observe,
    emit,
    /** @returns {() => void} unsubscribe */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordJob(name, { ok, skipped = null }) {
      const code = sanitizeCode(name, 64);
      if (!code) return;
      const at = now();
      const previous = jobs.get(code);
      jobs.set(code, {
        name: code,
        lastRunAt: at,
        lastOkAt: ok ? at : previous?.lastOkAt ?? null,
        lastFailureAt: ok ? previous?.lastFailureAt ?? null : at,
        consecutiveFailures: ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
        runs: (previous?.runs ?? 0) + 1,
        skipped: skipped ? sanitizeCode(skipped, 40) : null,
      });
      if (!ok) emit({ type: "job.failed", severity: "error", component: "jobs", message: `${code} failed`, coalesceKey: `job-failed:${code}`, coalesceMs: 5 * MINUTE, at });
      else if (previous && previous.consecutiveFailures > 0) emit({ type: "job.recovered", severity: "info", component: "jobs", message: `${code} is running again`, at });
      else emit({ type: "job.completed", severity: "debug", component: "jobs", message: `${code} completed`, coalesceKey: `job-done:${code}`, coalesceMs: 15 * MINUTE, at });
    },
    jobs: () => [...jobs.values()],
    lastOkAt: (key) => lastOk.get(key) ?? null,
    lastFailureAt: (key) => lastFailure.get(key) ?? null,
    /** Health of the components at this minute, for the availability strip. Component ids are a fixed list. */
    stampHealth(states, at = now()) {
      const minute = minuteFor(at);
      minute.health = states;
      minute.flushed = false;
    },
    minutes: () => [...minutes.values()],
    /** Older minutes restored from MongoDB after a restart. Never overwrites a minute this process has already recorded. */
    hydrate(rows) {
      for (const row of [...rows].sort((a, b) => a.t - b.t)) {
        if (!minutes.has(row.t)) minutes.set(row.t, { t: row.t, series: row.series || {}, health: row.health || {}, flushed: true });
      }
      if (minutes.size > maxMinutes) {
        const ordered = [...minutes.keys()].sort((a, b) => a - b);
        for (const t of ordered.slice(0, ordered.length - maxMinutes)) minutes.delete(t);
      }
      const sorted = new Map([...minutes.entries()].sort((a, b) => a[0] - b[0]));
      minutes.clear();
      for (const [t, minute] of sorted) minutes.set(t, minute);
    },
    /** Closed minutes that changed since the last flush; the current minute waits until it is complete. */
    unflushedMinutes(at = now()) {
      const current = at - (at % MINUTE);
      return [...minutes.values()].filter((minute) => !minute.flushed && minute.t < current);
    },
    markMinutesFlushed(rows) {
      for (const row of rows) { const minute = minutes.get(row.t); if (minute) minute.flushed = true; }
    },
    events: () => [...ring],
    eventsAfter: (seq) => ring.filter((event) => event.seq > seq),
    dirtyEvents: () => ring.filter((event) => event.dirty),
    markEventsFlushed(events) { for (const event of events) event.dirty = false; },
    droppedEvents: () => droppedEvents,
    reset() {
      minutes.clear(); ring.length = 0; lastOk.clear(); lastFailure.clear(); coalescing.clear(); jobs.clear();
      sequence = 0; droppedEvents = 0;
    },
  };
}

export const telemetry = createTelemetry();

/** Nothing recorded here may ever reach the caller's error path. */
function guard(run) {
  try { run(); } catch { /* telemetry never affects the operation it observes */ }
}

const HTTP_GROUPS = [
  ["/api/admin/", "http.admin"],
  ["/api/support/", "http.support"],
  ["/api/store/", "http.store"],
  ["/panel", "http.panel"],
];
const IGNORED_PATHS = [
  // The dashboard must not measure itself: its own polling would read as traffic and keep every chart busy.
  "/api/admin/reliability", "/panel/reliability", "/panel/_next", "/_next",
  // Probes, and the webhook routes, which have their own series.
  "/health", "/livez", "/ready", "/api/hooshpay/webhook", "/api/nowpayments/ipn",
];

export function httpSeries(path) {
  if (typeof path !== "string") return "http.other";
  if (IGNORED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))) return null;
  for (const [prefix, series] of HTTP_GROUPS) if (path === prefix || path.startsWith(prefix)) return series;
  return "http.other";
}

/** Express middleware. The series comes from a fixed prefix table, never from the URL itself. */
export function observeRequests(req, res, next) {
  const series = httpSeries(req.path);
  if (!series) return next();
  const started = performance.now();
  res.once("finish", () => guard(() => {
    telemetry.observe(series, { outcome: res.statusCode >= 500 ? "error" : "ok", ms: performance.now() - started });
  }));
  next();
}

const REJECTION_REASON = { 400: "invalid request", 401: "invalid signature", 404: "unknown invoice", 409: "invoice state conflict", 415: "unsupported media type", 422: "signed details disagree", 429: "rate limited" };

/**
 * One payment callback, judged only by the HTTP status the handler answered, so it needs no change inside a handler that
 * moves money. The handler's own `request_id` is read off its JSON body and becomes the correlation id, the same id in logs.
 */
export function observeWebhook(provider) {
  const series = `webhook.${provider}`;
  return (req, res, next) => {
    if (req.method !== "POST") return next();
    const started = performance.now();
    const json = res.json.bind(res);
    let requestId = null;
    res.json = (body) => {
      guard(() => { if (typeof body?.request_id === "string") requestId = body.request_id; });
      return json(body);
    };
    res.once("finish", () => guard(() => {
      const status = res.statusCode;
      const ms = performance.now() - started;
      if (status < 300) {
        telemetry.observe(series, { outcome: "ok", ms });
        telemetry.emit({ type: "webhook.accepted", component: "webhook", message: `${provider} callback accepted`, correlationId: requestId });
      } else if (status >= 500) {
        telemetry.observe(series, { outcome: "error", ms });
        telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: `${provider} callback answered ${status}; the gateway will retry`, correlationId: requestId, coalesceKey: `webhook-failed:${provider}:${status}` });
      } else {
        telemetry.observe(series, { outcome: "rejected", ms });
        const reason = REJECTION_REASON[status] ?? `status ${status}`;
        telemetry.emit({ type: "webhook.rejected", severity: "warning", component: "webhook", message: `${provider} callback rejected: ${reason}`, correlationId: requestId, coalesceKey: `webhook-rejected:${provider}:${status}` });
      }
    }));
    next();
  };
}

function classifyProviderError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (["ETIMEDOUT", "ECONNABORTED", "ETIME"].includes(code) || error?.name === "TimeoutError") return "timeout";
  return "error";
}

/**
 * One outbound provider call. A proven refusal (a shortage of provider funds, a rejected request) is the provider answering,
 * so it counts as `rejected`, not as the provider being down. Only the coarse code is kept, never a response body.
 */
export function observeProvider(series, options) {
  guard(() => {
    const { operation, ms, error = null, rejected = false, mutation = false } = options ?? {};
    const outcome = error ? (rejected ? "rejected" : classifyProviderError(error)) : "ok";
    telemetry.observe(series, { outcome, ms });
    const provider = series.split(".")[1];
    const orderKey = context.getStore()?.orderKey ?? null;
    if (outcome === "ok") {
      if (mutation) telemetry.emit({ type: "provider.succeeded", component: provider, message: `${operation} succeeded`, orderKey });
      return;
    }
    const code = sanitizeCode(error?.code ?? error?.status ?? error?.name ?? "error", 60);
    const type = outcome === "timeout" ? "provider.timeout" : outcome === "rejected" ? "provider.rejected" : "provider.failed";
    const severity = outcome === "rejected" ? "warning" : "error";
    telemetry.emit({ type, severity, component: provider, message: `${operation} ${outcome === "timeout" ? "timed out" : outcome === "rejected" ? "was refused" : "failed"} (${code})`, orderKey, coalesceKey: orderKey ? null : `${type}:${series}:${code}` });
  });
}

export function observeProviderStart(series, options) {
  guard(() => {
    const operation = options?.operation;
    const orderKey = context.getStore()?.orderKey ?? null;
    telemetry.emit({ type: "provider.started", severity: "debug", component: series.split(".")[1], message: `${operation} started`, orderKey });
  });
}

export function observeTelegramUpdate() {
  guard(() => telemetry.observe("telegram.update"));
}

export function observePollingError(options) {
  guard(() => {
    const status = options?.status ?? null;
    telemetry.observe("telegram.polling_error", { outcome: "error" });
    telemetry.emit({ type: "polling.error", severity: status === 409 ? "error" : "warning", component: "polling", message: status === 409 ? "Another process is polling with this token (409)" : `Long poll failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`, coalesceKey: `polling-error:${status}`, coalesceMs: 5 * MINUTE });
  });
}

/** The customer's "your service is ready" message, the last step of an order. */
export function observeDelivery(options) {
  guard(() => {
    const { orderKey = null, ok, ms = null, code = null } = options ?? {};
    telemetry.observe("telegram.delivery", { outcome: ok ? "ok" : "error", ms });
    telemetry.emit(ok
      ? { type: "delivery.succeeded", component: "delivery", message: "Service delivered to the customer", orderKey }
      : { type: "delivery.failed", severity: "warning", component: "delivery", message: `Delivery failed (${sanitizeCode(code ?? "TelegramError", 60)}); it stays in the outbox for retry`, orderKey });
  });
}

export function observeJob(name, options) {
  guard(() => telemetry.recordJob(name, { ok: Boolean(options?.ok), skipped: options?.skipped ?? null }));
}
