/**
 * Everything the panel reads. The snapshot and history come straight from memory, so they work during a MongoDB outage,
 * which is exactly when they matter. Events and incidents read their own collections, bounded, and fall back to memory.
 * Money collections are reached only through Sentinel's read-only wrappers, and nothing here writes.
 */
import mongoose from "mongoose";
import ReliabilityEvent from "../../models/ReliabilityEvent.js";
import ReliabilityIncident from "../../models/ReliabilityIncident.js";
import { getLiveEvents } from "../sentinel/queries.js";
import { defaultSources } from "../sentinel/readOnly.js";
import { createCollector, publicEvent, publicIncident } from "./collector.js";
import { COMPONENTS, WINDOWS, blastRadius, readReliabilityConfig } from "./constants.js";
import { applyFreshness } from "./health.js";
import { nextSteps } from "./incidents.js";
import { historySeries } from "./metrics.js";
import { createStreamHub } from "./stream.js";
import { listOrdersFor, loadBacklog, loadTraceRow, traceOrder } from "./workflow.js";

const QUERY_TIMEOUT_MS = 8_000;
const SEVERITY_ORDER = ["critical", "error", "warning", "info", "debug"];

let collector = null;
let hub = null;
let unsubscribe = null;

export function getCollector() {
  collector ||= createCollector({ publish: (snapshot) => getHub().publish("snapshot", snapshot) });
  return collector;
}

async function revalidateSession(client) {
  const { getAdminSession } = await import("../admin/auth.js");
  return Boolean(await getAdminSession(client.token));
}

export function getHub() {
  hub ||= createStreamHub({ revalidate: revalidateSession });
  return hub;
}

/** Test seam: replaces the singletons, so a suite can run several collectors without touching module state. */
export function setReliabilityRuntimeForTests({ collector: nextCollector = null, hub: nextHub = null } = {}) {
  collector = nextCollector;
  hub = nextHub;
}

export function startReliabilityCron() {
  const running = getCollector();
  if (!running.start()) return false;
  const stream = getHub();
  unsubscribe ||= running.telemetry.subscribe((event) => {
    if (event.severity !== "debug") stream.queueEvent(publicEvent(event), cursorOf(running, event));
  });
  return true;
}

export async function stopReliabilityCron() {
  unsubscribe?.();
  unsubscribe = null;
  // Before http.Server.close(): an open stream would keep that waiting until the deploy is killed.
  hub?.closeAll();
  await collector?.stop();
}

const cursorOf = (running, event) => `${running.telemetry.instance}:${event.seq}`;

function emptySnapshot(config) {
  const at = new Date().toISOString();
  return {
    generatedAt: at,
    monitoring: { enabled: config.enabled, instance: null, startedAt: null, intervalSeconds: Math.round(config.intervalMs / 1000), probeSeconds: Math.round(config.probeIntervalMs / 1000), lastTickAt: null, tickMs: null, persistence: { state: "waiting", failures: 0, lastSuccessAt: null, lastError: null }, droppedEvents: 0, fresh: false, ageMs: null },
    overall: { state: "unknown", reason: "The monitor has not finished a check yet.", affected: [], unverified: COMPONENTS.map((item) => item.id) },
    components: COMPONENTS.map(({ id, label, group, critical, role, dependsOn }) => ({ id, label, group, critical, role, dependsOn, state: "unknown", reason: "No check has finished yet.", evidence: "none", checkedAt: null, lastSuccessAt: null, latencyMs: null, details: [], incidents: 0 })),
    edges: [],
    metrics: null,
    incidents: { open: [], openCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } },
    orders: { available: false, counts: null, unresolved: null, overdueCount: null, oldest: null, overdue: [], truncated: false },
    jobs: [],
    eventLoop: null,
    recentEvents: [],
  };
}

export function readSnapshot({ config = readReliabilityConfig(), now = Date.now(), current = getCollector().snapshot() } = {}) {
  return applyFreshness(current ?? emptySnapshot(config), { now, config });
}

export function openStream({ req, res, actorId, token, lastEventId = null }) {
  const running = getCollector();
  const [instance, seq] = typeof lastEventId === "string" ? lastEventId.split(":") : [];
  const missed = instance === running.telemetry.instance && /^\d{1,12}$/.test(seq ?? "")
    ? running.telemetry.eventsAfter(Number(seq)).filter((event) => event.severity !== "debug").slice(-100)
    : [];
  const initial = [{ event: "snapshot", data: readSnapshot() }];
  if (missed.length) initial.push({ event: "events", id: cursorOf(running, missed[missed.length - 1]), data: missed.map(publicEvent) });
  return getHub().attach({ req, res, actorId, token, initial });
}

export function readHistory({ range, now = Date.now(), minutes = getCollector().telemetry.minutes() }) {
  const running = getCollector();
  return {
    range,
    generatedAt: new Date(now).toISOString(),
    bucketMs: WINDOWS[range].bucketMs,
    points: historySeries(minutes, range, { now }),
    components: COMPONENTS.map(({ id, label }) => ({ id, label })),
    metrics: running.snapshot()?.metrics?.[range] ?? null,
  };
}

const databaseReady = () => mongoose.connection?.readyState === 1;

const STAGE_WARNING = new Set(["failed", "reversed", "refund_requested", "awaiting_provider"]);

/** A stored stage of a payment or order, as an event. These come from the money records, through Sentinel's own feed. */
function recordEvent(item) {
  const order = item.kind === "order";
  const provider = item.provider;
  const component = order ? "orders" : provider === "trx" ? "jobs" : provider === "bank" ? "express" : provider;
  return {
    id: `rec:${item.id}`,
    at: item.at,
    lastAt: null,
    type: `${order ? "order" : "payment"}.${item.stage}`,
    severity: STAGE_WARNING.has(item.stage) ? "warning" : "info",
    component,
    message: `${order ? "Order" : provider}: ${item.stage.replace(/_/g, " ")}`,
    correlationId: item.key,
    orderKey: order ? item.key : null,
    incidentId: null,
    count: 1,
    source: "records",
  };
}

const recordCache = new Map();
async function recordEvents(from, now, sources) {
  const key = String(Math.floor(from.getTime() / 10_000));
  const hit = recordCache.get(key);
  if (hit && now - hit.at < 10_000) return hit.value;
  const feed = await getLiveEvents({ since: from, limit: 100, sources, now: new Date(now) });
  const value = { rows: feed.events.map(recordEvent), truncated: feed.truncated, degraded: feed.degraded };
  if (recordCache.size > 16) recordCache.clear();
  recordCache.set(key, { at: now, value });
  return value;
}

export function matchesEvent(event, { severity, component, type, from, before }) {
  if (severity && SEVERITY_ORDER.indexOf(event.severity) > SEVERITY_ORDER.indexOf(severity)) return false;
  if (component && event.component !== component) return false;
  if (type && event.type !== type && !event.type.startsWith(`${type}.`)) return false;
  const at = new Date(event.at).getTime();
  if (from && at < from.getTime()) return false;
  if (before && at >= before.getTime()) return false;
  return true;
}

export async function listEvents({ range = "1h", severity = null, component = null, type = null, before = null, limit = 50, now = Date.now(), model = ReliabilityEvent, sources = null, running = getCollector() } = {}) {
  const from = new Date(now - WINDOWS[range].ms);
  const degraded = [];
  let stored = [];
  if (databaseReady()) {
    const filter = {
      at: { $gte: from, ...(before ? { $lt: before } : {}) },
      ...(severity ? { severity: { $in: SEVERITY_ORDER.slice(0, SEVERITY_ORDER.indexOf(severity) + 1) } } : { severity: { $ne: "debug" } }),
      ...(component ? { component } : {}),
      ...(type ? { type: type.includes(".") ? type : { $regex: `^${type}\\.` } } : {}),
    };
    try {
      const rows = await model.find(filter).sort({ at: -1 }).limit(limit + 1).lean().maxTimeMS(QUERY_TIMEOUT_MS);
      stored = rows.map((row) => ({ id: row.eventId, at: new Date(row.at).toISOString(), lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null, type: row.type, severity: row.severity, component: row.component, message: row.message, correlationId: row.correlationId, orderKey: row.orderKey, incidentId: row.incidentId, count: row.count }));
    } catch {
      degraded.push("stored events");
    }
  } else {
    degraded.push("stored events");
  }

  let records = [];
  let truncated = false;
  const wantRecords = !type || type === "order" || type === "payment" || type.startsWith("order.") || type.startsWith("payment.");
  if (wantRecords && databaseReady() && !before) {
    try {
      const result = await recordEvents(from, now, sources || defaultSources());
      records = result.rows;
      truncated = result.truncated;
      degraded.push(...result.degraded.map((name) => `records:${name}`));
    } catch {
      degraded.push("order records");
    }
  } else if (wantRecords && !databaseReady()) {
    degraded.push("order records");
  }

  const merged = new Map();
  for (const event of stored) merged.set(event.id, event);
  for (const event of running.telemetry.events()) if (event.severity !== "debug") merged.set(event.id, publicEvent(event));
  for (const event of records) merged.set(event.id, event);
  const filters = { severity, component, type, from, before };
  const rows = [...merged.values()].filter((event) => matchesEvent(event, filters)).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const page = rows.slice(0, limit);
  return { events: page, nextBefore: rows.length > limit ? page[page.length - 1].at : null, range, degraded, truncated, generatedAt: new Date(now).toISOString() };
}

export async function listIncidents({ state = "open", severity = null, component = null, limit = 50, page = 1, model = ReliabilityIncident, running = getCollector() } = {}) {
  const filter = { ...(state === "all" ? {} : { state }), ...(severity ? { severity } : {}), ...(component ? { component } : {}) };
  const local = running.tracker.all().filter((item) => (state === "all" || item.state === state) && (!severity || item.severity === severity) && (!component || item.component === component));
  const degraded = [];
  let rows = [];
  let total = 0;
  if (databaseReady()) {
    try {
      [rows, total] = await Promise.all([
        model.find(filter).sort({ state: 1, rank: 1, lastDetectedAt: -1 }).skip((page - 1) * limit).limit(limit).lean().maxTimeMS(QUERY_TIMEOUT_MS),
        model.countDocuments(filter).maxTimeMS(QUERY_TIMEOUT_MS),
      ]);
    } catch {
      degraded.push("stored incidents");
    }
  } else {
    degraded.push("stored incidents");
  }
  // Memory is newer than the database whenever a write is waiting, and is all there is during an outage.
  const byId = new Map(rows.map((row) => [row.incidentId, row]));
  const extra = local.filter((item) => !byId.has(item.incidentId));
  for (const item of local) if (byId.has(item.incidentId)) byId.set(item.incidentId, item);
  const items = [...byId.values(), ...(page === 1 ? extra : [])].map(publicIncident);
  const count = Math.max(total, 0) + (page === 1 ? extra.length : 0);
  return { items, page, pageSize: limit, total: count, pages: Math.max(1, Math.ceil(count / limit)), degraded };
}

async function incidentEvents(incident, model) {
  if (!databaseReady()) return [];
  const rows = await model.find({
    component: { $in: blastRadius(incident.component) },
    at: { $gte: new Date(new Date(incident.firstDetectedAt).getTime() - 5 * 60_000), ...(incident.resolvedAt ? { $lte: new Date(new Date(incident.resolvedAt).getTime() + 5 * 60_000) } : {}) },
    severity: { $in: ["critical", "error", "warning"] },
  }).sort({ at: -1 }).limit(30).lean().maxTimeMS(QUERY_TIMEOUT_MS).catch(() => []);
  return rows.map((row) => ({ id: row.eventId, at: new Date(row.at).toISOString(), type: row.type, severity: row.severity, component: row.component, message: row.message, correlationId: row.correlationId, orderKey: row.orderKey, incidentId: row.incidentId, count: row.count, lastAt: null }));
}

export async function getIncident({ id, model = ReliabilityIncident, eventModel = ReliabilityEvent, running = getCollector(), sources = null, now = Date.now() }) {
  let incident = running.tracker.find(id);
  if (!incident && databaseReady()) incident = await model.findOne({ incidentId: id }).lean().maxTimeMS(QUERY_TIMEOUT_MS);
  if (!incident) return null;
  let orders = [];
  if (incident.orderKeys?.length && incident.state === "open" && databaseReady()) {
    const wanted = new Set(incident.orderKeys);
    const backlog = await loadBacklog({ sources: sources || defaultSources(), now }).catch(() => null);
    orders = backlog?.rows.filter((row) => wanted.has(row.key)) ?? [];
  }
  return {
    ...publicIncident(incident),
    evidence: incident.evidence ?? [],
    timeline: incident.timeline ?? [],
    orderKeys: incident.orderKeys ?? [],
    orders,
    nextSteps: nextSteps(incident.code),
    events: await incidentEvents(incident, eventModel),
    affectedComponents: blastRadius(incident.component),
  };
}

export async function getOrderBacklog({ userId = null, sources = defaultSources(), now = Date.now() } = {}) {
  if (userId) return { rows: await listOrdersFor({ sources, telegramId: userId, now }), truncated: false, scope: "customer" };
  const backlog = await loadBacklog({ sources, now });
  return { ...backlog, scope: "unresolved" };
}

export async function getOrderTrace({ orderId, sources = defaultSources(), model = ReliabilityEvent, running = getCollector(), now = Date.now() }) {
  const row = await loadTraceRow({ sources, orderId });
  if (!row) return null;
  const orderKey = `wallet:${orderId}`;
  const stored = await model.find({ orderKey }).sort({ at: 1 }).limit(60).lean().maxTimeMS(QUERY_TIMEOUT_MS).catch(() => []);
  const merged = new Map(stored.map((item) => [item.eventId, { id: item.eventId, at: new Date(item.at).toISOString(), lastAt: null, type: item.type, severity: item.severity, component: item.component, message: item.message, correlationId: item.correlationId, orderKey: item.orderKey, incidentId: item.incidentId, count: item.count }]));
  for (const event of running.telemetry.events()) if (event.orderKey === orderKey) merged.set(event.id, publicEvent(event));
  const events = [...merged.values()].sort((a, b) => a.at.localeCompare(b.at));
  return traceOrder(row, { events, now });
}
