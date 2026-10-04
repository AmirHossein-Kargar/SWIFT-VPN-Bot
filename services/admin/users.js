import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { escapeRegex, parsePagination, requireReason, requireTelegramId, parsePositiveInteger } from "./validation.js";
import sharedRedisClient from "../../config/redisClient.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_SORTS = new Set(["registered", "spending", "activity"]);

export function buildUserSearchQuery({ search = "", activity = "all", paying = "all", blocked = "all", now = new Date() } = {}) {
  const query = {};
  const conditions = [];
  const term = String(search ?? "").trim().slice(0, 100);
  if (term) {
    if (/^[1-9]\d{0,19}$/.test(term)) conditions.push({ telegramId: term });
    else {
      const prefix = new RegExp(`^${escapeRegex(term.replace(/^@/, ""))}`, "i");
      conditions.push({ $or: [{ username: prefix }, { firstName: prefix }, { lastName: prefix }] });
    }
  }
  if (activity === "active") query.lastActivityAt = { $gte: new Date(now.getTime() - 30 * DAY_MS) };
  else if (activity === "inactive") conditions.push({ $or: [{ lastActivityAt: null }, { lastActivityAt: { $lt: new Date(now.getTime() - 30 * DAY_MS) } }] });
  if (paying === "yes") query.successfulPayments = { $gt: 0 };
  else if (paying === "no") query.successfulPayments = { $eq: 0 };
  if (blocked === "yes") query.isBanned = true;
  else if (blocked === "no") query.isBanned = { $ne: true };
  if (conditions.length === 1) Object.assign(query, conditions[0]);
  else if (conditions.length > 1) query.$and = conditions;
  return query;
}

function safeUser(user, spend = {}) {
  return {
    telegramId: String(user.telegramId),
    username: user.username || null,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    balance: Number(user.balance || 0),
    successfulPayments: Number(user.successfulPayments || 0),
    totalSpent: Number(spend.totalSpent || 0),
    orderCount: Number(spend.orderCount || 0),
    serviceCount: Array.isArray(user.services) ? user.services.length : Number(user.totalServices || 0),
    createdAt: user.createdAt || null,
    lastActivityAt: user.lastActivityAt || null,
    isBanned: Boolean(user.isBanned),
    referralCode: user.referralCode || null,
    referredByTelegramId: user.referredByTelegramId || null,
  };
}

async function spendingForUsers(telegramIds) {
  if (!telegramIds.length) return new Map();
  const rows = await WalletPurchase.aggregate([
    { $match: { telegramId: { $in: telegramIds }, status: "completed" } },
    { $group: { _id: "$telegramId", totalSpent: { $sum: "$amount" }, orderCount: { $sum: 1 } } },
  ]).allowDiskUse(true);
  return new Map(rows.map((row) => [String(row._id), row]));
}

export async function listUsers({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePagination(query);
  const filter = buildUserSearchQuery({
    search: query.search,
    activity: ["active", "inactive"].includes(query.activity) ? query.activity : "all",
    paying: ["yes", "no"].includes(query.paying) ? query.paying : "all",
    blocked: ["yes", "no"].includes(query.blocked) ? query.blocked : "all",
  });
  const sortBy = ALLOWED_SORTS.has(query.sort) ? query.sort : "registered";
  let items;
  let total;

  if (sortBy === "spending") {
    const [result] = await User.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: WalletPurchase.collection.name,
          let: { userTelegramId: "$telegramId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$telegramId", "$$userTelegramId"] }, { $eq: ["$status", "completed"] }] } } },
            { $group: { _id: null, totalSpent: { $sum: "$amount" }, orderCount: { $sum: 1 } } },
          ],
          as: "spend",
        },
      },
      { $addFields: { totalSpent: { $ifNull: [{ $arrayElemAt: ["$spend.totalSpent", 0] }, 0] }, orderCount: { $ifNull: [{ $arrayElemAt: ["$spend.orderCount", 0] }, 0] } } },
      { $sort: { totalSpent: -1, createdAt: -1, _id: 1 } },
      { $facet: { items: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }], total: [{ $count: "count" }] } },
    ]).allowDiskUse(true).option({ maxTimeMS: 8_000 });
    items = (result?.items || []).map((user) => safeUser(user, user));
    total = Number(result?.total?.[0]?.count || 0);
  } else {
    const sort = sortBy === "activity" ? { lastActivityAt: -1, _id: 1 } : { createdAt: -1, _id: 1 };
    [items, total] = await Promise.all([
      User.find(filter).select("telegramId username firstName lastName balance successfulPayments totalServices services createdAt lastActivityAt isBanned referralCode referredByTelegramId")
        .sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean().maxTimeMS(5_000),
      User.countDocuments(filter).maxTimeMS(5_000),
    ]);
    const spends = await spendingForUsers(items.map((user) => String(user.telegramId)));
    items = items.map((user) => safeUser(user, spends.get(String(user.telegramId))));
  }
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize), sort: sortBy };
}

async function countTrackedServices(telegramId, now) {
  const [row] = await WalletPurchase.aggregate([
    { $match: { telegramId, status: "completed", revokedAt: null } },
    { $addFields: { effectiveExpiry: { $ifNull: ["$expiresAt", { $add: [{ $ifNull: ["$completedAt", "$createdAt"] }, { $multiply: ["$days", DAY_MS] }] }] } } },
    { $group: { _id: null, active: { $sum: { $cond: [{ $gt: ["$effectiveExpiry", now] }, 1, 0] } }, expired: { $sum: { $cond: [{ $lte: ["$effectiveExpiry", now] }, 1, 0] } } } },
  ]).allowDiskUse(true);
  return { active: Number(row?.active || 0), expired: Number(row?.expired || 0) };
}

function mapPaymentHistory(provider, record) {
  const id = record.uid || record.paymentId || record.invoiceId || record.orderId;
  let status = String(record.status || "unknown");
  if (record.recoveryStatus === "required") status = "recovery-required";
  else if (provider === "bank" && status === "confirmed" && record.balanceCredited) status = "fulfilled";
  else if (provider === "bank" && status === "waiting_for_approval") status = "pending";
  else if (provider === "trx" && status === "unpaid") status = "pending";
  else if (provider === "trx" && status === "paid" && record.balanceCredited) status = "fulfilled";
  else if (provider === "hooshpay" && status === "paid" && record.balanceCredited) status = "fulfilled";
  else if (provider === "hooshpay" && status === "reversed") status = "refunded";
  return {
    id: String(id || ""), provider, status,
    amount: Number(record.amount || 0),
    createdAt: record.createdAt || null,
    paidAt: record.paidAt || record.confirmedAt || record.balanceCreditedAt || null,
    trackingCode: record.trackingCode || null,
  };
}

export async function getUserDetail({ actorId, telegramId, now = new Date() } = {}) {
  assertAdminUser(actorId);
  const id = requireTelegramId(telegramId);
  const user = await User.findOne({ telegramId: id }).select("telegramId username firstName lastName balance successfulPayments totalServices services createdAt lastActivityAt isBanned blockedAt blockedBy blockReason referralCode referredByTelegramId").lean();
  if (!user) throw new AdminServiceError("User not found.", { status: 404, code: "user_not_found" });
  const [spendRows, tracked, referralCount, purchases, hoosh, bank, crypto] = await Promise.all([
    WalletPurchase.aggregate([
      { $match: { telegramId: id, status: "completed" } },
      { $group: { _id: null, totalSpent: { $sum: "$amount" }, orderCount: { $sum: 1 } } },
    ]),
    countTrackedServices(id, now),
    User.countDocuments({ referredByTelegramId: id }),
    WalletPurchase.find({ telegramId: id }).sort({ createdAt: -1 }).limit(20).select("purchaseId planId planName amount status createdAt reservedAt provisioningStartedAt provisionedAt completedAt expiresAt revokedAt errorCode retryCount recoveryStatus serviceUsername").lean(),
    HooshPayInvoice.find({ userId: Number(id) }).sort({ createdAt: -1 }).limit(10).select("uid orderId amount status createdAt paidAt balanceCredited trackingCode recoveryStatus").lean(),
    bankInvoice.find({ userId: Number(id) }).sort({ createdAt: -1 }).limit(10).select("paymentId amount paymentType status createdAt confirmedAt balanceCredited trackingCode recoveryStatus").lean(),
    CryptoInvoice.find({ userId: Number(id) }).sort({ createdAt: -1 }).limit(10).select("invoiceId amount paymentType status createdAt confirmedAt balanceCredited transactionHash recoveryStatus").lean(),
  ]);
  const spend = spendRows[0] || {};
  const trackedPurchaseIds = new Set(purchases.map((purchase) => purchase.purchaseId));
  const serviceHistory = (Array.isArray(user.services) ? user.services : []).slice(-25).reverse().map((service) => ({
    username: service.username,
    productId: service.productId || null,
    purchaseId: service.purchaseId || null,
    createdAt: service.createdAt || null,
    expiresAt: service.expiresAt || null,
    revokedAt: service.revokedAt || null,
    tracked: Boolean(service.purchaseId && trackedPurchaseIds.has(service.purchaseId)),
  }));
  const payments = [
    ...hoosh.map((item) => mapPaymentHistory("hooshpay", item)),
    ...bank.map((item) => mapPaymentHistory("bank", item)),
    ...crypto.map((item) => mapPaymentHistory("trx", item)),
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 20);
  const referrer = user.referredByTelegramId
    ? await User.findOne({ telegramId: user.referredByTelegramId }).select("telegramId username firstName lastName").lean()
    : null;
  return {
    user: safeUser(user, spend),
    blockedAt: user.blockedAt || null,
    blockedBy: user.blockedBy || null,
    blockReason: user.blockReason || null,
    totalSpent: Number(spend.totalSpent || 0),
    orderCount: Number(spend.orderCount || 0),
    activeVpns: tracked.active,
    expiredVpns: tracked.expired,
    untrackedServiceCount: Math.max(0, serviceHistory.length - tracked.active - tracked.expired),
    referral: {
      code: user.referralCode || null,
      referredByTelegramId: user.referredByTelegramId || null,
      referredBy: referrer ? safeUser(referrer) : null,
      referralCount,
      trackingAvailable: Boolean(user.referralCode || user.referredByTelegramId || referralCount),
    },
    payments,
    orders: purchases.map((purchase) => ({
      id: purchase.purchaseId,
      productId: purchase.planId,
      product: purchase.planName || purchase.planId,
      amount: Number(purchase.amount || 0),
      status: purchase.status,
      createdAt: purchase.createdAt || null,
      completedAt: purchase.completedAt || null,
      expiresAt: purchase.expiresAt || null,
      serviceUsername: purchase.serviceUsername || null,
      errorCode: purchase.errorCode || null,
      retryCount: Number(purchase.retryCount || 0),
      recoveryStatus: purchase.recoveryStatus || "none",
    })),
    services: serviceHistory,
  };
}

export async function changeUserBalance({ actorId, operationId, telegramId, amount, direction, reason, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireTelegramId(telegramId);
  const value = parsePositiveInteger(amount, { name: "amount", min: 1, max: 2_000_000_000 });
  if (!["add", "remove"].includes(direction)) throw new AdminServiceError("Choose add or remove balance.", { status: 400, code: "invalid_balance_action" });
  const safeReason = requireReason(reason);
  const action = direction === "add" ? "USER_BALANCE_ADDED" : "USER_BALANCE_REMOVED";
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action,
    targetType: "user",
    targetId: id,
    targetUserId: id,
    ipAddress,
    metadata: { amount: value, direction, reason: safeReason },
    resumeStarted: true,
    execute: async () => {
      const query = { telegramId: id, appliedAdminBalanceKeys: { $ne: operationId } };
      if (direction === "remove") query.balance = { $gte: value };
      const update = direction === "add"
        ? { $inc: { balance: value }, $addToSet: { appliedAdminBalanceKeys: operationId } }
        : { $inc: { balance: -value }, $addToSet: { appliedAdminBalanceKeys: operationId } };
      const user = await User.findOneAndUpdate(query, update, { new: true }).select("telegramId balance").lean();
      if (user) return { ok: true, balance: Number(user.balance), auditSummary: { balance: Number(user.balance), amount: value, direction } };
      const existing = await User.findOne({ telegramId: id }).select("balance appliedAdminBalanceKeys").lean();
      if (!existing) throw new AdminServiceError("User not found.", { status: 404, code: "user_not_found" });
      if (Array.isArray(existing.appliedAdminBalanceKeys) && existing.appliedAdminBalanceKeys.includes(operationId)) {
        return { ok: true, balance: Number(existing.balance), alreadyApplied: true, auditSummary: { balance: Number(existing.balance), amount: value, direction, alreadyApplied: true } };
      }
      throw new AdminServiceError("The balance is too low for this adjustment.", { status: 409, code: "insufficient_balance" });
    },
  });
  return result;
}

export async function setUserBlocked({ actorId, operationId, telegramId, blocked, reason, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireTelegramId(telegramId);
  if (typeof blocked !== "boolean") throw new AdminServiceError("A block state is required.", { status: 400, code: "invalid_block_state" });
  const safeReason = blocked ? requireReason(reason) : null;
  const action = blocked ? "USER_BLOCKED" : "USER_UNBLOCKED";
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action,
    targetType: "user",
    targetId: id,
    targetUserId: id,
    ipAddress,
    metadata: blocked ? { reason: safeReason } : {},
    resumeStarted: true,
    execute: async () => {
      const update = blocked
        ? { $set: { isBanned: true, blockedAt: new Date(), blockedBy: String(actorId), blockReason: safeReason } }
        : { $set: { isBanned: false, blockedAt: null, blockedBy: null, blockReason: null } };
      const user = await User.findOneAndUpdate({ telegramId: id }, update, { new: true }).select("telegramId isBanned blockedAt").lean();
      if (!user) throw new AdminServiceError("User not found.", { status: 404, code: "user_not_found" });
      return { ok: true, telegramId: id, isBanned: Boolean(user.isBanned), auditSummary: { isBanned: Boolean(user.isBanned) } };
    },
  });
  return result;
}

export async function getReferralOverview({ actorId, page = 1, pageSize = 25 } = {}) {
  assertAdminUser(actorId);
  const { page: safePage, pageSize: safeSize } = parsePagination({ page, pageSize });
  const [items, total] = await Promise.all([
    User.aggregate([
      { $match: { $or: [{ referralCode: { $type: "string", $ne: "" } }, { referredByTelegramId: { $type: "string", $ne: "" } }] } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $skip: (safePage - 1) * safeSize },
      { $limit: safeSize },
      { $project: { telegramId: 1, username: 1, firstName: 1, lastName: 1, referralCode: 1, referredByTelegramId: 1, createdAt: 1 } },
    ]).allowDiskUse(true),
    User.countDocuments({ $or: [{ referralCode: { $type: "string", $ne: "" } }, { referredByTelegramId: { $type: "string", $ne: "" } }] }),
  ]);
  return {
    items: items.map((item) => ({ ...safeUser(item), referralCode: item.referralCode || null })),
    page: safePage,
    pageSize: safeSize,
    total,
    trackingAvailable: total > 0,
  };
}

export async function touchUserActivity(telegramId, { redis = sharedRedisClient, now = new Date() } = {}) {
  const id = String(telegramId ?? "");
  if (!/^[1-9]\d{0,19}$/.test(id)) return false;
  const key = `admin:activity-touch:${id}`;
  if (redis?.isReady && typeof redis.set === "function") {
    try {
      const touched = await redis.set(key, "1", { NX: true, EX: 900 });
      if (touched !== "OK") return false;
    } catch { /* activity is non-critical if Redis is unavailable */ }
  }
  await User.updateOne(
    { telegramId: id, $or: [{ lastActivityAt: null }, { lastActivityAt: { $lt: new Date(now.getTime() - 15 * 60_000) } }] },
    { $set: { lastActivityAt: now } }
  ).catch(() => {});
  return true;
}
