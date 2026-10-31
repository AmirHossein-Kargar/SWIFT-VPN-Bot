/**
 * Component and overall health. Pure: given what was measured, it says what can honestly be claimed.
 *
 * The one rule behind every branch: **healthy needs positive evidence**. No errors is not evidence. A provider with no
 * traffic is `unknown`, a check that has gone quiet is `stale`, and a dependency we cannot read through is `unknown`. Any of
 * those can be the truth during an outage, so none of them may ever read as healthy.
 */
import { COMPONENTS, EVIDENCE_WINDOW_MS, JOBS, STATE_RANK, WINDOWS } from "./constants.js";
import { sumSeries } from "./metrics.js";

const SECOND = 1_000;
const MINUTE = 60_000;
const FAILURE_RATE = 0.5;
const MIN_FAILURES = 3;

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const withinMinutes = (minutes, now, ms) => minutes.filter((minute) => minute.t >= now - ms);

function result(state, reason, extra = {}) {
  return { state, reason, evidence: extra.evidence ?? "none", checkedAt: extra.checkedAt ?? null, lastSuccessAt: extra.lastSuccessAt ?? null, latencyMs: extra.latencyMs ?? null, details: extra.details ?? [] };
}

/** A probe is only as good as its age: after three missed intervals it stops saying anything about now. */
export function probeState(probe, intervalMs, now) {
  if (!probe) return { state: "unknown", reason: "No check has finished yet." };
  if (now - probe.at > intervalMs * 3) return { state: "stale", reason: `Last check was ${Math.round((now - probe.at) / SECOND)} seconds ago.` };
  if (probe.status === "down") return { state: "failed", reason: probe.error || "The last check failed." };
  if (probe.status === "degraded") return { state: "degraded", reason: probe.error || "The last check was slow." };
  if (probe.status === "healthy") return { state: "healthy", reason: "The last check succeeded." };
  return { state: "unknown", reason: "The last check gave no answer." };
}

const probeExtra = (probe) => ({ evidence: "probe", checkedAt: iso(probe?.at), lastSuccessAt: iso(probe?.lastSuccessAt), latencyMs: probe?.latencyMs ?? null });

function dataStore(probe, intervalMs, now, detail) {
  const { state, reason } = probeState(probe, intervalMs, now);
  return result(state, reason, { ...probeExtra(probe), details: [...(probe?.latencyMs != null ? [{ label: "Ping", value: `${probe.latencyMs} ms` }] : []), ...detail] });
}

function telegramApi(probe, intervalMs, now) {
  const base = probeState(probe, intervalMs, now);
  const extra = probeExtra(probe);
  if (!probe || base.state === "stale") return result(base.state, base.reason, extra);
  // checkTelegram mixes API reachability and polling evidence; the polling loop is its own component, so they are separated.
  if (probe.latencyMs == null) return result("failed", probe.error || "Telegram did not answer getMe.", extra);
  const webhook = probe.details?.webhook;
  const details = [{ label: "getMe", value: `${probe.latencyMs} ms` }];
  if (webhook?.pendingUpdates != null) details.push({ label: "Waiting at Telegram", value: String(webhook.pendingUpdates) });
  if (webhook?.registered) return result("degraded", "A webhook is registered while this bot long-polls.", { ...extra, details });
  if (webhook?.pendingUpdates > 100) return result("degraded", `${webhook.pendingUpdates} updates are waiting at Telegram.`, { ...extra, details });
  if (probe.latencyMs > 2_000) return result("degraded", `getMe took ${probe.latencyMs} ms.`, { ...extra, details });
  return result("healthy", "Telegram answered getMe.", { ...extra, details });
}

function pollingLoop(evidence, now) {
  if (!evidence) return result("unknown", "The bot has not started polling.");
  const lastSuccessAt = evidence.lastSuccessAgeSec == null ? null : now - evidence.lastSuccessAgeSec * SECOND;
  const extra = { evidence: "process", checkedAt: iso(now), lastSuccessAt: iso(lastSuccessAt), details: [
    ...(evidence.lastSuccessAgeSec != null ? [{ label: "Last poll", value: `${evidence.lastSuccessAgeSec} s ago` }] : []),
    ...(evidence.lastErrorAgeSec != null ? [{ label: "Last error", value: `${evidence.lastErrorAgeSec} s ago${evidence.lastErrorStatus ? ` (HTTP ${evidence.lastErrorStatus})` : ""}` }] : []),
  ] };
  if (evidence.failing && evidence.lastErrorStatus === 409) return result("failed", "Another process is polling with this token (409 Conflict), so this one may receive nothing.", extra);
  if (evidence.failing) return result("degraded", "Long polling is failing: no successful poll since the last error.", extra);
  if (evidence.stalled) return result("degraded", `No successful long poll for ${evidence.lastSuccessAgeSec} s.`, extra);
  if (lastSuccessAt == null) return result("unknown", "No completed poll to read yet.", extra);
  return result("healthy", "The last long poll completed.", extra);
}

function expressApp(probe, intervalMs, now, http15m, eventLoop) {
  const base = probeState(probe, intervalMs, now);
  const details = [];
  if (probe?.latencyMs != null) details.push({ label: "Loopback /livez", value: `${probe.latencyMs} ms` });
  if (eventLoop?.p99Ms != null) details.push({ label: "Event loop P99", value: `${eventLoop.p99Ms} ms` });
  const extra = { ...probeExtra(probe), details };
  if (base.state !== "healthy") return result(base.state, base.reason, extra);
  if (http15m.n >= 20 && http15m.err / http15m.n >= 0.25) return result("failed", `${http15m.err} of ${http15m.n} requests answered 5xx in 15 minutes.`, extra);
  if (http15m.n >= 20 && http15m.err / http15m.n >= 0.05) return result("degraded", `${http15m.err} of ${http15m.n} requests answered 5xx in 15 minutes.`, extra);
  // One thread runs polling, webhooks, crons and Next: a blocked loop delays all of them at once.
  if (eventLoop?.p99Ms != null && eventLoop.p99Ms > 1_000) return result("degraded", `The event loop stalled for up to ${eventLoop.p99Ms} ms.`, extra);
  return result("healthy", "The server answered its own /livez route.", extra);
}

function webhookPath({ secrets, recent, now, totals6h, lastOkAt }) {
  const missing = secrets.filter((item) => item.configured && !item.secretConfigured).map((item) => item.label);
  const details = [{ label: "Callbacks in 6 h", value: String(totals6h.n) }];
  if (totals6h.rej) details.push({ label: "Rejected in 6 h", value: String(totals6h.rej) });
  const extra = { evidence: "traffic", checkedAt: iso(now), lastSuccessAt: iso(lastOkAt), latencyMs: null, details };
  if (missing.length) return result("failed", `${missing.join(", ")}: the webhook secret is missing, so every callback is refused.`, { ...extra, evidence: "config" });
  if (recent.err >= MIN_FAILURES && recent.err / (recent.ok + recent.err) >= FAILURE_RATE) return result("failed", `${recent.err} callbacks failed in 15 minutes.`, extra);
  if (recent.err) return result("degraded", `${recent.err} callback${recent.err === 1 ? "" : "s"} failed in 15 minutes; the gateway retries them.`, extra);
  if (totals6h.ok) return result("healthy", "Signed callbacks are being accepted.", extra);
  return result("unknown", "No accepted callback in 6 hours, so this path is unproven. That is normal when nobody is paying.", extra);
}

function paymentProvider({ label, configured, recent, totals, webhookOk, lastOkAt, now }) {
  const details = [
    { label: "Reachability check", value: "None: only configuration can be checked" },
    { label: "Requests in 6 h", value: String(totals.n) },
    { label: "Callbacks accepted in 6 h", value: String(webhookOk) },
  ];
  const extra = { evidence: "traffic", checkedAt: iso(now), lastSuccessAt: iso(lastOkAt), details };
  if (!configured) return result("unknown", `${label} is not configured here.`, { ...extra, evidence: "config" });
  const failures = recent.err + recent.tmo;
  if (failures >= MIN_FAILURES && failures / Math.max(1, recent.ok + failures) >= FAILURE_RATE) return result("failed", `${failures} of ${recent.n} requests failed in 15 minutes.`, extra);
  if (failures) return result("degraded", `${failures} request${failures === 1 ? "" : "s"} failed in 15 minutes.`, extra);
  if (totals.ok || webhookOk) return result("healthy", "A request or a signed callback succeeded in the last 6 hours.", extra);
  return result("unknown", `Configured, but nothing has proven ${label} reachable in 6 hours.`, extra);
}

function wizardPanel(probe, intervalMs, now, create15m) {
  const base = probeState(probe, intervalMs, now);
  const failures = create15m.err + create15m.tmo;
  const details = [
    ...(probe?.latencyMs != null ? [{ label: "/status", value: `${probe.latencyMs} ms` }] : []),
    ...(probe?.details?.panelPingMs != null ? [{ label: "Panel ping", value: `${probe.details.panelPingMs} ms` }] : []),
    { label: "Create calls in 15 min", value: String(create15m.n) },
  ];
  const extra = { ...probeExtra(probe), details };
  if (base.state !== "healthy") return result(base.state, base.reason, extra);
  if (failures >= MIN_FAILURES && failures / Math.max(1, create15m.n) >= FAILURE_RATE) return result("degraded", `/status answers, but ${failures} of ${create15m.n} create calls failed.`, extra);
  return result("healthy", "/status answered.", extra);
}

function orderWorkflow(probe, intervalMs, now) {
  const details = probe?.details || {};
  const rows = [
    ["Need review", details.needsReview], ["Stuck provisioning", details.stalledProvisioning], ["Interrupted steps", details.ledgerStalled],
    ["Awaiting provider funds", details.awaitingProvider], ["Refunds pending", details.refundPending],
  ].filter(([, value]) => value != null).map(([label, value]) => ({ label, value: String(value) }));
  const extra = { evidence: "records", checkedAt: iso(probe?.at), lastSuccessAt: iso(probe?.lastSuccessAt), latencyMs: probe?.latencyMs ?? null, details: rows };
  if (!probe) return result("unknown", "No check has finished yet.", extra);
  if (now - probe.at > intervalMs * 3) return result("stale", `Last read was ${Math.round((now - probe.at) / SECOND)} seconds ago.`, extra);
  // A failed read means the records are out of reach, not that orders are failing.
  if (probe.status === "down") return result("unknown", "The order records could not be read.", extra);
  if (probe.status === "degraded") return result("degraded", probe.error || "Orders are waiting.", extra);
  return result("healthy", "The records show no stuck or waiting order.", extra);
}

function telegramDelivery({ ordersProbe, intervalMs, now, totals, recent, lastOkAt }) {
  const details = ordersProbe?.details || {};
  const rows = [{ label: "Delivered in 6 h", value: String(totals.ok) }, ...(details.deliveryPending != null ? [{ label: "Waiting in the outbox", value: String(details.deliveryPending) }] : [])];
  if (details.alertPending) rows.push({ label: "Admin alerts waiting", value: String(details.alertPending) });
  const extra = { evidence: "records", checkedAt: iso(ordersProbe?.at), lastSuccessAt: iso(lastOkAt), details: rows };
  if (!ordersProbe || now - ordersProbe.at > intervalMs * 3 || ordersProbe.status === "down") return result("unknown", "The delivery outbox could not be read.", extra);
  if (details.deliveryPending || details.alertPending) return result("degraded", `${(details.deliveryPending || 0) + (details.alertPending || 0)} message(s) waiting past the normal delay.`, extra);
  if (recent.err >= MIN_FAILURES && !recent.ok) return result("degraded", `${recent.err} deliveries failed in 15 minutes.`, extra);
  if (totals.ok) return result("healthy", "A service was delivered in the last 6 hours and the outbox is clear.", extra);
  return result("unknown", "The outbox is clear, but nothing was delivered in 6 hours to prove the path.", extra);
}

export function jobIntervalMs(job, env) {
  const seconds = job.intervalFrom ? Number(env[job.intervalFrom]) : NaN;
  return Number.isInteger(seconds) && seconds > 0 ? seconds * SECOND : job.everyMs;
}

/** Job runs are known only to this process, so right after a restart a job is `unknown`, not healthy and not overdue. */
export function jobStates(stats, { now, startedAt, env }) {
  const byName = new Map(stats.map((item) => [item.name, item]));
  return JOBS.filter((job) => job.enabled(env)).map((job) => {
    const stat = byName.get(job.name);
    const everyMs = jobIntervalMs(job, env);
    const overdueAfter = everyMs * 3;
    const base = { name: job.name, label: job.label, everyMs, lastRunAt: iso(stat?.lastRunAt), lastOkAt: iso(stat?.lastOkAt), consecutiveFailures: stat?.consecutiveFailures ?? 0, runs: stat?.runs ?? 0 };
    if (!stat) {
      return { ...base, state: now - startedAt > overdueAfter ? "failed" : "unknown", reason: now - startedAt > overdueAfter ? `No run reported since this process started, ${Math.round((now - startedAt) / MINUTE)} minutes ago.` : "No run reported since this process started." };
    }
    if (stat.consecutiveFailures > 0) return { ...base, state: stat.consecutiveFailures >= 2 ? "failed" : "degraded", reason: `${stat.consecutiveFailures} failed run${stat.consecutiveFailures === 1 ? "" : "s"} in a row.` };
    if (now - stat.lastRunAt > overdueAfter) return { ...base, state: "degraded", reason: `Overdue: last ran ${Math.round((now - stat.lastRunAt) / MINUTE)} minutes ago, every ${Math.round(everyMs / MINUTE)} expected.` };
    return { ...base, state: "healthy", reason: "Ran on schedule." };
  });
}

export function worstState(states) {
  return states.reduce((worst, state) => (STATE_RANK[state] < STATE_RANK[worst] ? state : worst), "healthy");
}

function backgroundJobs(jobs, now) {
  const extra = { evidence: "process", checkedAt: iso(now), details: jobs.map((job) => ({ label: job.label, value: job.state })) };
  if (!jobs.length) return result("unknown", "No job is enabled.", extra);
  const state = worstState(jobs.map((job) => job.state));
  if (state === "healthy") return result("healthy", "Every enabled job ran on schedule.", extra);
  const named = jobs.filter((job) => job.state === state);
  return result(state, state === "unknown" ? `${named.length} job(s) have not reported since this process started.` : `${named.map((job) => job.label).join(", ")}: ${named[0].reason}`, extra);
}

/** @returns the twelve components, in the order of COMPONENTS, each with a state and why. */
export function deriveComponents({ now, config, probes, minutes, polling, jobs, eventLoop, providers, lastDeliveryOkAt = null }) {
  const { intervalMs, probeIntervalMs } = config;
  const last15m = withinMinutes(minutes, now, WINDOWS["15m"].ms);
  const last6h = withinMinutes(minutes, now, EVIDENCE_WINDOW_MS);
  const webhookKeys = ["webhook.hooshpay", "webhook.nowpayments"];
  const callbacks6h = sumSeries(last6h, webhookKeys);
  const webhookLastOk = Math.max(0, ...providers.map((item) => item.lastWebhookOkAt ?? 0)) || null;

  const provider = (id, label, series) => {
    const entry = providers.find((item) => item.id === id);
    return paymentProvider({
      label,
      configured: entry?.configured ?? false,
      recent: sumSeries(last15m, [series]),
      totals: sumSeries(last6h, [series]),
      webhookOk: sumSeries(last6h, [`webhook.${id}`]).ok,
      lastOkAt: Math.max(entry?.lastRequestOkAt ?? 0, entry?.lastWebhookOkAt ?? 0) || null,
      now,
    });
  };

  const derived = {
    mongodb: dataStore(probes.mongodb, intervalMs, now, []),
    redis: dataStore(probes.redis, intervalMs, now, []),
    telegram: telegramApi(probes.telegram, probeIntervalMs, now),
    polling: pollingLoop(polling, now),
    express: expressApp(probes.express, intervalMs, now, sumSeries(last15m, ["http.admin", "http.panel", "http.store", "http.support", "http.other"]), eventLoop),
    webhook: webhookPath({ secrets: providers, recent: sumSeries(last15m, webhookKeys), now, totals6h: callbacks6h, lastOkAt: webhookLastOk }),
    hooshpay: provider("hooshpay", "HooshPay", "provider.hooshpay"),
    nowpayments: provider("nowpayments", "NOWPayments", "provider.nowpayments"),
    wizardxray: wizardPanel(probes.wizardxray, probeIntervalMs, now, sumSeries(last15m, ["provider.wizardxray.create"])),
    orders: orderWorkflow(probes.orders, probeIntervalMs, now),
    delivery: telegramDelivery({ ordersProbe: probes.orders, intervalMs: probeIntervalMs, now, totals: sumSeries(last6h, ["telegram.delivery"]), recent: sumSeries(last15m, ["telegram.delivery"]), lastOkAt: lastDeliveryOkAt }),
    jobs: backgroundJobs(jobs, now),
  };
  return COMPONENTS.map((component) => ({ id: component.id, label: component.label, group: component.group, critical: component.critical, role: component.role, dependsOn: component.dependsOn, ...derived[component.id] }));
}

/**
 * Overall state. A failed critical component is failure; anything failed or degraded is degradation. Then, and only then,
 * does a blind spot on a critical component beat "healthy": we do not claim the system is fine when we cannot see part of it.
 * Blind spots on optional components stay listed in `unverified`, so a quiet payment provider does not cry wolf at 4 a.m.
 */
export function deriveOverall(components) {
  const failedCritical = components.filter((item) => item.critical && item.state === "failed");
  const broken = components.filter((item) => item.state === "failed" || item.state === "degraded");
  const blindCritical = components.filter((item) => item.critical && (item.state === "unknown" || item.state === "stale"));
  const unverified = components.filter((item) => item.state === "unknown" || item.state === "stale").map((item) => item.id);
  const names = (items) => items.map((item) => item.label).join(", ");
  if (failedCritical.length) return { state: "failed", reason: `${names(failedCritical)} ${failedCritical.length === 1 ? "is" : "are"} not working.`, affected: broken.map((item) => item.id), unverified };
  if (broken.length) return { state: "degraded", reason: `${names(broken)} ${broken.length === 1 ? "needs" : "need"} attention.`, affected: broken.map((item) => item.id), unverified };
  if (blindCritical.length) return { state: blindCritical.some((item) => item.state === "stale") ? "stale" : "unknown", reason: `No recent evidence for ${names(blindCritical)}.`, affected: [], unverified };
  return { state: "healthy", reason: unverified.length ? "Every component that can be checked is working." : "Every component has recent evidence of working.", affected: [], unverified };
}

/**
 * Applied at read time, because a dead collector cannot report its own death. Past three intervals nothing in the snapshot is
 * a statement about now, so everything reads stale, whatever it said when it was fresh.
 */
export function applyFreshness(snapshot, { now, config }) {
  if (!config.enabled) {
    return { ...snapshot, overall: { state: "unknown", reason: "Monitoring is switched off on this server (RELIABILITY_ENABLED=off).", affected: [], unverified: snapshot?.components?.map((item) => item.id) ?? [] }, components: (snapshot?.components ?? []).map((item) => ({ ...item, state: "unknown", reason: "Monitoring is off." })) };
  }
  const lastTickAt = snapshot?.monitoring?.lastTickAt ? new Date(snapshot.monitoring.lastTickAt).getTime() : null;
  if (lastTickAt == null) return snapshot;
  const age = now - lastTickAt;
  const staleAfter = Math.max(config.intervalMs * 3, 45_000);
  if (age <= staleAfter) return { ...snapshot, monitoring: { ...snapshot.monitoring, ageMs: age, fresh: true } };
  const seconds = Math.round(age / SECOND);
  return {
    ...snapshot,
    monitoring: { ...snapshot.monitoring, ageMs: age, fresh: false },
    overall: { state: "stale", reason: `The monitor last ran ${seconds} seconds ago, so nothing here describes the system now.`, affected: [], unverified: snapshot.components.map((item) => item.id) },
    components: snapshot.components.map((item) => ({ ...item, state: "stale", reason: `Last known: ${item.state}. The monitor stopped ${seconds} seconds ago.` })),
    edges: snapshot.edges.map((edge) => ({ ...edge, count: edge.measured ? null : edge.count, perMinute: null, measured: false })),
  };
}
