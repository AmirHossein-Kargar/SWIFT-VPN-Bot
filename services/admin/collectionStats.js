/**
 * Admin-report aggregations.
 *
 * These replace `Model.find({})` followed by in-process sums. The numeric rules
 * match the previous reducers (`amount || 0`, status equality) without shipping
 * webhook logs, service arrays, or wallet ledgers to the bot process.
 */
import User from "../../models/User.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import {
  accumulateUser,
  emptyUserSummary,
  finalizeUserSummary,
} from "./reportMath.js";

const QUERY_TIMEOUT_MS = 8_000;
const amountExpr = { $ifNull: ["$amount", 0] };

function aggregate(Model, pipeline) {
  return Model.aggregate(pipeline).option({ maxTimeMS: QUERY_TIMEOUT_MS });
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

export async function sumAmount(Model, match) {
  const [row] = await aggregate(Model, [
    { $match: match },
    { $group: { _id: null, total: { $sum: amountExpr }, count: { $sum: 1 } } },
  ]);
  return { total: numeric(row?.total), count: numeric(row?.count) };
}

export async function sumUserBalances() {
  const [row] = await aggregate(User, [
    { $group: { _id: null, total: { $sum: { $ifNull: ["$balance", 0] } } } },
  ]);
  return numeric(row?.total);
}

/** One projected scan. Predicates live in reportMath so they stay testable. */
export async function summarizeUsers(now = new Date()) {
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const summary = emptyUserSummary();
  const cursor = User.find({}, {
    balance: 1,
    totalServices: 1,
    successfulPayments: 1,
    createdAt: 1,
  }).maxTimeMS(QUERY_TIMEOUT_MS).lean().cursor();
  for await (const user of cursor) accumulateUser(summary, user, thirtyDaysAgo);
  return finalizeUserSummary(summary);
}

function confirmedExpr(confirmedStatuses) {
  return { $in: ["$status", confirmedStatuses] };
}

/**
 * Single-pass replacement for the four full-collection reads in the bank and
 * crypto Telegram reports. `pendingStatus` is the exact status string the old
 * report counted as "در انتظار" (`pending` for bank, `unpaid` for TRX).
 */
export async function classifyInvoices(Model, { confirmedStatuses, pendingStatus, rejectedStatus }) {
  const confirmed = confirmedExpr(confirmedStatuses);
  const pending = { $eq: ["$status", pendingStatus] };
  const rejected = { $eq: ["$status", rejectedStatus] };
  const [row] = await aggregate(Model, [{
    $group: {
      _id: null,
      total: { $sum: 1 },
      confirmedCount: { $sum: { $cond: [confirmed, 1, 0] } },
      confirmedSum: { $sum: { $cond: [confirmed, amountExpr, 0] } },
      pendingCount: { $sum: { $cond: [pending, 1, 0] } },
      pendingSum: { $sum: { $cond: [pending, amountExpr, 0] } },
      rejectedCount: { $sum: { $cond: [rejected, 1, 0] } },
      rejectedSum: { $sum: { $cond: [rejected, amountExpr, 0] } },
      small: { $sum: { $cond: [{ $and: [confirmed, { $lt: [amountExpr, 100_000] }] }, 1, 0] } },
      medium: {
        $sum: {
          $cond: [{
            $and: [confirmed, { $gte: [amountExpr, 100_000] }, { $lt: [amountExpr, 500_000] }],
          }, 1, 0],
        },
      },
      large: { $sum: { $cond: [{ $and: [confirmed, { $gte: [amountExpr, 500_000] }] }, 1, 0] } },
    },
  }]);
  return {
    total: numeric(row?.total),
    confirmedCount: numeric(row?.confirmedCount),
    confirmedSum: numeric(row?.confirmedSum),
    pendingCount: numeric(row?.pendingCount),
    pendingSum: numeric(row?.pendingSum),
    rejectedCount: numeric(row?.rejectedCount),
    rejectedSum: numeric(row?.rejectedSum),
    small: numeric(row?.small),
    medium: numeric(row?.medium),
    large: numeric(row?.large),
  };
}

/** Group sums. Missing/blank keys become "unknown", matching `value || "unknown"`. */
export async function groupAmounts(Model, match, field) {
  const key = {
    $cond: [
      { $or: [{ $eq: [`$${field}`, null] }, { $eq: [`$${field}`, ""] }] },
      "unknown",
      `$${field}`,
    ],
  };
  const rows = await aggregate(Model, [
    { $match: match },
    {
      $group: {
        _id: key,
        count: { $sum: 1 },
        amount: { $sum: amountExpr },
        paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "unpaid"] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((row) => ({
    key: String(row._id),
    count: numeric(row.count),
    amount: numeric(row.amount),
    paid: numeric(row.paid),
    pending: numeric(row.pending),
    rejected: numeric(row.rejected),
  }));
}

export async function trxPaymentSummary() {
  const [row] = await aggregate(CryptoInvoice, [
    { $match: { paymentType: "trx" } },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        paidInvoices: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
        pendingInvoices: { $sum: { $cond: [{ $eq: ["$status", "unpaid"] }, 1, 0] } },
        rejectedInvoices: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
        totalPaidAmount: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, amountExpr, 0] } },
        totalPaidTrx: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, { $ifNull: ["$cryptoAmount", 0] }, 0] } },
      },
    },
  ]);
  return {
    totalInvoices: numeric(row?.totalInvoices),
    paidInvoices: numeric(row?.paidInvoices),
    pendingInvoices: numeric(row?.pendingInvoices),
    rejectedInvoices: numeric(row?.rejectedInvoices),
    totalPaidAmount: numeric(row?.totalPaidAmount),
    totalPaidTrx: numeric(row?.totalPaidTrx),
  };
}

export async function sumPaidTrxInRanges(ranges) {
  if (!ranges.length) return [];
  const oldest = ranges[ranges.length - 1].monthStart;
  const newest = ranges[0].monthEnd;
  const facet = {};
  ranges.forEach((range, index) => {
    facet[`m${index}`] = [
      { $match: { confirmedAt: { $gte: range.monthStart, $lte: range.monthEnd } } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: amountExpr } } },
    ];
  });
  const [row] = await aggregate(CryptoInvoice, [
    { $match: { paymentType: "trx", status: "paid", confirmedAt: { $gte: oldest, $lte: newest } } },
    { $facet: facet },
  ]);
  return ranges.map((range, index) => {
    const bucket = row?.[`m${index}`]?.[0];
    return { month: range.label, count: numeric(bucket?.count), amount: numeric(bucket?.amount) };
  });
}

export function recentPaidTrx(limit = 5) {
  return CryptoInvoice.find({ paymentType: "trx", status: "paid" })
    .sort({ confirmedAt: -1 })
    .limit(limit)
    .select("invoiceId cryptoAmount amount confirmedAt")
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean();
}

export async function countPayingUsers() {
  return User.countDocuments({ successfulPayments: { $gt: 0 } }).maxTimeMS(QUERY_TIMEOUT_MS);
}


export async function hooshPayReportStats() {
  const rows = await aggregate(HooshPayInvoice, [{
    $group: {
      _id: "$status",
      count: { $sum: 1 },
      fulfilledAmount: {
        $sum: {
          $cond: [{
            $and: [{ $eq: ["$status", "paid"] }, { $eq: ["$fulfilled", true] }],
          }, amountExpr, 0],
        },
      },
      unfulfilledPaid: {
        $sum: {
          $cond: [{
            $and: [{ $eq: ["$status", "paid"] }, { $eq: ["$fulfilled", false] }],
          }, 1, 0],
        },
      },
    },
  }]);
  const byStatus = new Map(rows.map((row) => [row._id, numeric(row.count)]));
  return {
    all: rows.reduce((sum, row) => sum + numeric(row.count), 0),
    paid: byStatus.get("paid") || 0,
    pending: byStatus.get("pending") || 0,
    expired: byStatus.get("expired") || 0,
    cancelled: byStatus.get("cancelled") || 0,
    failed: byStatus.get("failed") || 0,
    totalAmount: rows.reduce((sum, row) => sum + numeric(row.fulfilledAmount), 0),
    unfulfilled: rows.reduce((sum, row) => sum + numeric(row.unfulfilledPaid), 0),
  };
}

