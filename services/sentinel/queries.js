/**
 * Everything the panel reads. No writes, no recomputation on page load: aggregates are bounded by range, cached briefly
 * in this process (one replica), and a source that fails is reported as `degraded` instead of failing the page.
 */
import mongoose from "mongoose";
import JobCheckpoint from "../../models/JobCheckpoint.js";
import SentinelFinding from "../../models/SentinelFinding.js";
import { readCheckpoint } from "../jobLease.js";
import { ORDER_HELD_STATUSES, PAYMENT_PROVIDERS, SENTINEL_JOB, catalogEntry, readSentinelConfig } from "./constants.js";
import { defaultSources } from "./readOnly.js";
import { loadBundles, normalizeOrder, normalizePayment } from "./bundle.js";
import { evaluateBundle } from "./rules.js";
import { addToman, computeExposure, ledgerSets, reconstructBalance, walletEntries, wholeToman } from "./ledger.js";
import { explainFinding } from "./explain.js";
import { maskId, maskSubject, orderEvents, orderFlow, paymentEvents, paymentFlow, providerLabel, relationships } from "./projection.js";

const QUERY_TIMEOUT_MS = 8_000;
const TIME_ZONE = "Asia/Tehran";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
export const RANGES = Object.freeze({ "24h": { ms: DAY, bucket: "hour" }, "7d": { ms: 7 * DAY, bucket: "day" }, "30d": { ms: 30 * DAY, bucket: "day" }, "90d": { ms: 90 * DAY, bucket: "day" } });
const PROVIDERS = Object.keys(PAYMENT_PROVIDERS);

const objectIdAt = (date) => mongoose.Types.ObjectId.createFromTime(Math.floor(new Date(date).getTime() / 1000));
const timed = (query) => query.lean().maxTimeMS(QUERY_TIMEOUT_MS);
const aggregate = (source, pipeline) => source.aggregate(pipeline).option({ maxTimeMS: QUERY_TIMEOUT_MS });

const cache = new Map();
async function memo(key, ttlMs, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = compute();
  cache.set(key, { ...(hit || { at: 0 }), pending });
  try {
    const value = await pending;
    if (cache.size > 64) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
export function resetSentinelCache() { cache.clear(); }

async function settled(tasks) {
  const names = Object.keys(tasks);
  // Through a promise so a source that throws synchronously is degraded like one that rejects.
  const results = await Promise.allSettled(names.map((name) => Promise.resolve().then(tasks[name])));
  const data = {};
  const degraded = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") data[names[index]] = result.value;
    else { data[names[index]] = null; degraded.push(names[index]); }
  });
  return { data, degraded };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function latency(pairs) {
  const spans = pairs.map(([from, to]) => new Date(to) - new Date(from)).filter((span) => Number.isFinite(span) && span >= 0).sort((a, b) => a - b);
  return { samples: spans.length, p50Ms: percentile(spans, 0.5), p95Ms: percentile(spans, 0.95) };
}

export async function getSyncStatus({ checkpointModel = JobCheckpoint, sources = defaultSources(), config = readSentinelConfig(), now = new Date() } = {}) {
  const [checkpoint, totalUsers] = await Promise.all([
    readCheckpoint(checkpointModel, SENTINEL_JOB),
    sources.users.estimatedDocumentCount().maxTimeMS(QUERY_TIMEOUT_MS).catch(() => null),
  ]);
  const state = checkpoint?.state || {};
  const lastSuccessAt = state.lastSuccessAt || null;
  const age = lastSuccessAt ? now - new Date(lastSuccessAt) : null;
  let health = "never_run";
  if (!config.enabled) health = "disabled";
  else if (age != null) health = age <= config.intervalMs * 2.5 ? "healthy" : age <= config.intervalMs * 6 ? "delayed" : "stale";
  if (health === "healthy" && Number(state.consecutiveFailures || 0) > 0) health = "delayed";
  return {
    enabled: config.enabled,
    health,
    intervalSeconds: Math.round(config.intervalMs / 1000),
    lastTickAt: state.lastTickAt || null,
    lastSuccessAt,
    lastPassCompletedAt: state.lastPassCompletedAt || null,
    lastError: state.lastError || null,
    consecutiveFailures: Number(state.consecutiveFailures || 0),
    passUsers: Number(state.passUsers || 0),
    totalUsers,
    lastSummary: state.lastSummary || null,
    leaseHeld: Boolean(checkpoint?.leaseUntil && new Date(checkpoint.leaseUntil) > now),
  };
}

function bucketKey(bucket, field) {
  return { $dateToString: { format: bucket === "hour" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d", date: `$${field}`, timezone: TIME_ZONE } };
}

async function creditedSeries(sources, provider, from, to, bucket) {
  const { amountField } = PAYMENT_PROVIDERS[provider];
  return aggregate(sources[provider], [
    { $match: { balanceCreditedAt: { $gte: from, $lt: to }, balanceCredited: true } },
    { $group: { _id: bucketKey(bucket, "balanceCreditedAt"), amount: { $sum: `$${amountField}` }, count: { $sum: 1 } } },
  ]);
}

async function overviewSeries(sources, from, to, bucket) {
  const [credited, consumed, refunded] = await Promise.all([
    Promise.all(PROVIDERS.map((provider) => creditedSeries(sources, provider, from, to, bucket))),
    aggregate(sources.purchases, [
      { $match: { status: "completed", completedAt: { $gte: from, $lt: to } } },
      { $group: { _id: bucketKey(bucket, "completedAt"), amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    aggregate(sources.purchases, [
      { $match: { refundedAt: { $gte: from, $lt: to }, status: "refunded" } },
      { $group: { _id: bucketKey(bucket, "refundedAt"), amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);
  const points = new Map();
  const add = (rows, series) => {
    for (const row of rows) {
      const point = points.get(row._id) || { t: row._id, inflow: 0, consumed: 0, refunded: 0 };
      point[series] = addToman(point[series], wholeToman(row.amount) ?? 0);
      points.set(row._id, point);
    }
  };
  credited.forEach((rows) => add(rows, "inflow"));
  add(consumed, "consumed");
  add(refunded, "refunded");
  const totals = (rows) => rows.reduce((sum, row) => ({ amount: addToman(sum.amount, wholeToman(row.amount) ?? 0), count: sum.count + row.count }), { amount: 0, count: 0 });
  return {
    series: [...points.values()].sort((a, b) => a.t.localeCompare(b.t)),
    totals: { inflow: totals(credited.flat()), consumed: totals(consumed), refunded: totals(refunded) },
  };
}

async function heldNow(sources) {
  const [row] = await aggregate(sources.purchases, [
    { $match: { status: { $in: ORDER_HELD_STATUSES } } },
    { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  return { amount: wholeToman(row?.amount) ?? 0, count: row?.count ?? 0 };
}

async function processingLatency(sources, from, to) {
  const [credits, orders] = await Promise.all([
    Promise.all(PROVIDERS.map((provider) => timed(sources[provider].find({ balanceCreditedAt: { $gte: from, $lt: to } }).select("paidAt confirmedAt balanceCreditedAt").sort({ balanceCreditedAt: -1 }).limit(300)))),
    timed(sources.purchases.find({ status: "completed", completedAt: { $gte: from, $lt: to } }).select("reservedAt completedAt").sort({ status: 1, completedAt: -1 }).limit(500)),
  ]);
  return {
    credit: latency(credits.flat().filter((row) => row.paidAt || row.confirmedAt).map((row) => [row.paidAt || row.confirmedAt, row.balanceCreditedAt])),
    fulfilment: latency(orders.filter((row) => row.reservedAt).map((row) => [row.reservedAt, row.completedAt])),
  };
}

export async function findingSummary({ findingModel = SentinelFinding, limit = 5_000 } = {}) {
  const [groups, money] = await Promise.all([
    findingModel.aggregate([
      { $match: { state: "open", review: { $ne: "false_positive" } } },
      { $group: { _id: { classification: "$classification", severity: "$severity" }, count: { $sum: 1 } } },
    ]).option({ maxTimeMS: QUERY_TIMEOUT_MS }),
    findingModel.find({ state: "open", review: { $ne: "false_positive" }, amountToman: { $gt: 0 } })
      .select("fingerprint code userId impactKey amountToman direction classification review").limit(limit).lean().maxTimeMS(QUERY_TIMEOUT_MS),
  ]);
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byClassification = { confirmed: 0, probable: 0, informational: 0 };
  for (const group of groups) {
    bySeverity[group._id.severity] = (bySeverity[group._id.severity] || 0) + group.count;
    byClassification[group._id.classification] = (byClassification[group._id.classification] || 0) + group.count;
  }
  return { bySeverity, byClassification, exposure: computeExposure(money), exposureTruncated: money.length >= limit };
}

export function publicFinding(row) {
  return {
    id: String(row._id),
    code: row.code,
    title: catalogEntry(row.code).title,
    category: row.category,
    classification: row.classification,
    severity: row.severity,
    user: maskId(row.userId),
    subjectType: row.subjectType,
    subject: maskSubject(row.subjectKey),
    amountToman: row.amountToman,
    direction: row.direction,
    expected: row.expected,
    observed: row.observed,
    state: row.state,
    review: row.review,
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    clearedAt: row.clearedAt,
    detections: row.detections,
    reopenCount: row.reopenCount,
  };
}

export async function getOverview({ range = "7d", sources = defaultSources(), findingModel = SentinelFinding, checkpointModel = JobCheckpoint, config = readSentinelConfig(), now = new Date() } = {}) {
  const span = RANGES[range];
  const from = new Date(now.getTime() - span.ms);
  const cached = await memo(`overview:${range}`, 30_000, async () => settled({
    activity: () => overviewSeries(sources, from, now, span.bucket),
    held: () => heldNow(sources),
    latency: () => processingLatency(sources, from, now),
  }));
  const live = await settled({
    findings: () => findingSummary({ findingModel }),
    recent: async () => (await timed(findingModel.find({ state: "open", review: { $ne: "false_positive" } }).sort({ state: 1, lastDetectedAt: -1 }).limit(6))).map(publicFinding),
    sync: () => getSyncStatus({ checkpointModel, sources, config, now }),
  });
  return {
    generatedAt: now.toISOString(),
    range,
    bucket: span.bucket,
    timeZone: TIME_ZONE,
    activity: cached.data.activity,
    held: cached.data.held,
    latency: cached.data.latency,
    findings: live.data.findings,
    recentFindings: live.data.recent || [],
    sync: live.data.sync,
    degraded: [...cached.degraded, ...live.degraded],
  };
}

const CONFIRMED_EXPR = (provider) => ({ $in: ["$status", [...PAYMENT_PROVIDERS[provider].confirmed]] });

async function paymentCohort(sources, provider, from) {
  const { amountField } = PAYMENT_PROVIDERS[provider];
  const amount = { $ifNull: [`$${amountField}`, 0] };
  const [row] = await aggregate(sources[provider], [
    { $match: { _id: { $gte: objectIdAt(from) } } },
    {
      $group: {
        _id: null,
        initiatedCount: { $sum: 1 },
        initiatedAmount: { $sum: amount },
        confirmedCount: { $sum: { $cond: [CONFIRMED_EXPR(provider), 1, 0] } },
        confirmedAmount: { $sum: { $cond: [CONFIRMED_EXPR(provider), amount, 0] } },
        creditedCount: { $sum: { $cond: [{ $eq: ["$balanceCredited", true] }, 1, 0] } },
        creditedAmount: { $sum: { $cond: [{ $eq: ["$balanceCredited", true] }, amount, 0] } },
      },
    },
  ]);
  return { provider, label: providerLabel(provider), initiated: { count: row?.initiatedCount ?? 0, amount: row?.initiatedAmount ?? 0 }, confirmed: { count: row?.confirmedCount ?? 0, amount: row?.confirmedAmount ?? 0 }, credited: { count: row?.creditedCount ?? 0, amount: row?.creditedAmount ?? 0 } };
}

async function orderCohort(sources, from) {
  const rows = await aggregate(sources.purchases, [
    { $match: { _id: { $gte: objectIdAt(from) } } },
    { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
  ]);
  const pick = (statuses) => rows.filter((row) => statuses.includes(row._id)).reduce((sum, row) => ({ count: sum.count + row.count, amount: addToman(sum.amount, wholeToman(row.amount) ?? 0) }), { count: 0, amount: 0 });
  return {
    reserved: pick([...ORDER_HELD_STATUSES, "completed", "refunded"]),
    held: pick(ORDER_HELD_STATUSES),
    fulfilled: pick(["completed"]),
    refunded: pick(["refunded"]),
    failed: pick(["failed"]),
  };
}

async function adminCohort(sources, from) {
  const rows = await aggregate(sources.audits, [
    { $match: { createdAt: { $gte: from }, action: { $in: ["USER_BALANCE_ADDED", "USER_BALANCE_REMOVED"] }, status: "succeeded" } },
    { $group: { _id: "$action", count: { $sum: 1 }, amount: { $sum: "$metadata.amount" } } },
  ]);
  const byAction = Object.fromEntries(rows.map((row) => [row._id, { count: row.count, amount: wholeToman(row.amount) ?? 0 }]));
  return { added: byAction.USER_BALANCE_ADDED || { count: 0, amount: 0 }, removed: byAction.USER_BALANCE_REMOVED || { count: 0, amount: 0 } };
}

async function anomalyByCategory(findingModel) {
  const rows = await findingModel.aggregate([
    { $match: { state: "open", review: { $ne: "false_positive" }, classification: { $ne: "informational" } } },
    { $group: { _id: "$category", count: { $sum: 1 }, rank: { $min: "$rank" } } },
  ]).option({ maxTimeMS: QUERY_TIMEOUT_MS });
  return Object.fromEntries(rows.map((row) => [row._id, { count: row.count, rank: row.rank }]));
}

/** One cohort: records CREATED in the range, followed through their stages, so each stage is a subset of the one before. */
export async function getFlow({ range = "24h", provider = "all", sources = defaultSources(), findingModel = SentinelFinding, now = new Date() } = {}) {
  const span = RANGES[range];
  const from = new Date(now.getTime() - span.ms);
  const selected = provider === "all" || provider === "wallet" ? PROVIDERS : PROVIDERS.filter((name) => name === provider);
  const result = await memo(`flow:${range}:${provider}`, 15_000, async () => settled({
    payments: () => (provider === "wallet" ? Promise.resolve([]) : Promise.all(selected.map((name) => paymentCohort(sources, name, from)))),
    orders: () => orderCohort(sources, from),
    admin: () => adminCohort(sources, from),
  }));
  const anomalies = await anomalyByCategory(findingModel).catch(() => null);
  return { generatedAt: now.toISOString(), range, provider, from: from.toISOString(), ...result.data, anomalies: anomalies || {}, degraded: result.degraded };
}

const FEED_FIELDS = {
  hooshpay: "uid orderId userId amount status balanceCredited balanceCreditedAt createdAt paidAt reversedAt creditLedgerVersion",
  nowpayments: "orderId userId amountToman status balanceCredited balanceCreditedAt createdAt updatedAt paidAt payCurrency creditLedgerVersion",
  bank: "paymentId userId amount status balanceCredited balanceCreditedAt createdAt confirmedAt rejectedAt creditLedgerVersion",
  trx: "invoiceId userId amount status balanceCredited balanceCreditedAt createdAt confirmedAt rejectedAt creditLedgerVersion",
};
const FEED_ORDER_FIELDS = "purchaseId telegramId amount status reservedAt walletDebitedAt provisioningStartedAt awaitingProviderSince completedAt refundRequestedAt refundedAt createdAt planId";

/**
 * Incremental activity since a cursor. Stateless: repeated polls overlap by design, and every event has a stable id,
 * so a client merges them without duplicates and in time order however late an event arrives. `truncated` tells the
 * client that a source returned its full limit and the feed may have a gap.
 */
export async function getLiveEvents({ since, limit = 100, provider = "all", stage = null, minAmount = null, maxAmount = null, userId = null, sources = defaultSources(), findingModel = SentinelFinding, config = readSentinelConfig(), now = new Date() } = {}) {
  const from = since || new Date(now.getTime() - 6 * HOUR);
  const perSource = Math.min(200, limit);
  const fromId = objectIdAt(from);
  const owner = userId ? { userId: Number(userId) } : {};
  const tasks = {};
  for (const name of PROVIDERS) {
    if (provider !== "all" && provider !== name) continue;
    tasks[`${name}:created`] = () => timed(sources[name].find({ _id: { $gte: fromId }, ...owner }).select(FEED_FIELDS[name]).sort({ _id: -1 }).limit(perSource));
    tasks[`${name}:credited`] = () => timed(sources[name].find({ balanceCreditedAt: { $gte: from }, ...owner }).select(FEED_FIELDS[name]).sort({ balanceCreditedAt: -1 }).limit(perSource));
  }
  tasks["hooshpay:reversed"] = provider === "all" || provider === "hooshpay"
    ? () => timed(sources.hooshpay.find({ status: "reversed", reversedAt: { $gte: from }, ...owner }).select(FEED_FIELDS.hooshpay).limit(perSource))
    : () => Promise.resolve([]);
  tasks["nowpayments:refunded"] = provider === "all" || provider === "nowpayments"
    ? () => timed(sources.nowpayments.find({ status: "refunded", updatedAt: { $gte: from }, ...owner }).select(FEED_FIELDS.nowpayments).limit(perSource))
    : () => Promise.resolve([]);
  if (provider === "all" || provider === "wallet") {
    const buyer = userId ? { telegramId: String(userId) } : {};
    tasks["orders:created"] = () => timed(sources.purchases.find({ _id: { $gte: fromId }, ...buyer }).select(FEED_ORDER_FIELDS).sort({ _id: -1 }).limit(perSource));
    tasks["orders:completed"] = () => timed(sources.purchases.find({ status: "completed", completedAt: { $gte: from }, ...buyer }).select(FEED_ORDER_FIELDS).sort({ status: 1, completedAt: -1 }).limit(perSource));
    tasks["orders:refunded"] = () => timed(sources.purchases.find({ refundedAt: { $gte: from }, ...buyer }).select(FEED_ORDER_FIELDS).sort({ refundedAt: -1 }).limit(perSource));
  }
  const { data, degraded } = await settled(tasks);
  const events = new Map();
  let truncated = false;
  for (const [name, rows] of Object.entries(data)) {
    if (!rows) continue;
    if (rows.length >= perSource) truncated = true;
    const source = name.split(":")[0];
    for (const row of rows) {
      const items = source === "orders" ? orderEvents(normalizeOrder(row, config)) : paymentEvents(normalizePayment(source, row));
      for (const item of items) events.set(item.id, item);
    }
  }
  const low = minAmount ?? -Infinity;
  const high = maxAmount ?? Infinity;
  const sorted = [...events.values()]
    .filter((item) => new Date(item.at) >= from && (!stage || item.stage === stage) && (item.amount ?? 0) >= low && (item.amount ?? 0) <= high)
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const page = sorted.slice(0, limit);
  const openFindings = await findingModel.countDocuments({ state: "open", review: { $ne: "false_positive" }, classification: { $ne: "informational" } }).maxTimeMS(QUERY_TIMEOUT_MS).catch(() => null);
  return { events: page, serverTime: now.toISOString(), nextSince: now.toISOString(), truncated: truncated || sorted.length > limit, degraded, openFindings };
}

function paymentStateFilter(provider, state) {
  const { confirmed } = PAYMENT_PROVIDERS[provider];
  switch (state) {
    case "pending": return { status: { $nin: [...confirmed, ...PAYMENT_PROVIDERS[provider].reversed, "expired", "cancelled", "failed", "rejected", "creation_failed"] } };
    case "confirmed": return { status: { $in: confirmed }, balanceCredited: { $ne: true } };
    case "credited": return { balanceCredited: true };
    case "failed": return { status: { $in: ["expired", "cancelled", "failed", "rejected", "creation_failed"] } };
    case "reversed": return PAYMENT_PROVIDERS[provider].reversed.length ? { status: { $in: PAYMENT_PROVIDERS[provider].reversed } } : null;
    default: return state ? null : {};
  }
}

function orderStateFilter(state) {
  switch (state) {
    case "pending": return { status: { $in: ["reserving", "reserved", "provisioning", "provisioned"] } };
    case "reserved": return { status: { $in: ORDER_HELD_STATUSES } };
    case "review": return { status: { $in: ["uncertain", "manual_review", "awaiting_provider"] } };
    case "fulfilled": return { status: "completed" };
    case "refunded": return { status: { $in: ["refund_pending", "refunded"] } };
    case "failed": return { status: "failed" };
    default: return state ? null : {};
  }
}

function amountFilter(field, min, max) {
  if (min == null && max == null) return {};
  return { [field]: { ...(min != null ? { $gte: min } : {}), ...(max != null ? { $lte: max } : {}) } };
}

const rowSummary = (item, isOrder) => ({
  key: item.key,
  kind: isOrder ? "order" : "payment",
  provider: isOrder ? "wallet" : item.provider,
  providerLabel: providerLabel(isOrder ? "wallet" : item.provider),
  label: isOrder ? item.planName || item.planId || "Order" : "Wallet top-up",
  amount: wholeToman(item.amount),
  currency: "Toman",
  payCurrency: item.payCurrency || null,
  user: maskId(item.userId),
  status: item.status,
  createdAt: item.createdAt,
});

/** Newest first across every source, by _id keyset: stable under inserts, and no skip() over the money collections. */
export async function listTransactions({ pageSize = 25, before = null, from = null, to = null, provider = "all", state = null, reference = null, userId = null, minAmount = null, maxAmount = null, payCurrency = null, severity = null, sources = defaultSources(), findingModel = SentinelFinding, config = readSentinelConfig(), now = new Date() } = {}) {
  const lower = from || new Date(now.getTime() - 30 * DAY);
  const idRange = { $gte: objectIdAt(lower), ...(to ? { $lte: objectIdAt(to) } : {}) };
  if (before) idRange.$lt = new mongoose.Types.ObjectId(before);
  const take = pageSize + 1;
  const tasks = {};

  let severityKeys = null;
  if (severity) {
    const rows = await timed(findingModel.find({ state: "open", severity, subjectType: { $in: ["payment", "order"] } }).select("subjectKey").limit(500));
    severityKeys = new Set(rows.map((row) => row.subjectKey));
  }
  const refsFor = (prefix) => (severityKeys ? [...severityKeys].filter((key) => key.startsWith(`${prefix}:`)).map((key) => key.slice(prefix.length + 1)) : null);

  for (const name of PROVIDERS) {
    if ((provider !== "all" && provider !== name) || (payCurrency && name !== "nowpayments")) continue;
    const stateMatch = paymentStateFilter(name, state);
    if (!stateMatch) continue;
    const spec = PAYMENT_PROVIDERS[name];
    const refs = refsFor(name);
    if (refs && !refs.length) continue;
    const filter = {
      _id: idRange,
      ...stateMatch,
      ...amountFilter(spec.amountField, minAmount, maxAmount),
      ...(userId ? { userId: Number(userId) } : {}),
      ...(payCurrency ? { payCurrency } : {}),
      ...(refs ? { [spec.refField]: { $in: refs } } : {}),
      ...(reference ? { [spec.refField]: reference } : {}),
    };
    tasks[name] = () => timed(sources[name].find(filter).select(`${FEED_FIELDS[name]} recoveryStatus`).sort({ _id: -1 }).limit(take));
  }
  if ((provider === "all" || provider === "wallet") && !payCurrency) {
    const stateMatch = orderStateFilter(state);
    const refs = refsFor("wallet");
    if (stateMatch && !(refs && !refs.length)) {
      const filter = {
        _id: idRange,
        ...stateMatch,
        ...amountFilter("amount", minAmount, maxAmount),
        ...(userId ? { telegramId: String(userId) } : {}),
        ...(refs ? { purchaseId: { $in: refs } } : {}),
        ...(reference ? { purchaseId: reference } : {}),
      };
      tasks.orders = () => timed(sources.purchases.find(filter).select(`${FEED_ORDER_FIELDS} planName recoveryStatus`).sort({ _id: -1 }).limit(take));
    }
  }

  const { data, degraded } = await settled(tasks);
  const merged = [];
  for (const [name, rows] of Object.entries(data)) {
    for (const row of rows || []) {
      const isOrder = name === "orders";
      merged.push({ id: String(row._id), row: rowSummary(isOrder ? normalizeOrder(row, config) : normalizePayment(name, row), isOrder) });
    }
  }
  merged.sort((a, b) => b.id.localeCompare(a.id));
  const page = merged.slice(0, pageSize);
  const keys = page.map((item) => item.row.key);
  const anomalies = keys.length
    ? await timed(findingModel.find({ state: "open", subjectKey: { $in: keys } }).select("subjectKey severity rank")).catch(() => [])
    : [];
  const worst = new Map();
  for (const finding of anomalies) {
    const current = worst.get(finding.subjectKey);
    worst.set(finding.subjectKey, { severity: !current || finding.rank < current.rank ? finding.severity : current.severity, rank: Math.min(finding.rank, current?.rank ?? 9), count: (current?.count ?? 0) + 1 });
  }
  return {
    items: page.map((item) => ({ ...item.row, anomaly: worst.get(item.row.key) ? { severity: worst.get(item.row.key).severity, count: worst.get(item.row.key).count } : null })),
    nextBefore: merged.length > pageSize ? page[page.length - 1].id : null,
    pageSize,
    degraded,
  };
}

async function findOwner(key, sources) {
  const separator = key.indexOf(":");
  const provider = key.slice(0, separator);
  const ref = key.slice(separator + 1);
  if (provider === "wallet") {
    const row = await timed(sources.purchases.findOne({ purchaseId: ref }).select("telegramId"));
    return row ? String(row.telegramId) : null;
  }
  const spec = PAYMENT_PROVIDERS[provider];
  if (!spec) return null;
  let row = await timed(sources[provider].findOne({ [spec.refField]: ref }).select("userId"));
  if (!row && provider === "hooshpay") row = await timed(sources.hooshpay.findOne({ orderId: ref }).select("userId"));
  return row ? String(row.userId) : null;
}

function walletSummary(bundle) {
  if (!bundle.user) return { available: false };
  const reconstruction = reconstructBalance(bundle);
  return {
    available: true,
    balance: reconstruction.balance,
    expected: reconstruction.expected,
    drift: reconstruction.drift,
    coverage: reconstruction.coverage,
    totals: reconstruction.totals,
    counts: reconstruction.counts,
    unkeyed: reconstruction.unkeyed,
    uncountedCredits: reconstruction.uncountedCredits,
    unresolved: reconstruction.unresolved.length,
    entries: walletEntries(bundle, reconstruction).slice(-40).reverse(),
  };
}

export async function getTransaction({ key, sources = defaultSources(), findingModel = SentinelFinding, config = readSentinelConfig() } = {}) {
  const userId = await findOwner(key, sources);
  if (!userId) return null;
  const bundles = await loadBundles([userId], { sources, config });
  const bundle = bundles.get(userId);
  const isOrder = key.startsWith("wallet:");
  const subject = isOrder ? bundle.orders.find((order) => order.key === key) : bundle.payments.find((payment) => payment.key === key);
  if (!subject) return null;
  const ledger = ledgerSets(bundle.user);
  const findings = await timed(findingModel.find({ userId, $or: [{ subjectKey: key }, { "refs.key": key }] }).sort({ state: 1, rank: 1 }).limit(20));
  return {
    key,
    kind: isOrder ? "order" : "payment",
    provider: isOrder ? "wallet" : subject.provider,
    providerLabel: providerLabel(isOrder ? "wallet" : subject.provider),
    amount: wholeToman(subject.amount),
    currency: "Toman",
    status: subject.status,
    createdAt: subject.createdAt,
    userId,
    user: maskId(userId),
    identifiers: isOrder
      ? { orderId: subject.purchaseId, planName: subject.planName, planId: subject.planId, serviceUsername: subject.serviceUsername, days: subject.days, trafficGb: subject.gig }
      : { reference: subject.ref, invoiceId: subject.invoiceId, paymentId: subject.paymentId, trackingCode: subject.trackingCode, transactionHash: subject.transactionHash, payCurrency: subject.payCurrency, payAmount: subject.payAmount, actuallyPaid: subject.actuallyPaid },
    verification: isOrder ? null : {
      providerStatus: subject.status,
      confirmed: subject.confirmed,
      ledgerVersion: subject.ledgerVersion,
      callbacks: subject.callbacks.slice(-20),
      retryCount: subject.retryCount,
      lastErrorCode: subject.lastErrorCode,
    },
    order: isOrder ? {
      walletDebitStatus: subject.walletDebitStatus,
      refundStatus: subject.refundStatus,
      refundAmount: subject.refundAmount,
      refundReason: subject.refundReason,
      errorCode: subject.errorCode,
      retryCount: subject.retryCount,
      transitions: subject.events,
    } : null,
    recovery: { status: subject.recoveryStatus, reason: subject.recoveryReason },
    flow: isOrder ? orderFlow(subject, ledger) : paymentFlow(subject, ledger),
    relationships: relationships(subject, bundle),
    wallet: walletSummary(bundle),
    findings: findings.map(publicFinding),
  };
}

export async function listFindings({ page = 1, pageSize = 25, classification = null, severity = null, category = null, review = null, state = "open", userId = null, code = null, findingModel = SentinelFinding } = {}) {
  const filter = {
    ...(state === "all" ? {} : { state }),
    ...(classification ? { classification } : {}),
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(code ? { code } : {}),
    ...(review ? { review } : { review: { $ne: "false_positive" } }),
    ...(userId ? { userId } : {}),
  };
  const [rows, total] = await Promise.all([
    timed(findingModel.find(filter).sort({ state: 1, rank: 1, firstDetectedAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize)),
    findingModel.countDocuments(filter).maxTimeMS(QUERY_TIMEOUT_MS),
  ]);
  return { items: rows.map(publicFinding), page, pageSize, total, pages: Math.ceil(total / pageSize) };
}

/**
 * Re-derive a finding from the records as they are now. Reads only. This, and not the stored row, is what "still
 * reproduces" means everywhere: the investigation view, the proposal check and the resolve check.
 */
export async function revalidateFinding(finding, { sources = defaultSources(), config = readSentinelConfig(), now = new Date() } = {}) {
  const bundles = await loadBundles([finding.userId], { sources, config });
  const bundle = bundles.get(finding.userId);
  const current = evaluateBundle(bundle, { now, config });
  const match = current.find((item) => item.fingerprint === finding.fingerprint) || null;
  return { bundle, match, others: current.filter((item) => item.fingerprint !== finding.fingerprint) };
}

function timelineFor(finding, bundle) {
  const keys = new Set([finding.subjectKey, finding.impactKey, ...(finding.refs || []).map((ref) => ref.key)]);
  const wholeWallet = finding.subjectType === "wallet";
  const events = [];
  for (const payment of bundle.payments) if (wholeWallet || keys.has(payment.key)) events.push(...paymentEvents(payment));
  for (const order of bundle.orders) if (wholeWallet || keys.has(order.key)) events.push(...orderEvents(order));
  for (const payment of bundle.payments) {
    if (!keys.has(payment.key)) continue;
    for (const callback of payment.callbacks.slice(-10)) {
      events.push({ id: `${payment.key}#callback#${callback.at}`, key: payment.key, kind: "payment", provider: payment.provider, stage: "callback", at: new Date(callback.at).toISOString(), amount: null, currency: "Toman", status: callback.status, source: "Provider callback log", basis: "recorded" });
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at)).slice(-60);
}

export async function getFinding({ id, sources = defaultSources(), findingModel = SentinelFinding, config = readSentinelConfig(), now = new Date() } = {}) {
  const row = await timed(findingModel.findById(id));
  if (!row) return null;
  const { bundle, match, others } = await revalidateFinding(row, { sources, config, now });
  const related = await timed(findingModel.find({ userId: row.userId, state: "open", _id: { $ne: row._id } }).sort({ rank: 1 }).limit(20));
  const group = await timed(findingModel.find({ userId: row.userId, state: "open", amountToman: { $gt: 0 } }).select("fingerprint code userId impactKey amountToman direction classification review").limit(200));
  const explanation = explainFinding(row);
  return {
    ...publicFinding(row),
    userId: row.userId,
    subject: row.subjectKey,
    subjectHref: ["payment", "order"].includes(row.subjectType) && !row.subjectKey.includes("+") ? row.subjectKey : null,
    expectedToman: row.expectedToman,
    observedToman: row.observedToman,
    facts: row.facts,
    refs: row.refs,
    reviewHistory: row.reviewHistory || [],
    explanation,
    revalidation: {
      checkedAt: now.toISOString(),
      stillReproduces: Boolean(match),
      expected: match?.expected ?? null,
      observed: match?.observed ?? null,
      amountToman: match?.amountToman ?? null,
      otherLiveProblems: others.length,
    },
    impact: {
      thisFinding: row.amountToman,
      direction: row.direction,
      customer: computeExposure(group),
      note: "Customer totals count one payment or order once, and a balance difference is not added to the records that explain it.",
    },
    timeline: bundle ? timelineFor(row, bundle) : [],
    wallet: bundle ? walletSummary(bundle) : { available: false },
    related: related.map(publicFinding),
  };
}
