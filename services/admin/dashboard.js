import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import { getProviderAccount } from "../wizardAccount.js";
import { assertAdminUser } from "./authorization.js";
import { listPayments } from "./payments.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_ORDER_STATES = ["reserving", "reserved", "provisioning", "provisioned", "refund_pending"];
const FAILED_PROVISION_STATES = ["failed", "uncertain", "manual_review"];

function utcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcWeekStart(date) {
  const start = utcDayStart(date);
  const offset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  return start;
}

function utcMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

async function sumModel(Model, match, amountField = "amount") {
  const [result] = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, amount: { $sum: { $ifNull: [`$${amountField}`, 0] } }, count: { $sum: 1 } } },
  ]).allowDiskUse(true);
  return { amount: Number(result?.amount || 0), count: Number(result?.count || 0) };
}

function paidMatch(from, to, timeField = "createdAt") {
  return {
    status: "paid",
    balanceCredited: true,
    [timeField]: { $gte: from, $lt: to },
  };
}

async function revenueForPeriod(from, to) {
  const [hoosh, nowPayments, crypto, bank] = await Promise.all([
    sumModel(HooshPayInvoice, paidMatch(from, to, "balanceCreditedAt")),
    sumModel(NowPaymentsInvoice, {
      status: "finished",
      balanceCredited: true,
      balanceCreditedAt: { $gte: from, $lt: to },
    }, "amountToman"),
    sumModel(CryptoInvoice, paidMatch(from, to, "balanceCreditedAt")),
    sumModel(bankInvoice, {
      status: { $in: ["confirmed", "paid"] },
      balanceCredited: true,
      balanceCreditedAt: { $gte: from, $lt: to },
    }),
  ]);
  return {
    amount: hoosh.amount + nowPayments.amount + crypto.amount + bank.amount,
    count: hoosh.count + nowPayments.count + crypto.count + bank.count,
    byProvider: { hooshpay: hoosh.amount, nowpayments: nowPayments.amount, trx: crypto.amount, bank: bank.amount },
  };
}

/** Tracked VPN orders split by expiry in one pass over the completed, non-revoked orders. */
async function knownVpnCounts(now) {
  const [row] = await WalletPurchase.aggregate([
    { $match: { status: "completed", revokedAt: null } },
    {
      $addFields: {
        effectiveExpiry: {
          $ifNull: [
            "$expiresAt",
            { $add: [{ $ifNull: ["$completedAt", "$createdAt"] }, { $multiply: [{ $ifNull: ["$days", 0] }, DAY_MS] }] },
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        active: { $sum: { $cond: [{ $gt: ["$effectiveExpiry", now] }, 1, 0] } },
        // An order without a computable expiry date is neither active nor expired.
        expired: { $sum: { $cond: [{ $and: [{ $eq: [{ $type: "$effectiveExpiry" }, "date"] }, { $lte: ["$effectiveExpiry", now] }] }, 1, 0] } },
      },
    },
  ]).allowDiskUse(true);
  return { active: Number(row?.active || 0), expired: Number(row?.expired || 0) };
}

async function topPackages(from) {
  return WalletPurchase.aggregate([
    { $match: { status: "completed", completedAt: { $gte: from } } },
    { $group: { _id: "$planId", name: { $first: "$planName" }, count: { $sum: 1 }, revenue: { $sum: "$amount" } } },
    { $sort: { count: -1, revenue: -1 } },
    { $limit: 8 },
    { $project: { _id: 0, productId: "$_id", name: 1, count: 1, revenue: 1 } },
  ]).allowDiskUse(true);
}

async function timeSeries(Model, match, dateField, amountField = null, keyName = "count") {
  const project = {
    day: {
      $dateToString: {
        format: "%Y-%m-%d",
        date: { $ifNull: [`$${dateField}`, "$createdAt"] },
        timezone: "UTC",
      },
    },
  };
  if (amountField) project.value = { $ifNull: [`$${amountField}`, 0] };
  const group = { _id: "$day", [keyName]: { $sum: amountField ? "$value" : 1 } };
  return Model.aggregate([
    { $match: match },
    { $project: project },
    { $group: group },
    { $sort: { _id: 1 } },
  ]).allowDiskUse(true);
}

function fillDays(from, count) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(from.getTime() + index * DAY_MS);
    return date.toISOString().slice(0, 10);
  });
}

function mergeSeries(days, groups, key) {
  const values = new Map();
  for (const group of groups) values.set(group._id, Number(group[key] || 0));
  return days.map((date) => ({ date, value: values.get(date) || 0 }));
}

async function dashboardCharts(now) {
  const dayCount = 30;
  const from = new Date(utcDayStart(now).getTime() - (dayCount - 1) * DAY_MS);
  const dayMatch = { $gte: from, $lt: new Date(utcDayStart(now).getTime() + DAY_MS) };
  const [hooshRevenue, nowPaymentsRevenue, cryptoRevenue, bankRevenue, orders, newUsers, vpnOrders, popularPackages] = await Promise.all([
    timeSeries(HooshPayInvoice, { status: "paid", balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amount", "revenue"),
    timeSeries(NowPaymentsInvoice, { status: "finished", balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amountToman", "revenue"),
    timeSeries(CryptoInvoice, { status: "paid", balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amount", "revenue"),
    timeSeries(bankInvoice, { status: { $in: ["confirmed", "paid"] }, balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amount", "revenue"),
    timeSeries(WalletPurchase, { createdAt: dayMatch }, "createdAt", null, "orders"),
    timeSeries(User, { createdAt: dayMatch }, "createdAt", null, "users"),
    timeSeries(WalletPurchase, { status: "completed", completedAt: dayMatch }, "completedAt", null, "activeVpns"),
    topPackages(from),
  ]);
  const days = fillDays(from, dayCount);
  const revenueGroups = new Map();
  for (const group of [...hooshRevenue, ...nowPaymentsRevenue, ...cryptoRevenue, ...bankRevenue]) {
    revenueGroups.set(group._id, (revenueGroups.get(group._id) || 0) + Number(group.revenue || 0));
  }
  return {
    revenue: mergeSeries(days, [...revenueGroups].map(([_id, revenue]) => ({ _id, revenue })), "revenue"),
    orders: mergeSeries(days, orders, "orders"),
    newUsers: mergeSeries(days, newUsers, "users"),
    activeVpns: mergeSeries(days, vpnOrders, "activeVpns"),
    popularPackages: popularPackages.map((item) => ({ ...item, revenue: Number(item.revenue || 0) })),
  };
}

export async function getDashboardMetrics({ now = new Date() } = {}) {
  const startToday = utcDayStart(now);
  const startWeek = utcWeekStart(now);
  const startMonth = utcMonthStart(now);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

  const [
    totalUsers,
    activeUsers,
    newUsers,
    revenueToday,
    revenueWeek,
    revenueMonth,
    ordersTotal,
    ordersToday,
    ordersWeek,
    ordersMonth,
    pendingHoosh,
    pendingNowPayments,
    pendingBank,
    pendingCrypto,
    pendingOrders,
    failedHoosh,
    failedNowPayments,
    failedBank,
    failedCrypto,
    failedProvisioning,
    vpnCounts,
    providerAccount,
    charts,
    completedOrders,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ isBanned: { $ne: true }, lastActivityAt: { $gte: thirtyDaysAgo } }),
    User.countDocuments({ createdAt: { $gte: startToday } }),
    revenueForPeriod(startToday, new Date(startToday.getTime() + DAY_MS)),
    revenueForPeriod(startWeek, now),
    revenueForPeriod(startMonth, now),
    WalletPurchase.countDocuments({}),
    WalletPurchase.countDocuments({ createdAt: { $gte: startToday } }),
    WalletPurchase.countDocuments({ createdAt: { $gte: startWeek } }),
    WalletPurchase.countDocuments({ createdAt: { $gte: startMonth } }),
    HooshPayInvoice.countDocuments({ status: "pending" }),
    NowPaymentsInvoice.countDocuments({ status: { $in: ["creating", "creation_unknown", "pending", "waiting", "confirming", "confirmed", "sending", "partially_paid"] } }),
    bankInvoice.countDocuments({ status: "waiting_for_approval", paymentType: "bank" }),
    CryptoInvoice.countDocuments({ status: "unpaid" }),
    WalletPurchase.countDocuments({ status: { $in: PENDING_ORDER_STATES } }),
    HooshPayInvoice.countDocuments({ status: { $in: ["failed", "reversed"] } }),
    NowPaymentsInvoice.countDocuments({ status: { $in: ["failed", "refunded", "creation_failed"] } }),
    bankInvoice.countDocuments({ status: "rejected" }),
    CryptoInvoice.countDocuments({ status: "rejected" }),
    WalletPurchase.countDocuments({ status: { $in: FAILED_PROVISION_STATES } }),
    knownVpnCounts(now),
    getProviderAccount(),
    dashboardCharts(now),
    sumModel(WalletPurchase, { status: "completed", completedAt: { $gte: startMonth } }),
  ]);

  const activeVpnCount = providerAccount?.services.active ?? Number.NaN;
  const totalPanelVpns = providerAccount?.services.total ?? Number.NaN;
  const failedPayments = failedHoosh + failedNowPayments + failedBank + failedCrypto;
  const pendingPayments = pendingHoosh + pendingNowPayments + pendingBank + pendingCrypto;
  const failedPaymentDenominator = failedPayments + pendingPayments + revenueMonth.count;

  return {
    generatedAt: now.toISOString(),
    definitions: {
      activeUsers: "Non-blocked accounts seen by the bot in the last 30 days; tracking starts with this release.",
      activeVpns: providerAccount ? "WizardXray active-service count." : "Unavailable while WizardXray status cannot be checked.",
      expiredVpns: "Expired, non-revoked VPN orders with a tracked expiry date.",
      revenue: "Wallet top-ups actually credited to user wallets; product purchases are counted separately as orders.",
    },
    metrics: {
      totalUsers,
      activeUsers,
      newUsersToday: newUsers,
      activeVpns: Number.isSafeInteger(activeVpnCount) && activeVpnCount >= 0 ? activeVpnCount : null,
      expiredVpns: vpnCounts.expired,
      trackedActiveVpns: vpnCounts.active,
      orders: { total: ordersTotal, today: ordersToday, week: ordersWeek, month: ordersMonth },
      revenue: { today: revenueToday.amount, week: revenueWeek.amount, month: revenueMonth.amount },
      pendingPayments,
      failedPayments,
      failedProvisioning,
      pendingOrders,
      totalPanelVpns: Number.isSafeInteger(totalPanelVpns) && totalPanelVpns >= 0 ? totalPanelVpns : null,
      averageOrderValueMonth: completedOrders.count ? Math.round(completedOrders.amount / completedOrders.count) : 0, // completed VPN orders this month
      failedPaymentRate: failedPaymentDenominator ? failedPayments / failedPaymentDenominator : 0,
    },
    revenueByProviderMonth: revenueMonth.byProvider,
    charts,
  };
}

const PULSE_ACTIVITY = 8;
const PULSE_TTL_MS = 15_000;
let pulseCache = null;
let pulseInFlight = null;

/** The latest payments and orders in one list. Amounts, statuses and ids only: service links never leave the database here. */
async function recentActivity(actorId) {
  const [payments, orders] = await Promise.all([
    listPayments({ actorId, query: { page: 1, pageSize: PULSE_ACTIVITY } }),
    WalletPurchase.find({}).sort({ createdAt: -1 }).limit(PULSE_ACTIVITY).select("purchaseId telegramId planName planId amount status createdAt").lean(),
  ]);
  const rows = [
    // The payments list includes wallet orders as a provider of their own. They are listed below by plan name, once.
    ...payments.items.filter((payment) => payment.provider !== "wallet").map((payment) => ({ id: `payment:${payment.key}`, kind: "payment", title: payment.providerLabel, userId: String(payment.userId), amount: payment.amount, status: payment.status, at: payment.createdAt })),
    ...orders.map((order) => ({ id: `order:${order.purchaseId}`, kind: "order", title: order.planName || order.planId, userId: String(order.telegramId), amount: order.amount, status: order.status, at: order.createdAt })),
  ];
  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, PULSE_ACTIVITY);
}

function healthSummary(snapshot) {
  if (!snapshot?.components?.length) return { state: "unknown", reason: "The monitor has not reported yet.", openIncidents: 0, components: [] };
  return {
    state: snapshot.overall.state,
    reason: snapshot.overall.reason,
    openIncidents: snapshot.incidents?.openCount ?? 0,
    components: snapshot.components.map(({ id, label, state, reason }) => ({ id, label, state, reason })),
  };
}

async function buildPulse({ actorId, readHealth }) {
  const [dashboard, activity] = await Promise.all([getDashboardMetrics(), recentActivity(actorId)]);
  return {
    generatedAt: new Date().toISOString(),
    metrics: dashboard.metrics,
    charts: { revenue: dashboard.charts.revenue },
    health: healthSummary(readHealth()),
    activity,
  };
}

/**
 * What the live dashboard polls. Every open dashboard shares one result for a few seconds, so watching costs the same whether one
 * admin has it open or five, and the provider is read through the shared account cache rather than once per viewer. The health
 * part comes from the monitor's snapshot in memory: the page never runs a check itself.
 */
export async function getDashboardPulse({ actorId, readHealth = () => null, now = Date.now() } = {}) {
  assertAdminUser(actorId);
  if (pulseCache && now - pulseCache.at < PULSE_TTL_MS) return { ...pulseCache.value, health: healthSummary(readHealth()) };
  pulseInFlight ||= buildPulse({ actorId, readHealth })
    .then((value) => { pulseCache = { at: Date.now(), value }; return value; })
    .finally(() => { pulseInFlight = null; });
  return pulseInFlight;
}

export function resetDashboardPulseForTests() {
  pulseCache = null;
  pulseInFlight = null;
}

export { knownVpnCounts, revenueForPeriod, DAY_MS, PENDING_ORDER_STATES, FAILED_PROVISION_STATES };
