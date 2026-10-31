/**
 * The order workflow as the records state it: what is unresolved, how orders fared in each window, and one order's trace.
 * Every read goes through Sentinel's read-only wrappers, names its fields and has a limit and a timeout. Service links,
 * hashes and usernames are never selected, so they cannot reach a response.
 */
import mongoose from "mongoose";
import { ORDER_SETTLE_MS, ORDER_STALE_MS } from "../admin/monitoring.js";
import { maskId } from "../sentinel/projection.js";
import { rawPercentiles } from "./metrics.js";
import { sanitizeCode, sanitizeText } from "./sanitize.js";
import { RATE_MIN_SAMPLES, WINDOWS } from "./constants.js";

const QUERY_TIMEOUT_MS = 8_000;
const BACKLOG_LIMIT = 50;
const COHORT_LIMIT = 3_000;
const DAY = 24 * 60 * 60_000;

const timed = (query) => query.lean().maxTimeMS(QUERY_TIMEOUT_MS);
const objectIdAt = (ms) => mongoose.Types.ObjectId.createFromTime(Math.floor(ms / 1000));

export const UNRESOLVED_STATUSES = Object.freeze(["reserving", "reserved", "provisioning", "provisioned", "uncertain", "manual_review", "awaiting_provider", "refund_pending"]);
const FAILED_AFTER_DEBIT = new Set(["refund_pending", "refunded", "failed"]);

const BACKLOG_FIELDS = "purchaseId telegramId status errorCode createdAt reservedAt provisioningStartedAt provisionedAt awaitingProviderSince refundRequestedAt completedAt notificationAttempts";
const COHORT_FIELDS = "status createdAt reservedAt provisioningStartedAt provisionedAt completedAt refundedAt";
const TRACE_FIELDS = "purchaseId telegramId planName status walletDebitStatus createdAt reservedAt walletDebitedAt provisioningStartedAt provisionedAt completedAt refundRequestedAt refundedAt refundStatus refundReason errorCode retryCount lastRetryAt fulfillmentAttempts awaitingProviderSince recoveryStatus recoveryReason notificationPending notifiedAt notificationAttempts notificationNextAt customerNoticePending customerNotifiedAt events";

/** The moment an order entered the state it is stuck in. A missing timestamp falls back to creation, and says so by being old. */
function stateSince(row) {
  switch (row.status) {
    case "provisioning": case "uncertain": case "manual_review": return row.provisioningStartedAt || row.createdAt;
    case "awaiting_provider": return row.awaitingProviderSince || row.createdAt;
    case "refund_pending": return row.refundRequestedAt || row.createdAt;
    case "provisioned": return row.provisionedAt || row.createdAt;
    case "completed": return row.completedAt || row.createdAt;
    default: return row.reservedAt || row.createdAt;
  }
}

function limitFor(status) {
  if (status === "refund_pending" || status === "completed") return ORDER_SETTLE_MS;
  return ORDER_STALE_MS;
}

function backlogRow(row, now) {
  const since = new Date(stateSince(row)).getTime();
  const ageMs = Math.max(0, now - since);
  const limitMs = limitFor(row.status);
  return {
    key: `wallet:${row.purchaseId}`,
    orderId: String(row.purchaseId),
    user: maskId(row.telegramId),
    status: row.status,
    since: new Date(since).toISOString(),
    ageMs,
    limitMs,
    overdue: ageMs > limitMs,
    errorCode: row.errorCode ? sanitizeCode(row.errorCode, 80) : null,
  };
}

export async function loadBacklog({ sources, now }) {
  const [unresolved, undelivered] = await Promise.all([
    timed(sources.purchases.find({ status: { $in: UNRESOLVED_STATUSES } }).select(BACKLOG_FIELDS).sort({ createdAt: 1 }).limit(BACKLOG_LIMIT)),
    // No status here on purpose: with one, the planner can prefer the status index and walk every completed order. The flag
    // is only ever set on completed orders, and on this field alone only the small partial index can serve the query.
    timed(sources.purchases.find({ notificationPending: true }).select(BACKLOG_FIELDS).sort({ completedAt: 1 }).limit(BACKLOG_LIMIT)),
  ]);
  const rows = [...unresolved, ...undelivered].map((row) => backlogRow(row, now)).sort((a, b) => b.ageMs - a.ageMs);
  return { rows, truncated: unresolved.length >= BACKLOG_LIMIT || undelivered.length >= BACKLOG_LIMIT };
}

/**
 * How the orders CREATED in a window fared. An order that never reserved funds (for example, not enough balance) was a
 * refused request, not a failed fulfilment, so it is outside the rate. Orders still running are outside it too, and shown.
 */
export function cohortStats(rows, windowMs, now) {
  const from = now - windowMs;
  const cohort = rows.filter((row) => new Date(row.createdAt).getTime() >= from);
  const attempted = cohort.filter((row) => row.reservedAt);
  const delivered = attempted.filter((row) => row.status === "completed");
  const failed = attempted.filter((row) => FAILED_AFTER_DEBIT.has(row.status));
  const inFlight = attempted.length - delivered.length - failed.length;
  const settled = delivered.length + failed.length;
  const span = (from_, to) => (from_ && to ? new Date(to).getTime() - new Date(from_).getTime() : null);
  return {
    created: cohort.length,
    attempted: attempted.length,
    delivered: delivered.length,
    failed: failed.length,
    inFlight,
    successRate: settled >= RATE_MIN_SAMPLES ? delivered.length / settled : null,
    fulfilment: rawPercentiles(delivered.map((row) => span(row.reservedAt, row.completedAt))),
    provider: rawPercentiles(delivered.map((row) => span(row.provisioningStartedAt, row.provisionedAt))),
  };
}

export async function loadCohorts({ sources, now }) {
  const rows = await timed(sources.purchases.find({ _id: { $gte: objectIdAt(now - DAY) } }).select(COHORT_FIELDS).sort({ _id: -1 }).limit(COHORT_LIMIT));
  const truncated = rows.length >= COHORT_LIMIT;
  const windows = {};
  for (const [name, { ms }] of Object.entries(WINDOWS)) windows[name] = { ...cohortStats(rows, ms, now), truncated };
  return windows;
}

const stage = (id, label, fields) => ({
  id, label, state: "unknown", startedAt: null, completedAt: null, durationMs: null, retries: null, error: null, delayed: null, basis: "recorded", source: null, note: null, ...fields,
});

const toIso = (value) => (value ? new Date(value).toISOString() : null);

function timing(startedAt, completedAt, now, limitMs) {
  const start = startedAt ? new Date(startedAt).getTime() : null;
  const end = completedAt ? new Date(completedAt).getTime() : null;
  const durationMs = start != null && end != null ? Math.max(0, end - start) : null;
  const waited = start != null && end == null ? Math.max(0, now - start) : null;
  const elapsed = durationMs ?? waited;
  return {
    startedAt: toIso(startedAt),
    completedAt: toIso(completedAt),
    durationMs,
    waitingMs: waited,
    delayed: limitMs && elapsed != null ? { limitMs, exceeded: elapsed > limitMs } : null,
  };
}

/**
 * The lifecycle of one order, read off its own record. `basis` is the honest part:
 *   recorded - a stored timestamp or field says so
 *   inferred - concluded from other fields; the note says how
 *   missing  - this record cannot tell, so the stage says so instead of guessing
 * Payment and order meet only at the wallet, so the funding stage is never claimed as a link.
 */
export function traceOrder(row, { events = [], now }) {
  const stages = [];
  const status = row.status;
  const refunding = ["refund_pending", "refunded"].includes(status) || row.refundStatus !== "none" && row.refundStatus != null;
  const providerFailed = refunding && !row.provisionedAt;
  const reservedAt = row.reservedAt || row.walletDebitedAt;

  stages.push(stage("funding", "Payment to wallet", {
    state: "not_linked", basis: "missing", source: "Wallet ledger",
    note: "A wallet is fungible, so no record links one payment to one order. Money Flow Sentinel shows this customer's wallet.",
  }));

  stages.push(stage("created", "Order created", { state: "done", startedAt: toIso(row.createdAt), source: "WalletPurchase.createdAt" }));

  const refused = status === "failed" && !reservedAt;
  stages.push(stage("reservation", "Funds reserved", {
    state: reservedAt ? "done" : refused ? "failed" : "pending",
    ...timing(row.createdAt, reservedAt, now, ORDER_STALE_MS),
    error: refused && row.errorCode ? sanitizeCode(row.errorCode, 80) : null,
    source: "WalletPurchase.reservedAt",
    note: row.walletDebitStatus ? `Debit status: ${row.walletDebitStatus}` : null,
  }));

  if (reservedAt) {
    const providerDone = Boolean(row.provisionedAt);
    const parked = status === "awaiting_provider";
    const ambiguous = status === "manual_review" || status === "uncertain";
    const started = Boolean(row.provisioningStartedAt);
    let state = "pending";
    if (providerDone) state = "done";
    else if (parked) state = "waiting";
    else if (ambiguous || providerFailed) state = "failed";
    stages.push(stage("provider", "WizardXray service request", {
      state,
      ...timing(row.provisioningStartedAt, row.provisionedAt, now, ORDER_STALE_MS),
      retries: row.fulfillmentAttempts || row.retryCount || 0,
      error: row.errorCode ? sanitizeCode(row.errorCode, 80) : null,
      source: "WalletPurchase.provisioningStartedAt, provisionedAt",
      basis: started ? "recorded" : "missing",
      note: parked ? "The provider wallet was proven short of funds. The debit is held and the order waits for an admin."
        : ambiguous ? "The provider's answer was ambiguous. The request is never replayed; a person must confirm the outcome."
          : started ? null : "No provisioning timestamp on this record.",
    }));
  }

  if (refunding) {
    stages.push(stage("refund", "Refund", {
      state: status === "refunded" ? "done" : "pending",
      ...timing(row.refundRequestedAt, row.refundedAt, now, ORDER_SETTLE_MS),
      retries: row.retryCount || 0,
      source: "WalletPurchase.refundRequestedAt, refundedAt",
      note: row.refundReason ? `Reason: ${sanitizeCode(row.refundReason, 80)}` : null,
    }));
  } else if (reservedAt && status !== "failed") {
    stages.push(stage("fulfilment", "Order finalized", {
      state: status === "completed" ? "done" : row.provisionedAt ? "pending" : "skipped",
      ...timing(row.provisionedAt, row.completedAt, now, ORDER_STALE_MS),
      source: "WalletPurchase.completedAt",
      note: status === "completed" ? "The debit was finalized: orders are prepaid, so delivery is the consumption." : null,
    }));
    const notified = Boolean(row.notifiedAt);
    const pending = row.notificationPending === true;
    const legacy = status === "completed" && !notified && !pending;
    stages.push(stage("delivery", "Service sent on Telegram", {
      state: notified ? "done" : pending ? "pending" : legacy ? "unknown" : "skipped",
      ...timing(row.completedAt, row.notifiedAt, now, status === "completed" ? ORDER_SETTLE_MS : null),
      retries: row.notificationAttempts || 0,
      source: "WalletPurchase.notifiedAt",
      basis: legacy ? "missing" : "recorded",
      note: pending && row.notificationNextAt ? `Next retry ${toIso(row.notificationNextAt)}` : legacy ? "This record has no delivery timestamp. It may predate the outbox." : null,
    }));
  }

  return {
    key: `wallet:${row.purchaseId}`,
    orderId: String(row.purchaseId),
    user: maskId(row.telegramId),
    plan: row.planName ? sanitizeText(row.planName, 80) : null,
    status,
    recovery: { status: row.recoveryStatus ?? "none", reason: row.recoveryReason ? sanitizeCode(row.recoveryReason, 80) : null },
    stages,
    transitions: (row.events || []).slice(-30).map((item) => ({ at: toIso(item.at), type: sanitizeCode(item.type, 40), from: item.from ?? null, to: item.to ?? null })),
    events,
    generatedAt: new Date(now).toISOString(),
  };
}

export async function loadTraceRow({ sources, orderId }) {
  return timed(sources.purchases.findOne({ purchaseId: orderId }).select(TRACE_FIELDS));
}

export async function listOrdersFor({ sources, telegramId, limit = 20, now }) {
  const rows = await timed(sources.purchases.find({ telegramId }).select(BACKLOG_FIELDS).sort({ createdAt: -1 }).limit(limit));
  return rows.map((row) => backlogRow(row, now));
}
