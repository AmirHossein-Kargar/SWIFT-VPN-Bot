/**
 * Turns recorded minutes into the numbers on the panel. Pure, and honest about what a window really contains: every result
 * carries how much of the window was actually observed, and a percentile or a rate appears only with enough samples.
 */
import { LATENCY_BOUNDS_MS } from "./telemetry.js";
import { PERCENTILE_MIN_SAMPLES, RATE_MIN_SAMPLES, WINDOWS } from "./constants.js";

const MINUTE = 60_000;
const OVERFLOW = LATENCY_BOUNDS_MS.length;

function mergeInto(total, series) {
  total.n += series.n || 0;
  total.ok += series.ok || 0;
  total.err += series.err || 0;
  total.rej += series.rej || 0;
  total.tmo += series.tmo || 0;
  total.timed += series.timed || 0;
  total.sumMs += series.sumMs || 0;
  for (let index = 0; index <= OVERFLOW; index += 1) total.h[index] += series.h?.[index] || 0;
}

export const emptyTotals = () => ({ n: 0, ok: 0, err: 0, rej: 0, tmo: 0, timed: 0, sumMs: 0, h: new Array(OVERFLOW + 1).fill(0) });

export function sumSeries(minutes, keys) {
  const total = emptyTotals();
  const wanted = keys ? new Set(keys) : null;
  for (const minute of minutes) {
    for (const [key, series] of Object.entries(minute.series || {})) {
      if (!wanted || wanted.has(key)) mergeInto(total, series);
    }
  }
  return total;
}

/**
 * The bucket's upper bound: a value a share of the samples did not exceed. Fixed buckets mean this is an upper estimate, not
 * an exact sample, which the panel says. A rank landing in the overflow bucket has no upper bound, so it reports `null`
 * with `over` set instead of inventing one.
 */
export function histogramPercentile(h, samples, fraction) {
  if (!samples) return { valueMs: null, over: false };
  const rank = Math.ceil(samples * fraction);
  let seen = 0;
  for (let index = 0; index < h.length; index += 1) {
    seen += h[index];
    if (seen >= rank) return index === OVERFLOW ? { valueMs: null, over: true } : { valueMs: LATENCY_BOUNDS_MS[index], over: false };
  }
  return { valueMs: null, over: false };
}

export function percentiles(total) {
  const samples = total.timed;
  const pick = (name, fraction) => {
    if (samples < PERCENTILE_MIN_SAMPLES[name]) return null;
    return histogramPercentile(total.h, samples, fraction);
  };
  return { samples, p50: pick("p50", 0.5), p95: pick("p95", 0.95), p99: pick("p99", 0.99) };
}

/** From raw durations, for records that keep exact timestamps. Same sample floors as the histogram. */
export function rawPercentiles(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const pick = (name, fraction) => {
    if (sorted.length < PERCENTILE_MIN_SAMPLES[name]) return null;
    return { valueMs: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)], over: false };
  };
  return { samples: sorted.length, p50: pick("p50", 0.5), p95: pick("p95", 0.95), p99: pick("p99", 0.99) };
}

function rate(part, whole) {
  return whole >= RATE_MIN_SAMPLES ? part / whole : null;
}

const within = (minutes, from) => minutes.filter((minute) => minute.t >= from);

/** A minute with a stored rollup was measured, even if nothing happened. A minute with none is a gap, never a zero. */
export function coverage(minutes, windowMs, now, startedAt) {
  const from = now - windowMs;
  const expected = Math.round(windowMs / MINUTE);
  const distinct = new Set(within(minutes, from).filter((minute) => minute.t < now).map((minute) => minute.t));
  const observed = Math.min(expected, distinct.size);
  const firstAt = distinct.size ? Math.min(...distinct) : null;
  return { observedMinutes: observed, expectedMinutes: expected, ratio: expected ? observed / expected : 0, since: firstAt ? new Date(firstAt).toISOString() : null, instanceStartedAt: new Date(startedAt).toISOString() };
}

const HTTP = ["http.admin", "http.panel", "http.store", "http.support", "http.other"];
const WEBHOOK = ["webhook.hooshpay", "webhook.nowpayments"];
const PROVIDER = ["provider.wizardxray.create", "provider.wizardxray.read", "provider.wizardxray.write", "provider.hooshpay", "provider.nowpayments"];
const SERVED = [...HTTP, ...WEBHOOK, "telegram.update"];

function spark(minutes, windowMs, now, pick, points = 24) {
  const bucketMs = windowMs / points;
  const from = now - windowMs;
  const values = new Array(points).fill(0);
  for (const minute of minutes) {
    const index = Math.floor((minute.t - from) / bucketMs);
    if (index >= 0 && index < points) values[index] += pick(minute);
  }
  return values;
}

export function windowMetrics(allMinutes, name, { now, startedAt }) {
  const { ms } = WINDOWS[name];
  const minutes = within(allMinutes, now - ms);
  const http = sumSeries(minutes, HTTP);
  const webhook = sumSeries(minutes, WEBHOOK);
  const provider = sumSeries(minutes, PROVIDER);
  const updates = sumSeries(minutes, ["telegram.update"]);
  const create = sumSeries(minutes, ["provider.wizardxray.create"]);
  const handled = http.n + webhook.n + updates.n;
  const failures = http.err + webhook.err + provider.err + provider.tmo;
  const attempts = http.n + webhook.n + provider.n;
  const span = coverage(allMinutes, ms, now, startedAt);
  const observedMinutes = Math.max(1, span.observedMinutes);
  return {
    window: name,
    coverage: span,
    throughput: {
      count: handled,
      perMinute: handled / observedMinutes,
      http: http.n,
      webhooks: webhook.n,
      telegramUpdates: updates.n,
      spark: spark(minutes, ms, now, (minute) => SERVED.reduce((sum, key) => sum + (minute.series?.[key]?.n || 0), 0)),
    },
    errors: {
      count: failures,
      attempts,
      rate: rate(failures, attempts),
      rejectedCallbacks: webhook.rej,
      spark: spark(minutes, ms, now, (minute) => [...HTTP, ...WEBHOOK, ...PROVIDER].reduce((sum, key) => sum + (minute.series?.[key]?.err || 0) + (minute.series?.[key]?.tmo || 0), 0)),
    },
    timeouts: { count: provider.tmo, attempts: provider.n, rate: rate(provider.tmo, provider.n) },
    latency: { webhook: percentiles(webhook), providerCreate: percentiles(create), provider: percentiles(provider), http: percentiles(http) },
  };
}

/** Points for a history chart. A bucket nobody measured has `measured: 0`, and its latency stays null so the line breaks. */
export function historySeries(allMinutes, name, { now }) {
  const { ms, bucketMs } = WINDOWS[name];
  const start = now - ms - ((now - ms) % bucketMs);
  const buckets = new Map();
  for (let t = start; t <= now; t += bucketMs) buckets.set(t, { t, minutes: [], worst: {} });
  for (const minute of within(allMinutes, start)) {
    const key = minute.t - ((minute.t - start) % bucketMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.minutes.push(minute);
  }
  const RANK = { failed: 0, degraded: 1, stale: 2, unknown: 3, healthy: 4 };
  return [...buckets.values()].map(({ t, minutes }) => {
    const served = sumSeries(minutes, SERVED);
    const provider = sumSeries(minutes, PROVIDER);
    const timedHttp = sumSeries(minutes, [...HTTP, ...WEBHOOK]);
    const failures = sumSeries(minutes, [...HTTP, ...WEBHOOK, ...PROVIDER]);
    const health = {};
    for (const minute of minutes) {
      for (const [id, state] of Object.entries(minute.health || {})) {
        if (!health[id] || RANK[state] < RANK[health[id]]) health[id] = state;
      }
    }
    const distinct = new Set(minutes.map((minute) => minute.t)).size;
    const p95 = percentiles(timedHttp).p95;
    const providerP95 = percentiles(provider).p95;
    return {
      t: new Date(t).toISOString(),
      measured: distinct,
      requests: minutes.length ? served.n : null,
      errors: minutes.length ? failures.err + failures.tmo : null,
      timeouts: minutes.length ? provider.tmo : null,
      p95Ms: p95?.valueMs ?? null,
      providerP95Ms: providerP95?.valueMs ?? null,
      health,
    };
  });
}

/** Observed traffic on a topology edge, from the same minutes as everything else. */
export function edgeTraffic(minutes, edge, { now, records = {}, windowMs = WINDOWS["15m"].ms }) {
  if (edge.kind !== "flow") return { measured: false, count: null, perMinute: null };
  if (edge.records) {
    const count = records[edge.records];
    return count == null ? { measured: false, count: null, perMinute: null } : { measured: true, count, perMinute: count / (windowMs / MINUTE) };
  }
  const total = sumSeries(within(minutes, now - windowMs), edge.series);
  return { measured: true, count: total.n, perMinute: total.n / (windowMs / MINUTE) };
}

export function eventLoopSummary(histogram) {
  if (!histogram) return null;
  const toMs = (value) => (Number.isFinite(value) ? Math.round(value / 1e6) : null);
  return { p50Ms: toMs(histogram.percentile(50)), p99Ms: toMs(histogram.percentile(99)), maxMs: toMs(histogram.max) };
}
