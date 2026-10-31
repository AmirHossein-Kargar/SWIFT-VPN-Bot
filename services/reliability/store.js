/**
 * The only writer in the Service Reliability Center. It knows three collections of its own and nothing else: no money model
 * is imported here, and tests/unit/reliabilityReadOnly.test.js keeps it that way.
 *
 * Writes are upserts on an id made in memory, so a retry after a lost response, or a flush that repeats, lands on the same row.
 */
import ReliabilityEvent from "../../models/ReliabilityEvent.js";
import ReliabilityIncident from "../../models/ReliabilityIncident.js";
import ReliabilityRollup from "../../models/ReliabilityRollup.js";

const QUERY_TIMEOUT_MS = 8_000;
const BATCH = 200;
const DAY = 24 * 60 * 60_000;

export async function flushRollups(minutes, instance, model = ReliabilityRollup) {
  if (!minutes.length) return 0;
  const rows = minutes.slice(0, BATCH);
  await model.bulkWrite(rows.map((minute) => ({
    updateOne: {
      filter: { key: `${minute.t}:${instance}` },
      update: { $set: { minute: new Date(minute.t), series: minute.series, health: minute.health } },
      upsert: true,
    },
  })), { ordered: false });
  return rows;
}

export async function flushEvents(events, model = ReliabilityEvent) {
  if (!events.length) return [];
  const rows = events.slice(0, BATCH);
  await model.bulkWrite(rows.map((event) => ({
    updateOne: {
      filter: { eventId: event.id },
      update: {
        $set: { count: event.count, lastAt: event.lastAt ? new Date(event.lastAt) : null },
        $setOnInsert: { at: new Date(event.at), type: event.type, severity: event.severity, component: event.component, message: event.message, correlationId: event.correlationId, orderKey: event.orderKey, incidentId: event.incidentId },
      },
      upsert: true,
    },
  })), { ordered: false });
  return rows;
}

function storedIncident(incident) {
  const { absentTicks: _absent, dirty: _dirty, writtenAt: _written, _id, ...fields } = incident;
  return fields;
}

/** A partial unique index allows one open row per fingerprint, so a second process loses here and adopts the winner's id. */
export async function writeIncidents(incidents, tracker, model = ReliabilityIncident) {
  const written = [];
  for (const incident of incidents) {
    const write = () => model.updateOne({ incidentId: incident.incidentId }, { $set: storedIncident(incident) }, { upsert: true });
    try {
      await write();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const winner = await model.findOne({ fingerprint: incident.fingerprint, state: "open" }).select("incidentId").lean().maxTimeMS(QUERY_TIMEOUT_MS);
      if (!winner) throw error;
      tracker.adopt(incident, winner.incidentId);
      await write();
    }
    written.push(incident);
  }
  return written;
}

/** At most one day of closed minutes, restored once at startup so a deploy does not empty the 24-hour view. */
export async function loadRollups(now, model = ReliabilityRollup) {
  const rows = await model.find({ minute: { $gte: new Date(now - DAY) } }).select("minute series health").sort({ minute: 1 }).limit(4_000).lean().maxTimeMS(QUERY_TIMEOUT_MS);
  const merged = new Map();
  for (const row of rows) {
    const t = new Date(row.minute).getTime();
    const current = merged.get(t);
    if (!current) { merged.set(t, { t, series: { ...(row.series || {}) }, health: row.health || {} }); continue; }
    // Two processes overlapped in this minute during a deploy. Add their counters.
    for (const [key, series] of Object.entries(row.series || {})) {
      const existing = current.series[key];
      if (!existing) { current.series[key] = series; continue; }
      current.series[key] = { n: existing.n + series.n, ok: existing.ok + series.ok, err: existing.err + series.err, rej: existing.rej + series.rej, tmo: existing.tmo + series.tmo, sumMs: existing.sumMs + series.sumMs, timed: existing.timed + series.timed, h: existing.h.map((value, index) => value + (series.h?.[index] ?? 0)) };
    }
  }
  return [...merged.values()];
}

export async function loadIncidentsForResume({ now, reopenMs, model = ReliabilityIncident }) {
  const [open, resolved] = await Promise.all([
    model.find({ state: "open" }).sort({ rank: 1 }).limit(200).lean().maxTimeMS(QUERY_TIMEOUT_MS),
    model.find({ state: "resolved", resolvedAt: { $gte: new Date(now - reopenMs) } }).limit(100).lean().maxTimeMS(QUERY_TIMEOUT_MS),
  ]);
  return { open, resolved };
}
