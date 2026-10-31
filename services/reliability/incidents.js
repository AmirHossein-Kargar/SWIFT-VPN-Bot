/**
 * The incident lifecycle: open, update, escalate, resolve, reopen. In memory, write-through to MongoDB by the collector.
 *
 * Why memory leads: when MongoDB is the thing that failed, the record of that failure cannot wait for MongoDB. Ids are made
 * here, so a row written after the outage is the same row, with the true first-detected time.
 *
 * Deduplication: one open incident per fingerprint. Recovery needs `clearTicks` clean evaluations in a row, so a flapping
 * dependency stays one incident. A problem that returns within `reopenMs` reopens its incident instead of starting another.
 */
import { randomUUID } from "node:crypto";

const MAX_TIMELINE = 30;
const MAX_RECENT = 128;
const WRITE_EVERY_MS = 5 * 60_000;
export const INCIDENT_DEFAULTS = Object.freeze({ clearTicks: 3, reopenMs: 15 * 60_000 });

const note = (incident, at, kind, text) => {
  incident.timeline.push({ at: new Date(at), kind, note: text.slice(0, 200) });
  if (incident.timeline.length > MAX_TIMELINE) incident.timeline.splice(0, incident.timeline.length - MAX_TIMELINE);
};

const material = (incident, condition) => incident.severity !== condition.severity || incident.affectedOrders !== condition.affectedOrders || incident.summary !== condition.summary;

export function createIncidentTracker({ clearTicks = INCIDENT_DEFAULTS.clearTicks, reopenMs = INCIDENT_DEFAULTS.reopenMs, newId = randomUUID } = {}) {
  const open = new Map();
  const recent = new Map();

  function rememberResolved(incident) {
    recent.set(incident.fingerprint, incident);
    if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value);
  }

  function fresh(condition, at) {
    return {
      incidentId: newId(),
      fingerprint: condition.fingerprint,
      code: condition.code,
      group: condition.group,
      component: condition.component,
      severity: condition.severity,
      rank: condition.rank,
      state: "open",
      title: condition.title,
      summary: condition.summary,
      firstDetectedAt: new Date(at),
      lastDetectedAt: new Date(at),
      resolvedAt: null,
      escalatedAt: null,
      detections: 1,
      reopenCount: 0,
      evidence: condition.evidence,
      affectedOrders: condition.affectedOrders,
      orderKeys: condition.orderKeys,
      timeline: [],
      absentTicks: 0,
      dirty: true,
      writtenAt: 0,
    };
  }

  /**
   * @returns {{kind: "opened"|"reopened"|"escalated"|"resolved", incident: object}[]} what changed in this evaluation
   */
  function apply({ conditions, unevaluated = [], now }) {
    const at = now;
    const transitions = [];
    const held = new Set(unevaluated);
    const seen = new Set();
    for (const condition of conditions) {
      seen.add(condition.fingerprint);
      const current = open.get(condition.fingerprint);
      if (current) {
        const worse = condition.rank < current.rank;
        const changed = material(current, condition);
        current.absentTicks = 0;
        current.lastDetectedAt = new Date(at);
        current.detections += 1;
        current.evidence = condition.evidence;
        current.summary = condition.summary;
        current.title = condition.title;
        current.affectedOrders = condition.affectedOrders;
        current.orderKeys = condition.orderKeys;
        if (worse) {
          note(current, at, "escalated", `Severity rose from ${current.severity} to ${condition.severity}.`);
          current.severity = condition.severity;
          current.rank = condition.rank;
          current.escalatedAt = new Date(at);
          transitions.push({ kind: "escalated", incident: current });
        }
        if (worse || changed || at - current.writtenAt >= WRITE_EVERY_MS) current.dirty = true;
        continue;
      }
      const previous = recent.get(condition.fingerprint);
      if (previous && previous.resolvedAt && at - previous.resolvedAt.getTime() <= reopenMs) {
        recent.delete(condition.fingerprint);
        previous.state = "open";
        previous.resolvedAt = null;
        previous.lastDetectedAt = new Date(at);
        previous.detections += 1;
        previous.reopenCount += 1;
        previous.absentTicks = 0;
        previous.severity = condition.severity;
        previous.rank = condition.rank;
        previous.summary = condition.summary;
        previous.evidence = condition.evidence;
        previous.affectedOrders = condition.affectedOrders;
        previous.orderKeys = condition.orderKeys;
        previous.dirty = true;
        note(previous, at, "reopened", "The problem returned soon after it cleared.");
        open.set(condition.fingerprint, previous);
        transitions.push({ kind: "reopened", incident: previous });
        continue;
      }
      const incident = fresh(condition, at);
      note(incident, at, "opened", condition.summary || condition.title);
      open.set(condition.fingerprint, incident);
      transitions.push({ kind: "opened", incident });
    }

    for (const incident of [...open.values()]) {
      if (seen.has(incident.fingerprint)) continue;
      // Not evaluated is not recovered. The incident stays exactly as it was until a real answer exists.
      if (held.has(incident.group)) continue;
      incident.absentTicks += 1;
      if (incident.absentTicks < clearTicks) continue;
      incident.state = "resolved";
      incident.resolvedAt = new Date(at);
      incident.dirty = true;
      note(incident, at, "resolved", "The condition cleared and stayed clear.");
      open.delete(incident.fingerprint);
      rememberResolved(incident);
      transitions.push({ kind: "resolved", incident });
    }
    return transitions;
  }

  return {
    apply,
    open: () => [...open.values()],
    all: () => [...open.values(), ...recent.values()],
    find: (incidentId) => [...open.values(), ...recent.values()].find((item) => item.incidentId === incidentId) ?? null,
    dirty: () => [...open.values(), ...recent.values()].filter((item) => item.dirty),
    markWritten(incidents, at) {
      for (const incident of incidents) { incident.dirty = false; incident.writtenAt = at; }
    },
    /** After a restart: continue the same incidents instead of opening new ones. */
    hydrate(rows, resolvedRows = []) {
      for (const row of rows) if (!open.has(row.fingerprint)) open.set(row.fingerprint, { ...row, absentTicks: 0, dirty: false, writtenAt: 0 });
      for (const row of resolvedRows) if (!open.has(row.fingerprint) && !recent.has(row.fingerprint)) rememberResolved({ ...row, absentTicks: 0, dirty: false, writtenAt: 0 });
    },
    /** Another process won the race for this fingerprint: keep its id, so both describe one row. */
    adopt(incident, incidentId) {
      incident.incidentId = incidentId;
    },
    reset() { open.clear(); recent.clear(); },
  };
}

/** Evidence-based and non-destructive. Each step reads or links to an existing audited tool; none acts from here. */
const NEXT_STEPS = {
  DEPENDENCY_DOWN: [
    { text: "Open System health to see the same check with its last error.", href: "/system-health" },
    { text: "Read the Railway logs for connection errors around the first-detected time." },
    { text: "Look at the provider's status page before changing anything here." },
  ],
  DEPENDENCY_DEGRADED: [
    { text: "Compare latency on the History tab to see when it started.", href: "/reliability/history" },
    { text: "Check whether a job or a broadcast was running at that moment.", href: "/reliability/events" },
  ],
  POLLING_CONFLICT: [
    { text: "Confirm the Railway service runs exactly one replica; a second instance or a local bot with the same token causes this." },
    { text: "During a deploy this clears when the old instance stops. If it lasts, look for the other process." },
  ],
  POLLING_FAILING: [{ text: "Check the Telegram component on the topology. If getMe also fails, the problem is Telegram or the network, not this bot." }, { text: "Read the logs for polling_error status codes." }],
  POLLING_STALLED: [{ text: "Read the logs around the last completed poll." }, { text: "Check the Express event-loop figure: a blocked process stops polling too.", href: "/reliability" }],
  WEBHOOK_SECRET_MISSING: [{ text: "Compare the environment with docs/configuration.md, then set the secret on the Railway service." }, { text: "After the fix, payments stuck during the gap appear on the Recovery page.", href: "/recovery" }],
  WEBHOOK_FAILURES: [{ text: "Search the logs for the request ids on the Events tab.", href: "/reliability/events?component=webhook" }, { text: "Check MongoDB and Redis: the handler needs both.", href: "/reliability" }, { text: "The gateway retries by itself. Confirm in Payments that credits catch up.", href: "/payments" }],
  WEBHOOK_REJECTED_BURST: [{ text: "Nothing was credited. Check whether the signature errors started after a secret rotation." }, { text: "If not, treat it as probing and review the rejected events.", href: "/reliability/events?type=webhook.rejected" }],
  PROVIDER_TIMEOUTS: [{ text: "Open the provider component to compare the check with real request latency.", href: "/reliability" }, { text: "Review orders held for review. A timed-out create may have made a service, so confirm on the panel before deciding.", href: "/recovery" }],
  PROVIDER_ERRORS: [{ text: "Read the error codes on the Events tab.", href: "/reliability/events" }, { text: "Check the provider's status page and the API key's validity." }],
  ORDERS_NEED_REVIEW: [{ text: "Open each order's trace below, then confirm on the WizardXray panel whether the service exists." }, { text: "Decide in Recovery. Never replay a create by hand.", href: "/recovery" }],
  ORDERS_STUCK_PROVISIONING: [{ text: "Open the traces below to see how long each has waited." }, { text: "The recovery job moves these to review. Check it is running.", href: "/reliability" }],
  ORDERS_INTERRUPTED: [{ text: "Check the recovery job on the topology: it repairs these by itself.", href: "/reliability" }, { text: "If it is running and they remain, see Recovery.", href: "/recovery" }],
  REFUNDS_PENDING: [{ text: "Check MongoDB health: a refund is a database step.", href: "/reliability" }, { text: "Follow them in Recovery.", href: "/recovery" }],
  ORDERS_AWAITING_PROVIDER: [{ text: "Check the WizardXray wallet balance, then approve the orders from the admin group alert." }, { text: "Review the waiting orders.", href: "/recovery" }],
  DELIVERY_PENDING: [{ text: "Check the Telegram component. If it is healthy, the customer may have blocked the bot." }, { text: "These stay visible in Recovery after the retry limit.", href: "/recovery" }],
  ADMIN_ALERTS_PENDING: [{ text: "Confirm the bot is still an admin in the group set by GROUP_ID." }],
  JOB_FAILING: [{ text: "Read the logs for this job around its last failure." }, { text: "Check the dependencies it needs on the topology.", href: "/reliability" }],
  JOB_OVERDUE: [{ text: "The job may be waiting for a lease held elsewhere. Check Redis and MongoDB.", href: "/reliability" }, { text: "If the process restarted, a run may simply be due; wait one interval." }],
  SENTINEL_BEHIND: [{ text: "Open Money Flow Sentinel to see its own status bar and last error.", href: "/sentinel" }],
  TELEMETRY_NOT_PERSISTED: [{ text: "Check MongoDB. Live values keep working; only history is at risk.", href: "/reliability" }],
  HTTP_ERRORS: [{ text: "Read the logs for `Admin API request failed` and similar lines." }, { text: "Compare with MongoDB and Redis health on the topology.", href: "/reliability" }],
};

export function nextSteps(code) {
  return NEXT_STEPS[code] ?? [{ text: "Compare the evidence above with the Events tab around the first-detected time.", href: "/reliability/events" }];
}
