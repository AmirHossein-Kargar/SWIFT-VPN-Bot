import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import AdminProduct from "../../models/AdminProduct.js";
import { assertAdminUser } from "./authorization.js";
import { revenueForPeriod, knownVpnCounts } from "./dashboard.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const GRANULARITIES = {
  daily: { bucketMs: DAY_MS, buckets: 30, label: "day" },
  weekly: { bucketMs: 7 * DAY_MS, buckets: 12, label: "week" },
  monthly: { bucketMs: 30 * DAY_MS, buckets: 12, label: "month" },
};

function utcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function providerRevenueSeries(from, to, bucketMs, buckets) {
  const boundaries = Array.from({ length: buckets + 1 }, (_, index) => new Date(from.getTime() + index * bucketMs));
  const match = { status: "paid", balanceCredited: true, balanceCreditedAt: { $gte: from, $lt: to } };
  const [hoosh, crypto, bank] = await Promise.all([
    HooshPayInvoice.aggregate([
      { $match: match },
      { $group: { _id: { $floor: { $divide: [{ $subtract: ["$balanceCreditedAt", from] }, bucketMs] } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    CryptoInvoice.aggregate([
      { $match: match },
      { $group: { _id: { $floor: { $divide: [{ $subtract: ["$balanceCreditedAt", from] }, bucketMs] } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    bankInvoice.aggregate([
      { $match: { status: { $in: ["confirmed", "paid"] }, balanceCredited: true, balanceCreditedAt: { $gte: from, $lt: to } } },
      { $group: { _id: { $floor: { $divide: [{ $subtract: ["$balanceCreditedAt", from] }, bucketMs] } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);
  const rows = [
    { provider: "hooshpay", data: hoosh },
    { provider: "trx", data: crypto },
    { provider: "bank", data: bank },
  ];
  return boundaries.slice(0, -1).map((start, index) => {
    const bucket = { date: start.toISOString().slice(0, 10), revenue: 0, orders: 0, byProvider: { hooshpay: 0, trx: 0, bank: 0 } };
    for (const { provider, data } of rows) {
      for (const row of data) {
        if (Number(row._id) !== index) continue;
        bucket.revenue += Number(row.amount || 0);
        bucket.orders += Number(row.count || 0);
        bucket.byProvider[provider] += Number(row.amount || 0);
      }
    }
    return bucket;
  });
}

export async function getAnalytics({ actorId, granularity = "monthly", now = new Date() } = {}) {
  assertAdminUser(actorId);
  const config = GRANULARITIES[granularity] || GRANULARITIES.monthly;
  const from = new Date(utcDayStart(now).getTime() - (config.buckets - 1) * config.bucketMs);
  const to = new Date(from.getTime() + config.buckets * config.bucketMs);
  const startToday = utcDayStart(now);
  const startWeek = new Date(startToday.getTime() - ((startToday.getUTCDay() + 6) % 7) * DAY_MS);
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [revenueSeries, totalUsers, newUsersToday, activeUsers, vpnCounts, ordersTotal, ordersCompleted, failedPayments, failedProvisioning, popularProducts, topSpenders] = await Promise.all([
    providerRevenueSeries(from, to, config.bucketMs, config.buckets),
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: startToday } }),
    User.countDocuments({ isBanned: { $ne: true }, lastActivityAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) } }),
    knownVpnCounts(now),
    WalletPurchase.countDocuments({}),
    WalletPurchase.countDocuments({ status: "completed" }),
    Promise.all([
      HooshPayInvoice.countDocuments({ status: { $in: ["failed", "reversed"] } }),
      bankInvoice.countDocuments({ status: "rejected" }),
      CryptoInvoice.countDocuments({ status: "rejected" }),
    ]).then((counts) => counts.reduce((sum, count) => sum + count, 0)),
    WalletPurchase.countDocuments({ status: { $in: ["failed", "uncertain", "manual_review"] } }),
    WalletPurchase.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: "$planId", name: { $first: "$planName" }, count: { $sum: 1 }, revenue: { $sum: "$amount" } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, productId: "$_id", name: 1, count: 1, revenue: 1 } },
    ]),
    WalletPurchase.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: "$telegramId", totalSpent: { $sum: "$amount" }, orderCount: { $sum: 1 } } },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, telegramId: "$_id", totalSpent: 1, orderCount: 1 } },
    ]),
  ]);

  const [revenueToday, revenueWeek, revenueMonth] = await Promise.all([
    revenueForPeriod(startToday, new Date(startToday.getTime() + DAY_MS)),
    revenueForPeriod(startWeek, now),
    revenueForPeriod(startMonth, now),
  ]);

  const payingUsers = await User.countDocuments({ successfulPayments: { $gt: 0 } });
  const catalog = await AdminProduct.find({}).sort({ displayOrder: 1 }).lean().catch(() => []);
  const marginByProduct = popularProducts.map((item) => {
    const product = catalog.find((candidate) => candidate.productId === item.productId);
    const cost = product ? Number(product.costToman || 0) * item.count : null;
    return {
      ...item,
      revenue: Number(item.revenue || 0),
      estimatedCost: cost,
      estimatedProfit: cost == null ? null : Number(item.revenue || 0) - cost,
    };
  });

  const totalAttempts = ordersTotal + failedPayments;
  return {
    generatedAt: now.toISOString(),
    granularity,
    series: revenueSeries,
    metrics: {
      revenue: { today: revenueToday.amount, week: revenueWeek.amount, month: revenueMonth.amount, byProviderMonth: revenueMonth.byProvider },
      orders: { total: ordersTotal, completed: ordersCompleted, today: revenueToday.count },
      users: { total: totalUsers, newToday: newUsersToday, active: activeUsers, paying: payingUsers },
      vpns: { activeTracked: vpnCounts.active, expiredTracked: vpnCounts.expired },
      conversionRate: totalUsers ? payingUsers / totalUsers : 0,
      averageTopUpValueMonth: revenueMonth.count ? Math.round(revenueMonth.amount / revenueMonth.count) : 0,
      failedPaymentRate: totalAttempts ? failedPayments / totalAttempts : 0,
      failedProvisioningRate: ordersTotal ? failedProvisioning / ordersTotal : 0,
      failedPayments,
      failedProvisioning,
    },
    popularProducts: marginByProduct,
    topSpenders,
    definitions: {
      conversionRate: "Share of all registered accounts that completed at least one payment.",
      failedPaymentRate: "Rejected/reversed payments divided by (orders + failed payments).",
      failedProvisioningRate: "Failed or uncertain provisioning attempts divided by all orders.",
      estimatedProfit: "Product cost is only known for products in the catalog.",
    },
  };
}

export { GRANULARITIES };
