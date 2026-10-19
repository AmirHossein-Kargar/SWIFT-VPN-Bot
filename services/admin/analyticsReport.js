/**
 * Admin analytics v2.
 *
 * Principles
 * - All money is TOMAN as stored (no Rial conversion exists in the data model).
 * - Day boundaries are Asia/Tehran (fixed UTC+03:30; Iran has had no DST since
 *   2022). "This month"/"previous month" follow the Jalali calendar when
 *   calendar=jalali (the default) and the Gregorian one otherwise.
 * - Three metric families are kept apart and never summed together:
 *     operational - users, services, payment attempts
 *     financial   - wallet TOP-UPS credited (cash received into wallets)
 *     sales       - SERVICE PURCHASES paid from wallets (what customers bought)
 *   A top-up is not revenue, an invoice is not a payment, and a purchase is not
 *   cash collected.
 * - Counts come from invoice/purchase documents (one document per attempt), never
 *   from webhook logs, so repeated notifications cannot double count.
 * - Cancelled/failed invoices removed by the 24h cleanup remain visible through
 *   their tombstones, so failure counts stay correct for old periods.
 * - Anything the data cannot support is returned in `unavailable` with a reason
 *   instead of a silent zero.
 */
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import PaymentTombstone from "../../models/PaymentTombstone.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";

export const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RANGE_KEYS = Object.freeze(["today", "7d", "30d", "thisMonth", "prevMonth", "custom"]);
const MAX_CUSTOM_DAYS = 366;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;

// ── Time ─────────────────────────────────────────────────────────────────────
export function tehranDayStart(date) {
  const shifted = new Date(date.getTime() + TEHRAN_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TEHRAN_OFFSET_MS);
}

const jalaliFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "numeric", day: "numeric" });
export function jalaliParts(date) {
  const parts = Object.fromEntries(jalaliFormatter.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return { year: parseInt(parts.year, 10), month: parseInt(parts.month, 10), day: parseInt(parts.day, 10) };
}

/** Start (Tehran midnight, as an instant) of the calendar month containing `date`. */
export function monthStart(date, calendar = "jalali") {
  const dayStart = tehranDayStart(date);
  if (calendar === "gregorian") {
    const shifted = new Date(dayStart.getTime() + TEHRAN_OFFSET_MS);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - TEHRAN_OFFSET_MS);
  }
  const { day } = jalaliParts(new Date(dayStart.getTime() + 60_000));
  return new Date(dayStart.getTime() - (day - 1) * DAY_MS);
}

/** First instant of the month after the one starting at `start`. */
export function nextMonthStart(start, calendar = "jalali") {
  if (calendar === "gregorian") {
    const shifted = new Date(start.getTime() + TEHRAN_OFFSET_MS);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - TEHRAN_OFFSET_MS);
  }
  let cursor = new Date(start.getTime() + 27 * DAY_MS);
  for (let i = 0; i < 6; i += 1) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (jalaliParts(new Date(cursor.getTime() + 60_000)).day === 1) return cursor;
  }
  throw new Error("Could not find the next Jalali month boundary");
}

function parseTehranDate(text, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ""));
  if (!match) throw new AdminServiceError(`«${label}» باید به شکل YYYY-MM-DD باشد.`, { status: 400, code: "invalid_date" });
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new AdminServiceError(`«${label}» تاریخ معتبری نیست.`, { status: 400, code: "invalid_date" });
  }
  return new Date(utc.getTime() - TEHRAN_OFFSET_MS);
}

/**
 * Resolve a named or custom range to half-open [from, to) instants plus the
 * "preceding equivalent period". For a month that is still running, the
 * previous month is cut to the same number of elapsed days so the comparison is fair.
 */
export function resolveRange({ range = "30d", from: fromText, to: toText, calendar = "jalali", now = new Date() } = {}) {
  if (!RANGE_KEYS.includes(range)) throw new AdminServiceError("بازهٔ زمانی نامعتبر است.", { status: 400, code: "invalid_range" });
  if (!["jalali", "gregorian"].includes(calendar)) calendar = "jalali";
  const today = tehranDayStart(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  let from;
  let to;
  let previous;

  if (range === "today") {
    from = today; to = tomorrow;
    previous = { from: new Date(from.getTime() - DAY_MS), to: from };
  } else if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    from = new Date(tomorrow.getTime() - days * DAY_MS); to = tomorrow;
    previous = { from: new Date(from.getTime() - days * DAY_MS), to: from };
  } else if (range === "thisMonth") {
    from = monthStart(now, calendar); to = tomorrow;
    const prevFrom = monthStart(new Date(from.getTime() - DAY_MS), calendar);
    previous = { from: prevFrom, to: new Date(Math.min(from.getTime(), prevFrom.getTime() + (to.getTime() - from.getTime()))) };
  } else if (range === "prevMonth") {
    to = monthStart(now, calendar);
    from = monthStart(new Date(to.getTime() - DAY_MS), calendar);
    const prevFrom = monthStart(new Date(from.getTime() - DAY_MS), calendar);
    previous = { from: prevFrom, to: from };
  } else {
    from = parseTehranDate(fromText, "from");
    to = new Date(parseTehranDate(toText, "to").getTime() + DAY_MS);
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS);
    if (days < 1) throw new AdminServiceError("تاریخ پایان باید بعد از تاریخ شروع باشد.", { status: 400, code: "invalid_range" });
    if (days > MAX_CUSTOM_DAYS) throw new AdminServiceError(`حداکثر بازهٔ سفارشی ${MAX_CUSTOM_DAYS} روز است.`, { status: 400, code: "range_too_large" });
    previous = { from: new Date(from.getTime() - days * DAY_MS), to: from };
  }
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  return { key: range, calendar, from, to, previous, days, endsNow: to.getTime() >= tomorrow.getTime() };
}

// ── Comparison ───────────────────────────────────────────────────────────────
/** Percentage change that never divides by zero. */
export function compare(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return { pct: null, delta: null, state: "unavailable" };
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return { pct: null, delta: null, state: "unavailable" };
  const delta = cur - prev;
  if (prev === 0) return { pct: null, delta, state: cur === 0 ? "flat" : "no_baseline" };
  const pct = Math.round((delta / Math.abs(prev)) * 10_000) / 10_000;
  return { pct, delta, state: delta === 0 ? "flat" : delta > 0 ? "up" : "down" };
}

// ── Status classification (single source of truth for every payment metric) ──
export const PAYMENT_OUTCOMES = Object.freeze(["successful", "settling", "pending", "failed", "cancelled", "expired", "partial", "refunded", "review", "other"]);

/**
 * successful: provider-confirmed AND wallet credited.   settling: confirmed, not yet credited.
 * pending: awaiting payment.   partial: partially paid.   refunded: refunded/reversed.
 * review: needs manual recovery.   failed/cancelled/expired: definitive negative outcomes.
 */
export function classifyPayment(provider, status, { credited = false, recovery = false } = {}) {
  const value = String(status ?? "").toLowerCase();
  if (recovery) return "review";
  if (provider === "nowpayments") {
    if (value === "finished") return credited ? "successful" : "settling";
    if (["creating", "pending", "waiting", "confirming", "confirmed", "sending"].includes(value)) return "pending";
    if (value === "creation_unknown") return "review";
    if (value === "partially_paid") return "partial";
    if (value === "refunded") return "refunded";
    if (value === "failed" || value === "creation_failed") return "failed";
    if (value === "expired") return "expired";
  } else if (provider === "bank") {
    if (["confirmed", "paid"].includes(value)) return credited ? "successful" : "settling";
    if (["unpaid", "pending", "waiting_for_approval"].includes(value)) return "pending";
    if (value === "rejected") return "failed";
  } else if (provider === "trx") {
    if (value === "paid") return credited ? "successful" : "settling";
    if (value === "unpaid") return "pending";
    if (value === "rejected") return "failed";
  } else if (provider === "hooshpay") {
    if (value === "paid") return credited ? "successful" : "settling";
    if (value === "pending") return "pending";
    if (value === "reversed") return "refunded";
    if (value === "failed") return "failed";
    if (value === "cancelled" || value === "canceled") return "cancelled";
    if (value === "expired") return "expired";
  }
  return "other";
}

/** Success rate over decided attempts only: successful / (successful + failed + cancelled + expired). */
export function successRate(outcomes) {
  const decided = (outcomes.successful || 0) + (outcomes.failed || 0) + (outcomes.cancelled || 0) + (outcomes.expired || 0);
  return decided === 0 ? null : (outcomes.successful || 0) / decided;
}

// ── Data collection ──────────────────────────────────────────────────────────
const PROVIDERS = Object.freeze([
  { id: "hooshpay", model: HooshPayInvoice, amountField: "amount", paidStatuses: ["paid"] },
  { id: "nowpayments", model: NowPaymentsInvoice, amountField: "amountToman", paidStatuses: ["finished"] },
  { id: "trx", model: CryptoInvoice, amountField: "amount", paidStatuses: ["paid"] },
  { id: "bank", model: bankInvoice, amountField: "amount", paidStatuses: ["confirmed", "paid"] },
]);

function bucketExpr(field, from, bucketMs) {
  return { $floor: { $divide: [{ $subtract: [`$${field}`, from] }, bucketMs] } };
}

async function collectTopups(from, to, bucketMs, withSeries) {
  const results = await Promise.all(PROVIDERS.map(async (p) => {
    const match = { status: { $in: p.paidStatuses }, balanceCredited: true, balanceCreditedAt: { $gte: from, $lt: to } };
    const [total, series] = await Promise.all([
      p.model.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: { $ifNull: [`$${p.amountField}`, 0] } }, count: { $sum: 1 } } }]),
      withSeries
        ? p.model.aggregate([{ $match: match }, { $group: { _id: bucketExpr("balanceCreditedAt", from, bucketMs), amount: { $sum: { $ifNull: [`$${p.amountField}`, 0] } }, count: { $sum: 1 } } }])
        : Promise.resolve([]),
    ]);
    return { provider: p.id, amount: Number(total[0]?.amount || 0), count: Number(total[0]?.count || 0), series };
  }));
  const crypto = await NowPaymentsInvoice.aggregate([
    { $match: { status: "finished", balanceCredited: true, balanceCreditedAt: { $gte: from, $lt: to } } },
    { $group: { _id: { ticker: "$ticker", network: "$network" }, amount: { $sum: { $ifNull: ["$amountToman", 0] } }, count: { $sum: 1 } } },
    { $sort: { amount: -1 } },
    { $limit: 25 },
  ]);
  return { providers: results, crypto };
}

async function collectAttempts(from, to) {
  const rows = [];
  await Promise.all(PROVIDERS.map(async (p) => {
    const groups = await p.model.aggregate([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: { status: "$status", credited: { $ifNull: ["$balanceCredited", false] }, recovery: { $eq: ["$recoveryStatus", "required"] } }, count: { $sum: 1 } } },
    ]);
    for (const g of groups) rows.push({ provider: p.id, status: g._id.status, credited: Boolean(g._id.credited), recovery: Boolean(g._id.recovery), count: Number(g.count) });
  }));
  // Removed-by-cleanup invoices stay countable through their tombstones.
  const tombstones = await PaymentTombstone.aggregate([
    { $match: { invoiceCreatedAt: { $gte: from, $lt: to } } },
    { $group: { _id: { provider: "$provider", status: "$finalStatus" }, count: { $sum: 1 } } },
  ]);
  for (const t of tombstones) rows.push({ provider: t._id.provider, status: t._id.status, credited: false, recovery: false, count: Number(t.count), fromTombstone: true });
  return rows;
}

async function collectRefunds(from, to) {
  const [hoosh, nowPayments] = await Promise.all([
    HooshPayInvoice.aggregate([{ $match: { status: "reversed", createdAt: { $gte: from, $lt: to } } }, { $group: { _id: null, amount: { $sum: { $ifNull: ["$amount", 0] } }, count: { $sum: 1 } } }]),
    NowPaymentsInvoice.aggregate([{ $match: { status: "refunded", createdAt: { $gte: from, $lt: to } } }, { $group: { _id: null, amount: { $sum: { $ifNull: ["$amountToman", 0] } }, count: { $sum: 1 } } }]),
  ]);
  return {
    amount: Number(hoosh[0]?.amount || 0) + Number(nowPayments[0]?.amount || 0),
    count: Number(hoosh[0]?.count || 0) + Number(nowPayments[0]?.count || 0),
  };
}

async function collectSales(from, to, bucketMs, withSeries) {
  const completedMatch = { status: "completed", completedAt: { $gte: from, $lt: to } };
  const [total, plans, series, refunds] = await Promise.all([
    WalletPurchase.aggregate([{ $match: completedMatch }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    WalletPurchase.aggregate([
      { $match: completedMatch },
      { $group: { _id: "$planId", name: { $first: "$planName" }, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      { $sort: { count: -1, amount: -1 } },
      { $limit: 10 },
    ]),
    withSeries
      ? WalletPurchase.aggregate([{ $match: completedMatch }, { $group: { _id: bucketExpr("completedAt", from, bucketMs), amount: { $sum: "$amount" }, count: { $sum: 1 } } }])
      : Promise.resolve([]),
    WalletPurchase.aggregate([
      { $match: { status: "refunded", refundedAt: { $gte: from, $lt: to } } },
      { $group: { _id: null, amount: { $sum: { $ifNull: ["$refundAmount", "$amount"] } }, count: { $sum: 1 } } },
    ]),
  ]);
  return {
    amount: Number(total[0]?.amount || 0),
    count: Number(total[0]?.count || 0),
    plans: plans.map((p) => ({ planId: p._id, name: p.name || p._id, count: Number(p.count), amount: Number(p.amount) })),
    series,
    refundAmount: Number(refunds[0]?.amount || 0),
    refundCount: Number(refunds[0]?.count || 0),
  };
}

async function collectUsers(from, to, prevFrom, now) {
  const [total, created, active, buyers, newSeries, balance] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: from, $lt: to } }),
    User.countDocuments({ isBanned: { $ne: true }, lastActivityAt: { $gte: from, $lt: to } }),
    // Distinct buyers in this and the previous period in ONE pass (no id lists in memory).
    WalletPurchase.aggregate([
      { $match: { status: "completed", completedAt: { $gte: prevFrom, $lt: to } } },
      { $group: { _id: "$telegramId", cur: { $max: { $cond: [{ $gte: ["$completedAt", from] }, 1, 0] } }, prev: { $max: { $cond: [{ $lt: ["$completedAt", from] }, 1, 0] } } } },
      { $group: { _id: null, current: { $sum: "$cur" }, previous: { $sum: "$prev" }, retained: { $sum: { $cond: [{ $and: [{ $eq: ["$cur", 1] }, { $eq: ["$prev", 1] }] }, 1, 0] } } } },
    ]),
    User.aggregate([{ $match: { createdAt: { $gte: from, $lt: to } } }, { $group: { _id: bucketExpr("createdAt", from, DAY_MS), count: { $sum: 1 } } }]),
    User.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ["$balance", 0] } }, holders: { $sum: { $cond: [{ $gt: ["$balance", 0] }, 1, 0] } } } }]),
  ]);
  const expiring = await WalletPurchase.countDocuments({ status: "completed", revokedAt: null, expiresAt: { $gte: now, $lt: new Date(now.getTime() + 7 * DAY_MS) } });
  const activeServices = await WalletPurchase.countDocuments({ status: "completed", revokedAt: null, expiresAt: { $gte: now } });
  return {
    total, created, active, newSeries,
    buyers: { current: Number(buyers[0]?.current || 0), previous: Number(buyers[0]?.previous || 0), retained: Number(buyers[0]?.retained || 0) },
    walletBalance: { total: Number(balance[0]?.total || 0), holders: Number(balance[0]?.holders || 0) },
    expiring, activeServices,
  };
}

/** Collect every raw fact for one period; no interpretation happens here. */
export async function collectPeriod({ from, to, prevFrom, bucketMs, withSeries, now }) {
  const [topups, attempts, refunds, sales, users] = await Promise.all([
    collectTopups(from, to, bucketMs, withSeries),
    collectAttempts(from, to),
    collectRefunds(from, to),
    collectSales(from, to, bucketMs, withSeries),
    prevFrom ? collectUsers(from, to, prevFrom, now) : Promise.resolve(null),
  ]);
  return { topups, attempts, refunds, sales, users };
}

// ── Assembly (pure) ──────────────────────────────────────────────────────────
export function summarizeAttempts(rows) {
  const outcomes = Object.fromEntries(PAYMENT_OUTCOMES.map((key) => [key, 0]));
  const byProvider = {};
  let total = 0;
  for (const row of rows) {
    const outcome = classifyPayment(row.provider, row.status, { credited: row.credited, recovery: row.recovery });
    outcomes[outcome] += row.count;
    total += row.count;
    byProvider[row.provider] ??= Object.fromEntries(PAYMENT_OUTCOMES.map((key) => [key, 0]));
    byProvider[row.provider][outcome] += row.count;
  }
  return { total, outcomes, byProvider, successRate: successRate(outcomes) };
}

function topupTotals(topups) {
  return topups.providers.reduce((acc, p) => ({ amount: acc.amount + p.amount, count: acc.count + p.count }), { amount: 0, count: 0 });
}

export function assembleReport({ current, previous, range, now, granularity, cache = { cached: false, ageSeconds: 0 } }) {
  const cAttempts = summarizeAttempts(current.attempts);
  const pAttempts = summarizeAttempts(previous.attempts);
  const cTop = topupTotals(current.topups);
  const pTop = topupTotals(previous.topups);
  const cSales = current.sales;
  const pSales = previous.sales;
  const users = current.users;

  const kpi = (id, group, value, prev, extra = {}) => ({
    id, group, value, previous: prev, change: prev === undefined || prev === null || value === null ? { pct: null, delta: null, state: "unavailable" } : compare(value, prev), ...extra,
  });
  const ratio = (a, b) => (b ? a / b : null);

  const kpis = [
    // operational
    kpi("users_total", "operational", users.total, undefined, { unit: "count" }),
    kpi("users_new", "operational", users.created, previous.users?.created, { unit: "count" }),
    kpi("users_active", "operational", users.active, previous.users?.active, { unit: "count", exact: range.endsNow }),
    kpi("services_active", "operational", users.activeServices, undefined, { unit: "count" }),
    kpi("services_activated", "operational", cSales.count, pSales.count, { unit: "count" }),
    kpi("services_expiring_7d", "operational", users.expiring, undefined, { unit: "count" }),
    kpi("payment_attempts", "operational", cAttempts.total, pAttempts.total, { unit: "count" }),
    kpi("payments_successful", "operational", cAttempts.outcomes.successful, pAttempts.outcomes.successful, { unit: "count" }),
    kpi("payment_success_rate", "operational", cAttempts.successRate, pAttempts.successRate, { unit: "ratio" }),
    kpi("payments_failed", "operational", cAttempts.outcomes.failed, pAttempts.outcomes.failed, { unit: "count" }),
    kpi("payments_cancelled", "operational", cAttempts.outcomes.cancelled, pAttempts.outcomes.cancelled, { unit: "count" }),
    kpi("payments_review", "operational", cAttempts.outcomes.review + cAttempts.outcomes.partial, pAttempts.outcomes.review + pAttempts.outcomes.partial, { unit: "count" }),
    kpi("buyers_unique", "operational", users.buyers.current, previous.users?.buyers.current, { unit: "count" }),
    kpi("buyer_retention", "operational", ratio(users.buyers.retained, users.buyers.previous), undefined, { unit: "ratio" }),
    // financial: wallet top-ups
    kpi("topups_gross", "financial", cTop.amount, pTop.amount, { unit: "toman" }),
    kpi("topups_count", "financial", cTop.count, pTop.count, { unit: "count" }),
    kpi("topups_average", "financial", ratio(cTop.amount, cTop.count), ratio(pTop.amount, pTop.count), { unit: "toman" }),
    kpi("refunds_reversals", "financial", current.refunds.amount, previous.refunds.amount, { unit: "toman" }),
    kpi("refunds_reversals_count", "financial", current.refunds.count, previous.refunds.count, { unit: "count" }),
    kpi("topups_net", "financial", cTop.amount - current.refunds.amount, pTop.amount - previous.refunds.amount, { unit: "toman" }),
    kpi("wallet_balance_total", "financial", users.walletBalance.total, undefined, { unit: "toman" }),
    // sales: service purchases paid from wallets
    kpi("sales_gross", "sales", cSales.amount, pSales.amount, { unit: "toman" }),
    kpi("sales_refunded", "sales", cSales.refundAmount, pSales.refundAmount, { unit: "toman" }),
    kpi("sales_net", "sales", cSales.amount - cSales.refundAmount, pSales.amount - pSales.refundAmount, { unit: "toman" }),
    kpi("sales_average_order", "sales", ratio(cSales.amount, cSales.count), ratio(pSales.amount, pSales.count), { unit: "toman" }),
  ];

  const bucketCount = Math.ceil((range.to.getTime() - range.from.getTime()) / granularity.bucketMs);
  const series = Array.from({ length: bucketCount }, (_, index) => {
    const start = new Date(range.from.getTime() + index * granularity.bucketMs);
    const pick = (rows) => rows.find((row) => Number(row._id) === index);
    const topups = current.topups.providers.reduce((sum, p) => sum + Number(pick(p.series)?.amount || 0), 0);
    return {
      start: start.toISOString(),
      topups,
      sales: Number(pick(current.sales.series)?.amount || 0),
      orders: Number(pick(current.sales.series)?.count || 0),
      newUsers: Number(pick(users.newSeries)?.count || 0),
    };
  });

  return {
    generatedAt: now.toISOString(),
    cache,
    timezone: "Asia/Tehran",
    unit: "toman",
    calendar: range.calendar,
    range: {
      key: range.key,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      days: range.days,
      previous: { from: range.previous.from.toISOString(), to: range.previous.to.toISOString() },
    },
    granularity: { bucketMs: granularity.bucketMs, label: granularity.label },
    kpis,
    series,
    attempts: { current: cAttempts, previous: pAttempts },
    distributions: {
      providers: current.topups.providers.map((p) => ({ provider: p.provider, amount: p.amount, count: p.count })),
      crypto: current.topups.crypto.map((c) => ({ ticker: c._id?.ticker || null, network: c._id?.network || null, amount: Number(c.amount), count: Number(c.count) })),
      plans: cSales.plans,
    },
    definitions: DEFINITIONS,
    unavailable: [
      { id: "renewal_trends", reason: "The WizardXray integration has no renewal operation and purchases do not record renewals, so renewal trends cannot be computed." },
      { id: "retention_curve", reason: "Only repeat-purchase retention between the selected and the previous period is available; per-cohort retention needs per-day activity history that is not stored." },
      ...(range.endsNow ? [] : [{ id: "users_active_exact", reason: "Only the most recent activity time per user is stored, so 'active users' for a period that already ended is a lower bound." }]),
      { id: "refund_dates", reason: "Refunds and reversals of top-ups are dated by invoice creation (HooshPay/NOWPayments store no refund timestamp)." },
    ],
  };
}

export const DEFINITIONS = Object.freeze({
  users_total: "All registered users (all time).",
  users_new: "Users whose account was created in the period.",
  users_active: "Non-blocked users whose last recorded activity falls inside the period.",
  services_active: "Completed, non-revoked purchases whose expiry is in the future.",
  services_activated: "Purchases completed (service delivered) in the period, by completion time.",
  services_expiring_7d: "Active services expiring within the next 7 days.",
  payment_attempts: "Invoices created in the period across all providers, one per invoice (webhook repeats are not counted), plus invoices removed by the 24h cleanup.",
  payments_successful: "Attempts that were provider-confirmed AND credited to the wallet.",
  payment_success_rate: "successful / (successful + failed + cancelled + expired). Pending, partially paid, refunded and manual-review attempts are excluded because they are not decided.",
  payments_failed: "Attempts that ended failed or rejected (including creation_failed).",
  payments_cancelled: "Attempts cancelled before payment.",
  payments_review: "Partially paid attempts and attempts flagged for manual recovery.",
  buyers_unique: "Distinct users with at least one completed purchase in the period.",
  buyer_retention: "Share of the previous period's buyers who bought again in this period.",
  topups_gross: "Wallet top-ups credited in the period (by credit time). This is money received into wallets, NOT revenue.",
  topups_count: "Number of credited top-ups.",
  topups_average: "Gross top-ups / number of credited top-ups.",
  refunds_reversals: "Value of top-up invoices ending reversed (HooshPay) or refunded (NOWPayments), by invoice creation date.",
  refunds_reversals_count: "Number of reversed/refunded top-up invoices.",
  topups_net: "Gross top-ups minus refunds/reversals for the same period. Partial refunds are not stored, so this uses full invoice amounts.",
  wallet_balance_total: "Sum of all wallet balances now (money held on behalf of users).",
  sales_gross: "Value of services bought from wallets and delivered in the period (by completion time).",
  sales_refunded: "Purchases refunded to the wallet in the period (by refund time).",
  sales_net: "Gross sales minus refunded purchases.",
  sales_average_order: "Gross sales / completed purchases.",
});

// ── Caching ──────────────────────────────────────────────────────────────────
const cache = new Map();
export function clearAnalyticsCacheForTests() { cache.clear(); }

export function granularityFor(days) {
  if (days <= 92) return { bucketMs: DAY_MS, label: "day" };
  if (days <= 366) return { bucketMs: 7 * DAY_MS, label: "week" };
  return { bucketMs: 30 * DAY_MS, label: "month" };
}

export async function getAnalyticsReport({ actorId, query = {}, now = new Date(), refresh = false, collect = collectPeriod } = {}) {
  assertAdminUser(actorId);
  const range = resolveRange({ range: query.range, from: query.from, to: query.to, calendar: query.calendar, now });
  const granularity = granularityFor(range.days);
  const key = `${range.key}|${range.from.toISOString()}|${range.to.toISOString()}|${range.calendar}`;
  const hit = cache.get(key);
  if (!refresh && hit && now.getTime() - hit.at < CACHE_TTL_MS) {
    return { ...hit.report, cache: { cached: true, ageSeconds: Math.round((now.getTime() - hit.at) / 1000) } };
  }
  const [current, previous] = await Promise.all([
    collect({ from: range.from, to: range.to, prevFrom: range.previous.from, bucketMs: granularity.bucketMs, withSeries: true, now }),
    collect({ from: range.previous.from, to: range.previous.to, prevFrom: new Date(range.previous.from.getTime() - (range.previous.to.getTime() - range.previous.from.getTime())), bucketMs: granularity.bucketMs, withSeries: false, now }),
  ]);
  const report = assembleReport({ current, previous, range, now, granularity });
  cache.set(key, { at: now.getTime(), report });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return report;
}

// ── CSV export ───────────────────────────────────────────────────────────────
/** Neutralises spreadsheet formulas in text cells; real numbers are written as-is. */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value).replace(/\r?\n|\r/g, " ");
  if (/^[=+\-@\t\r]/.test(text) || /^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportToCsv(report) {
  const lines = [["section", "id", "group", "value", "previous", "change_pct", "unit", "definition"].join(",")];
  for (const item of report.kpis) {
    lines.push(["kpi", item.id, item.group, item.value, item.previous, item.change.pct, item.unit, report.definitions[item.id]].map(csvCell).join(","));
  }
  lines.push("");
  lines.push(["series_start_iso", "topups_toman", "sales_toman", "orders", "new_users"].join(","));
  for (const row of report.series) lines.push([row.start, row.topups, row.sales, row.orders, row.newUsers].map(csvCell).join(","));
  lines.push("");
  lines.push(["plan_id", "plan_name", "purchases", "amount_toman"].join(","));
  for (const plan of report.distributions.plans) lines.push([plan.planId, plan.name, plan.count, plan.amount].map(csvCell).join(","));
  lines.push("");
  lines.push(["provider", "topups_toman", "topups_count"].join(","));
  for (const p of report.distributions.providers) lines.push([p.provider, p.amount, p.count].map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
