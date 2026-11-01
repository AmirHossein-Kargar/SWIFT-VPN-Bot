/**
 * The one scheduler of the Service Reliability Center. It runs inside the bot process and does its work on its own timer, so
 * no dashboard request ever waits on a probe or an aggregate, and a dashboard nobody is watching costs the same as one that is.
 *
 * A tick: check dependencies, read the order records, derive component health, evaluate incidents, write what changed, and
 * publish one snapshot. Each step is contained. The in-memory state survives a MongoDB outage, which is how that outage gets
 * recorded at all: reads and writes wait, and the record is written when the database returns.
 *
 * MongoDB writes happen under a `JobCheckpoint` lease, so two processes overlapping during a deploy do not both write.
 * Probes do not need the lease: they change nothing.
 */
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import mongoose from "mongoose";
import JobCheckpoint from "../../models/JobCheckpoint.js";
import { default as botInstance } from "../../config/botInstance.js";
import { HEALTH_CHECKERS, checkDeliveryPath, getPollingEvidence } from "../admin/monitoring.js";
import { acquireLease, releaseLease, writeLeasedState } from "../jobLease.js";
import { getSyncStatus } from "../sentinel/queries.js";
import { defaultSources } from "../sentinel/readOnly.js";
import { EDGES, RARE_PROBE_MS, RELIABILITY_JOB, SEVERITY_RANK, WINDOWS, blastRadius, readReliabilityConfig } from "./constants.js";
import { deriveComponents, deriveOverall, jobStates } from "./health.js";
import { INCIDENT_DEFAULTS, createIncidentTracker } from "./incidents.js";
import { edgeTraffic, eventLoopSummary, windowMetrics } from "./metrics.js";
import { evaluateRules } from "./rules.js";
import { sanitizeText } from "./sanitize.js";
import { flushEvents, flushRollups, loadIncidentsForResume, loadRollups, writeIncidents } from "./store.js";
import { telemetry as defaultTelemetry } from "./telemetry.js";
import { loadBacklog, loadCohorts } from "./workflow.js";

const LEASE_TTL_MS = 90_000;
const FAST_PROBES = ["mongodb", "redis", "express"];
const SLOW_PROBES = ["telegram", "wizardxray", "hooshpay", "nowpayments", "orders"];
/** These run a real path through the application, so once a minute would be noise. */
const RARE_PROBES = ["webhook", "delivery"];
const RECENT_EVENTS = 40;
const WORKFLOW_ROWS = 12;
/** monitoring.js words these for the Persian bot panel; the dashboard is English. */
const PROBE_ERRORS = { "مهلت درخواست پایان یافت": "The request timed out", "آدرس سرور قابل تشخیص نیست": "The server address could not be resolved", "اتصال رد شد": "The connection was refused" };

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "service-reliability", level, message, ...meta }),
  );
}

function checkExpress(port = process.env.PORT || 3000) {
  return async () => {
    const started = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const latencyMs = Date.now() - started;
      return { status: latencyMs > 1_000 ? "degraded" : "healthy", latencyMs, error: latencyMs > 1_000 ? `/livez took ${latencyMs} ms` : null };
    } catch (error) {
      return { status: "down", latencyMs: null, error: error?.name === "TimeoutError" ? "/livez did not answer in 3 s" : "/livez could not be reached" };
    }
  };
}

export function defaultProbes() {
  return { ...HEALTH_CHECKERS, delivery: checkDeliveryPath, express: checkExpress() };
}

export const publicEvent = ({ dirty: _dirty, seq: _seq, ...event }) => event;

export function publicIncident(incident) {
  return {
    id: incident.incidentId,
    code: incident.code,
    component: incident.component,
    severity: incident.severity,
    state: incident.state,
    title: incident.title,
    summary: incident.summary,
    firstDetectedAt: incident.firstDetectedAt,
    lastDetectedAt: incident.lastDetectedAt,
    resolvedAt: incident.resolvedAt ?? null,
    escalatedAt: incident.escalatedAt ?? null,
    detections: incident.detections,
    reopenCount: incident.reopenCount,
    affectedOrders: incident.affectedOrders ?? null,
    path: blastRadius(incident.component),
  };
}

export function createCollector(options = {}) {
  const env = options.env || process.env;
  const config = options.config || readReliabilityConfig(env);
  const probes = options.probes || defaultProbes();
  const tel = options.telemetry || defaultTelemetry;
  const tracker = options.tracker || createIncidentTracker();
  const clock = options.now || Date.now;
  const sources = options.sources || null;
  const readPolling = options.polling || (() => (botInstance.bot ? getPollingEvidence() : null));
  const readSentinel = options.sentinel || (() => getSyncStatus());
  const databaseReady = options.databaseReady || (() => mongoose.connection?.readyState === 1);
  const checkpointModel = options.checkpointModel || JobCheckpoint;
  const stores = { flushEvents, flushRollups, writeIncidents, loadRollups, loadIncidentsForResume, ...options.stores };
  const publish = options.publish || (() => {});
  const owner = `${process.pid}:${randomUUID()}`;

  const probeResults = {};
  const persistence = { state: "waiting", failures: 0, lastSuccessAt: null, lastError: null, skipped: 0 };
  let workflow = null;
  let sentinel = null;
  let snapshot = null;
  let previousStates = {};
  let lastSlowAt = 0;
  let lastRareAt = 0;
  let lastTickAt = null;
  let tickMs = null;
  let hydrated = false;
  let active = false;
  let timer = null;
  let initialTimer = null;
  let eventLoop = options.eventLoop === undefined ? null : options.eventLoop;
  let loopMonitor = null;
  let ownedSources = sources;

  async function runProbe(name) {
    const check = probes[name];
    if (typeof check !== "function") return;
    const previous = probeResults[name];
    let outcome;
    try {
      outcome = await check();
    } catch (error) {
      outcome = { status: "down", latencyMs: null, error: sanitizeText(error?.name || "Error", 80) };
    }
    const at = clock();
    const succeeded = outcome.status === "healthy" || outcome.status === "degraded";
    probeResults[name] = {
      status: outcome.status,
      latencyMs: outcome.latencyMs ?? null,
      error: outcome.error ? sanitizeText(PROBE_ERRORS[outcome.error] ?? outcome.error, 160) : null,
      details: outcome.details ?? null,
      at,
      lastSuccessAt: succeeded ? at : previous?.lastSuccessAt ?? null,
      lastFailureAt: succeeded ? previous?.lastFailureAt ?? null : at,
      failures: succeeded ? 0 : (previous?.failures ?? 0) + 1,
    };
  }

  async function refreshRecords(now) {
    if (!databaseReady()) { workflow = null; return; }
    try {
      ownedSources ||= defaultSources();
      const [backlog, cohorts] = await Promise.all([loadBacklog({ sources: ownedSources, now }), loadCohorts({ sources: ownedSources, now })]);
      workflow = { backlog: backlog.rows, backlogTruncated: backlog.truncated, cohorts, at: now };
    } catch (error) {
      workflow = null;
      log("warn", "Order records could not be read for monitoring", { errorType: error?.name || "Error" });
    }
    sentinel = await Promise.resolve().then(readSentinel).catch(() => null);
  }

  function announceChanges(components, now) {
    for (const component of components) {
      const before = previousStates[component.id];
      if (before && before !== component.state) {
        const worse = ["failed", "degraded"].includes(component.state);
        tel.emit({ type: "dependency.changed", severity: component.state === "failed" ? "error" : worse ? "warning" : "info", component: component.id, message: `${component.label}: ${before} to ${component.state}. ${component.reason}`, at: now });
      }
    }
    previousStates = Object.fromEntries(components.map((item) => [item.id, item.state]));
  }

  function announceTransitions(transitions, now) {
    const WORDING = { opened: "Incident opened", reopened: "Incident reopened", escalated: "Incident escalated", resolved: "Incident resolved" };
    for (const { kind, incident } of transitions) {
      tel.emit({ type: `incident.${kind}`, severity: kind === "resolved" ? "info" : incident.severity === "critical" ? "critical" : incident.severity === "high" ? "error" : "warning", component: incident.component, message: `${WORDING[kind]}: ${incident.title}`, incidentId: incident.incidentId, at: now });
    }
  }

  async function persist(now) {
    if (!databaseReady()) {
      persistence.state = "waiting";
      persistence.failures += 1;
      persistence.lastError = "MongoDB is not connected";
      return;
    }
    let lease = null;
    try {
      lease = await acquireLease(checkpointModel, RELIABILITY_JOB, owner, LEASE_TTL_MS);
      if (!lease) { persistence.skipped += 1; persistence.state = "standby"; return; }
      const incidents = await stores.writeIncidents(tracker.dirty(), tracker);
      tracker.markWritten(incidents, now);
      tel.markEventsFlushed(await stores.flushEvents(tel.dirtyEvents()));
      const minutes = await stores.flushRollups(tel.unflushedMinutes(now), tel.instance);
      if (minutes) tel.markMinutesFlushed(minutes);
      await writeLeasedState(checkpointModel, lease, { set: { lastTickAt: new Date(now), lastSuccessAt: new Date(now), failures: 0 } });
      persistence.state = "saving";
      persistence.failures = 0;
      persistence.lastSuccessAt = now;
      persistence.lastError = null;
    } catch (error) {
      persistence.state = "failing";
      persistence.failures += 1;
      persistence.lastError = sanitizeText(error?.name || "Error", 80);
      log("warn", "Telemetry could not be saved; it stays in memory", { errorType: error?.name || "Error", code: typeof error?.code === "string" ? error.code : undefined });
    } finally {
      if (lease) await releaseLease(checkpointModel, lease).catch(() => {});
    }
  }

  async function hydrate(now) {
    if (hydrated || !databaseReady()) return;
    try {
      const [rollups, incidents] = await Promise.all([stores.loadRollups(now), stores.loadIncidentsForResume({ now, reopenMs: INCIDENT_DEFAULTS.reopenMs })]);
      tel.hydrate(rollups);
      tracker.hydrate(incidents.open, incidents.resolved);
      hydrated = true;
    } catch (error) {
      log("warn", "Earlier telemetry could not be restored; retrying next tick", { errorType: error?.name || "Error" });
    }
  }

  function buildSnapshot({ now, components, overall, jobs, loop }) {
    const minutes = tel.minutes();
    const metrics = {};
    for (const name of Object.keys(WINDOWS)) {
      metrics[name] = { ...windowMetrics(minutes, name, { now, startedAt: tel.startedAt }), orders: workflow?.cohorts?.[name] ?? null };
    }
    const cohort = workflow?.cohorts?.["15m"];
    const records = cohort ? { ordersCreated: cohort.created, ordersDelivered: cohort.delivered } : {};
    const open = tracker.open().map(publicIncident).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || new Date(a.firstDetectedAt) - new Date(b.firstDetectedAt));
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const incident of open) bySeverity[incident.severity] += 1;
    const incidentsByComponent = {};
    for (const incident of open) incidentsByComponent[incident.component] = (incidentsByComponent[incident.component] ?? 0) + 1;
    const backlog = workflow?.backlog ?? null;
    const overdue = backlog?.filter((row) => row.overdue) ?? null;
    return {
      generatedAt: new Date(now).toISOString(),
      monitoring: {
        enabled: config.enabled,
        instance: tel.instance,
        startedAt: new Date(tel.startedAt).toISOString(),
        intervalSeconds: Math.round(config.intervalMs / 1000),
        probeSeconds: Math.round(config.probeIntervalMs / 1000),
        lastTickAt: new Date(now).toISOString(),
        tickMs,
        persistence: { state: persistence.state, failures: persistence.failures, lastSuccessAt: persistence.lastSuccessAt ? new Date(persistence.lastSuccessAt).toISOString() : null, lastError: persistence.lastError },
        droppedEvents: tel.droppedEvents(),
      },
      overall,
      components: components.map((component) => ({ ...component, incidents: incidentsByComponent[component.id] ?? 0 })),
      edges: EDGES.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, label: edge.label, unit: edge.unit ?? null, tone: edge.tone ?? "normal", ...edgeTraffic(minutes, edge, { now, records }) })),
      metrics,
      incidents: { open: open.slice(0, 20), openCount: open.length, bySeverity },
      orders: {
        available: backlog != null,
        counts: probeResults.orders?.status && probeResults.orders.status !== "down" ? probeResults.orders.details : null,
        unresolved: backlog?.length ?? null,
        overdueCount: overdue?.length ?? null,
        oldest: backlog?.[0] ?? null,
        overdue: overdue?.slice(0, WORKFLOW_ROWS) ?? [],
        truncated: workflow?.backlogTruncated ?? false,
      },
      jobs,
      eventLoop: loop,
      recentEvents: tel.events().filter((event) => event.severity !== "debug").slice(-RECENT_EVENTS).reverse().map(publicEvent),
    };
  }

  async function tick() {
    if (active) return { skipped: "already_running" };
    active = true;
    const started = clock();
    try {
      await hydrate(started);
      const slowDue = started - lastSlowAt >= config.probeIntervalMs - 1_000;
      const rareDue = started - lastRareAt >= RARE_PROBE_MS - 1_000;
      await Promise.all([...FAST_PROBES, ...(slowDue ? SLOW_PROBES : [])].map(runProbe));
      if (slowDue) {
        lastSlowAt = started;
        await refreshRecords(started);
      }
      // After the others, so a test callback never competes with the check that would explain why it failed.
      if (rareDue) {
        lastRareAt = started;
        await Promise.all(RARE_PROBES.map(runProbe));
      }
      const now = clock();
      const loop = loopMonitor ? eventLoopSummary(loopMonitor) : eventLoop;
      loopMonitor?.reset();
      const minutes = tel.minutes();
      const providers = [
        { id: "hooshpay", label: "HooshPay", configured: Boolean(env.HOOSHPAY_API_KEY?.trim()), secretConfigured: Boolean(env.HOOSHPAY_WEBHOOK_SECRET), lastRequestOkAt: tel.lastOkAt("provider.hooshpay"), lastWebhookOkAt: tel.lastOkAt("webhook.hooshpay") },
        { id: "nowpayments", label: "NOWPayments", configured: Boolean(env.NOWPAYMENTS_API_KEY?.trim()), secretConfigured: Boolean(env.NOWPAYMENTS_IPN_SECRET?.trim()), lastRequestOkAt: tel.lastOkAt("provider.nowpayments"), lastWebhookOkAt: tel.lastOkAt("webhook.nowpayments") },
      ];
      const polling = readPolling();
      const jobs = jobStates(tel.jobs(), { now, startedAt: tel.startedAt, env });
      const components = deriveComponents({ now, config, probes: probeResults, minutes, polling, jobs, eventLoop: loop, providers, lastDeliveryOkAt: tel.lastOkAt("telegram.delivery") });
      const overall = deriveOverall(components);
      announceChanges(components, now);
      tel.stampHealth(Object.fromEntries(components.map((item) => [item.id, item.state])), now);
      const { conditions, unevaluated } = evaluateRules({ now, minutes, components, probes: probeResults, polling, providers, jobs, workflow, sentinel, persistence });
      const transitions = tracker.apply({ conditions, unevaluated, now });
      announceTransitions(transitions, now);
      await persist(now);
      tickMs = clock() - started;
      lastTickAt = now;
      snapshot = buildSnapshot({ now, components, overall, jobs, loop });
      publish(snapshot);
      return { ok: true, incidents: tracker.open().length, transitions: transitions.length };
    } catch (error) {
      // lastTickAt does not move, so the panel goes stale by itself instead of showing an old "healthy".
      log("error", "Reliability tick failed", { errorType: error?.name || "Error" });
      return { ok: false };
    } finally {
      active = false;
    }
  }

  return {
    config,
    tick,
    start() {
      if (!config.enabled || timer) return false;
      try {
        loopMonitor = monitorEventLoopDelay({ resolution: 20 });
        loopMonitor.enable();
      } catch { loopMonitor = null; }
      const run = () => { tick().catch(() => {}); };
      timer = setInterval(run, config.intervalMs);
      timer.unref?.();
      initialTimer = setTimeout(run, options.initialDelayMs ?? 5_000);
      initialTimer.unref?.();
      return true;
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (initialTimer) clearTimeout(initialTimer);
      timer = null;
      initialTimer = null;
      loopMonitor?.disable();
      loopMonitor = null;
      // One last write so a redeploy does not lose the current minute's incidents. Bounded: a shutdown must not wait on it.
      if (lastTickAt != null && databaseReady()) {
        await Promise.race([persist(clock()), new Promise((resolve) => { const wait = setTimeout(resolve, 2_000); wait.unref?.(); })]).catch(() => {});
      }
    },
    snapshot: () => snapshot,
    tracker,
    telemetry: tel,
  };
}
