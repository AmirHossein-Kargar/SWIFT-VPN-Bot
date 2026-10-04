import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import { StatusApi } from "../../api/wizardApi.js";

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

async function sumModel(Model, match) {
  const [result] = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, amount: { $sum: { $ifNull: ["$amount", 0] } }, count: { $sum: 1 } } },
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
  const [hoosh, crypto, bank] = await Promise.all([
    sumModel(HooshPayInvoice, paidMatch(from, to, "balanceCreditedAt")),
    sumModel(CryptoInvoice, paidMatch(from, to, "balanceCreditedAt")),
    sumModel(bankInvoice, {
      status: { $in: ["confirmed", "paid"] },
      balanceCredited: true,
      balanceCreditedAt: { $gte: from, $lt: to },
    }),
  ]);
  return {
    amount: hoosh.amount + crypto.amount + bank.amount,
    count: hoosh.count + crypto.count + bank.count,
    byProvider: { hooshpay: hoosh.amount, trx: crypto.amount, bank: bank.amount },
  };
}

async function countExpiredTrackedVpns(now) {
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
    { $match: { effectiveExpiry: { $lte: now } } },
    { $count: "count" },
  ]).allowDiskUse(true);
  return Number(row?.count || 0);
}

async function knownVpnCounts(now) {
  const [active, expired] = await Promise.all([
    WalletPurchase.aggregate([
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
      { $match: { effectiveExpiry: { $gt: now } } },
      { $count: "count" },
    ]).allowDiskUse(true),
    countExpiredTrackedVpns(now),
  ]);
  return { active: Number(active?.[0]?.count || 0), expired };
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
  const [hooshRevenue, cryptoRevenue, bankRevenue, orders, newUsers, vpnOrders, popularPackages] = await Promise.all([
    timeSeries(HooshPayInvoice, { status: "paid", balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amount", "revenue"),
    timeSeries(CryptoInvoice, { status: "paid", balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amount", "revenue"),
    timeSeries(bankInvoice, { status: { $in: ["confirmed", "paid"] }, balanceCredited: true, balanceCreditedAt: dayMatch }, "balanceCreditedAt", "amount", "revenue"),
    timeSeries(WalletPurchase, { createdAt: dayMatch }, "createdAt", null, "orders"),
    timeSeries(User, { createdAt: dayMatch }, "createdAt", null, "users"),
    timeSeries(WalletPurchase, { status: "completed", completedAt: dayMatch }, "completedAt", null, "activeVpns"),
    topPackages(from),
  ]);
  const days = fillDays(from, dayCount);
  const revenueGroups = new Map();
  for (const group of [...hooshRevenue, ...cryptoRevenue, ...bankRevenue]) {
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
    pendingBank,
    pendingCrypto,
    pendingOrders,
    failedHoosh,
    failedBank,
    failedCrypto,
    failedProvisioning,
    vpnCounts,
    panelStatus,
    charts,
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
    bankInvoice.countDocuments({ status: "waiting_for_approval", paymentType: "bank" }),
    CryptoInvoice.countDocuments({ status: "unpaid" }),
    WalletPurchase.countDocuments({ status: { $in: PENDING_ORDER_STATES } }),
    HooshPayInvoice.countDocuments({ status: { $in: ["failed", "reversed"] } }),
    bankInvoice.countDocuments({ status: "rejected" }),
    CryptoInvoice.countDocuments({ status: "rejected" }),
    WalletPurchase.countDocuments({ status: { $in: FAILED_PROVISION_STATES } }),
    knownVpnCounts(now),
    StatusApi().catch(() => null),
    dashboardCharts(now),
  ]);

  const activeVpnCount = Number(panelStatus?.result?.count_active_services);
  const totalPanelVpns = Number(panelStatus?.result?.count_services);
  const failedPayments = failedHoosh + failedBank + failedCrypto;
  const pendingPayments = pendingHoosh + pendingBank + pendingCrypto;
  const completedOrders = await sumModel(WalletPurchase, { status: "completed", completedAt: { $gte: startMonth } });
  const failedPaymentDenominator = failedPayments + pendingPayments + revenueMonth.count;

  return {
    generatedAt: now.toISOString(),
    definitions: {
      activeUsers: "Non-blocked accounts seen by the bot in the last 30 days; tracking starts with this release.",
      activeVpns: panelStatus ? "WizardXray active-service count." : "Unavailable while WizardXray status cannot be checked.",
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

export async function getDashboardChartData({ now = new Date() } = {}) {
  return (await getDashboardMetrics({ now })).charts;
}

export { knownVpnCounts, revenueForPeriod, DAY_MS, PENDING_ORDER_STATES, FAILED_PROVISION_STATES };
