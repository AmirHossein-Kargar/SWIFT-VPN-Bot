/**
 * Pure calculations shared by the Telegram admin reports.
 * Kept separate from MongoDB so the numeric rules can be tested without a database.
 */
import moment from "moment-jalaali";

const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];

export function emptyUserSummary() {
  return {
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    premiumUsers: 0,
    totalBalance: 0,
    totalServices: 0,
    totalPayments: 0,
    lowBalance: 0,
    mediumBalance: 0,
    highBalance: 0,
    newUsers: 0,
  };
}

/**
 * Match the historical in-memory user report exactly:
 * active is `balance > 0`, inactive is `balance === 0` (null is neither),
 * and sums treat only falsy balances as zero.
 */
export function accumulateUser(summary, user, thirtyDaysAgo) {
  const balance = user?.balance || 0;
  summary.totalUsers += 1;
  if (user?.balance > 0) summary.activeUsers += 1;
  if (user?.balance === 0) summary.inactiveUsers += 1;
  if ((user?.totalServices || 0) > 0) summary.premiumUsers += 1;
  summary.totalBalance += balance;
  summary.totalServices += user?.totalServices || 0;
  summary.totalPayments += user?.successfulPayments || 0;
  if (balance > 0 && balance < 50_000) summary.lowBalance += 1;
  else if (balance >= 50_000 && balance < 200_000) summary.mediumBalance += 1;
  else if (balance >= 200_000) summary.highBalance += 1;
  if (user?.createdAt && new Date(user.createdAt) > thirtyDaysAgo) summary.newUsers += 1;
  return summary;
}

export function finalizeUserSummary(summary) {
  summary.avgBalance = summary.totalUsers > 0 ? summary.totalBalance / summary.totalUsers : 0;
  return summary;
}

export function summarizeUserRecords(users, now = new Date()) {
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const summary = emptyUserSummary();
  for (const user of users) accumulateUser(summary, user, thirtyDaysAgo);
  return finalizeUserSummary(summary);
}

/**
 * Greedy estimate used by the profit reports: consume recognized revenue from
 * the most expensive plan downward. Identical to the previous inline loops.
 */
export function estimateCatalogConsumption(recognizedRevenue, plans) {
  const ranked = (Array.isArray(plans) ? plans : [])
    .map((plan) => ({
      price: plan?.price || 0,
      gig: plan?.gig || 0,
      days: plan?.days || 0,
    }))
    .sort((left, right) => right.price - left.price);

  let remaining = Number(recognizedRevenue) || 0;
  let estGigSold = 0;
  let estDaysSold = 0;
  for (const plan of ranked) {
    if (plan.price > 0 && remaining >= plan.price) {
      const count = Math.floor(remaining / plan.price);
      if (count > 0) {
        estGigSold += count * plan.gig;
        estDaysSold += count * plan.days;
        remaining -= count * plan.price;
      }
    }
  }
  return { estGigSold, estDaysSold, remaining };
}

/** Local-time month windows, newest first. Matches the previous TRX stats loop. */
export function recentLocalMonths(count, now = new Date()) {
  const months = [];
  const total = Number.isInteger(count) && count > 0 ? count : 0;
  for (let index = 0; index < total; index += 1) {
    const monthStart = new Date(now.getTime());
    monthStart.setMonth(monthStart.getMonth() - index);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart.getTime());
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setDate(0);
    monthEnd.setHours(23, 59, 59, 999);
    months.push({
      monthStart,
      monthEnd,
      label: monthStart.toLocaleDateString("fa-IR", { month: "long", year: "numeric" }),
    });
  }
  return months;
}

/**
 * The monthly report title is a Jalali month. The queried window must be that
 * same month — not the Gregorian month that happens to contain "now".
 */
export function jalaliMonthWindow(now = new Date()) {
  const current = moment(now);
  if (!current.isValid()) throw new TypeError("jalaliMonthWindow requires a valid date");
  const previous = current.clone().subtract(1, "jMonth");
  const persianMonth = current.jMonth() + 1;
  return {
    persianYear: current.jYear(),
    persianMonth,
    monthName: JALALI_MONTHS[persianMonth - 1] || JALALI_MONTHS[0],
    startOfMonth: current.clone().startOf("jMonth").toDate(),
    endOfMonth: current.clone().endOf("jMonth").toDate(),
    lastMonthStart: previous.clone().startOf("jMonth").toDate(),
    lastMonthEnd: previous.clone().endOf("jMonth").toDate(),
  };
}

/** Gregorian fallback kept so a calendar-library failure still produces a report. */
export function gregorianMonthWindow(now = new Date()) {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  return {
    persianYear: now.getFullYear(),
    persianMonth: now.getMonth() + 1,
    monthName: JALALI_MONTHS[Math.min(Math.max(now.getMonth(), 0), 11)],
    startOfMonth,
    endOfMonth,
    lastMonthStart,
    lastMonthEnd,
  };
}

export function invoiceAverage(totalPaidAmount, paidCount) {
  return paidCount > 0 ? totalPaidAmount / paidCount : 0;
}
