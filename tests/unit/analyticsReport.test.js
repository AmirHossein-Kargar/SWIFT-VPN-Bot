import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242";

const {
  DAY_MS,
  DEFINITIONS,
  assembleReport,
  classifyPayment,
  clearAnalyticsCacheForTests,
  compare,
  csvCell,
  getAnalyticsReport,
  granularityFor,
  jalaliParts,
  reportToCsv,
  resolveRange,
  successRate,
  summarizeAttempts,
  tehranDayStart,
} = await import("../../services/admin/analyticsReport.js");

const iso = (date) => date.toISOString();

describe("date boundaries (Asia/Tehran, UTC+03:30)", () => {
  test("a Tehran day starts at 20:30 UTC of the previous day", () => {
    assert.equal(iso(tehranDayStart(new Date("2026-10-20T12:00:00Z"))), "2026-10-19T20:30:00.000Z");
    assert.equal(iso(tehranDayStart(new Date("2026-10-20T20:29:59.999Z"))), "2026-10-19T20:30:00.000Z");
    assert.equal(iso(tehranDayStart(new Date("2026-10-20T20:30:00.000Z"))), "2026-10-20T20:30:00.000Z");
  });

  test("today / 7d / 30d are half-open full Tehran days ending tomorrow", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const today = resolveRange({ range: "today", now });
    assert.equal(iso(today.from), "2026-10-19T20:30:00.000Z");
    assert.equal(iso(today.to), "2026-10-20T20:30:00.000Z");
    assert.equal(iso(today.previous.from), "2026-10-18T20:30:00.000Z");
    assert.equal(iso(today.previous.to), iso(today.from));
    const week = resolveRange({ range: "7d", now });
    assert.equal(week.days, 7);
    assert.equal(week.to.getTime() - week.from.getTime(), 7 * DAY_MS);
    assert.equal(iso(week.previous.to), iso(week.from));
    assert.equal(resolveRange({ range: "30d", now }).days, 30);
  });

  test("the Jalali calendar is computed correctly (known dates)", () => {
    assert.deepEqual(jalaliParts(new Date("2026-10-20T12:00:00Z")), { year: 1405, month: 7, day: 28 });
    assert.deepEqual(jalaliParts(new Date("2026-03-21T12:00:00Z")), { year: 1405, month: 1, day: 1 });
    // Tehran midnight: 20:30 UTC already belongs to the next Jalali day.
    assert.equal(jalaliParts(new Date("2026-10-20T20:29:00Z")).day, 28);
    assert.equal(jalaliParts(new Date("2026-10-20T20:31:00Z")).day, 29);
  });

  test("this month (Jalali) starts on the 1st of Mehr and compares with the same elapsed days of Shahrivar", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const month = resolveRange({ range: "thisMonth", now, calendar: "jalali" });
    assert.equal(iso(month.from), "2026-09-22T20:30:00.000Z"); // 1405/07/01
    assert.equal(iso(month.to), "2026-10-20T20:30:00.000Z");
    assert.equal(month.days, 28);
    assert.equal(iso(month.previous.from), "2026-08-22T20:30:00.000Z"); // 1405/06/01
    assert.equal(month.previous.to.getTime() - month.previous.from.getTime(), 28 * DAY_MS);
  });

  test("previous month (Jalali) is the full Shahrivar, compared with the full Mordad", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const month = resolveRange({ range: "prevMonth", now, calendar: "jalali" });
    assert.equal(iso(month.from), "2026-08-22T20:30:00.000Z");
    assert.equal(iso(month.to), "2026-09-22T20:30:00.000Z");
    assert.equal(month.days, 31);
    assert.equal(iso(month.previous.to), iso(month.from));
    assert.equal(jalaliParts(new Date(month.previous.from.getTime() + 60_000)).day, 1);
  });

  test("the Gregorian calendar option uses calendar months", () => {
    const month = resolveRange({ range: "thisMonth", now: new Date("2026-10-20T12:00:00Z"), calendar: "gregorian" });
    assert.equal(iso(month.from), "2026-09-30T20:30:00.000Z");
    const prev = resolveRange({ range: "prevMonth", now: new Date("2026-10-20T12:00:00Z"), calendar: "gregorian" });
    assert.equal(iso(prev.from), "2026-08-31T20:30:00.000Z");
    assert.equal(iso(prev.to), "2026-09-30T20:30:00.000Z");
  });

  test("custom ranges are inclusive of the end day and validated", () => {
    const custom = resolveRange({ range: "custom", from: "2026-10-01", to: "2026-10-10" });
    assert.equal(custom.days, 10);
    assert.equal(iso(custom.from), "2026-09-30T20:30:00.000Z");
    assert.equal(iso(custom.to), "2026-10-10T20:30:00.000Z");
    assert.equal(iso(custom.previous.to), iso(custom.from));
    for (const bad of [
      { from: "2026-10-10", to: "2026-10-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "10/01/2026", to: "2026-10-02" },
      { from: "2026-10-01" },
      { from: "2024-01-01", to: "2026-01-01" },
      { from: "<script>", to: "2026-01-01" },
    ]) {
      assert.throws(() => resolveRange({ range: "custom", ...bad }), (e) => e.status === 400, JSON.stringify(bad));
    }
    assert.throws(() => resolveRange({ range: "decade" }), (e) => e.code === "invalid_range");
  });

  test("granularity grows with the range", () => {
    assert.equal(granularityFor(30).label, "day");
    assert.equal(granularityFor(200).label, "week");
    assert.equal(granularityFor(1000).label, "month");
  });
});

describe("comparison without division by zero", () => {
  test("handles zero, missing and normal baselines", () => {
    assert.deepEqual(compare(0, 0), { pct: null, delta: 0, state: "flat" });
    assert.deepEqual(compare(5, 0), { pct: null, delta: 5, state: "no_baseline" });
    assert.deepEqual(compare(150, 100), { pct: 0.5, delta: 50, state: "up" });
    assert.deepEqual(compare(50, 100), { pct: -0.5, delta: -50, state: "down" });
    assert.equal(compare(100, 100).state, "flat");
    assert.equal(compare(null, 1).state, "unavailable");
    assert.equal(compare(NaN, 1).state, "unavailable");
    assert.equal(compare(1, Infinity).state, "unavailable");
  });
});

describe("payment status classification", () => {
  test("every provider maps statuses to exactly one outcome", () => {
    const cases = [
      ["nowpayments", "finished", { credited: true }, "successful"],
      ["nowpayments", "finished", { credited: false }, "settling"],
      ["nowpayments", "waiting", {}, "pending"],
      ["nowpayments", "confirming", {}, "pending"],
      ["nowpayments", "partially_paid", {}, "partial"],
      ["nowpayments", "refunded", {}, "refunded"],
      ["nowpayments", "failed", {}, "failed"],
      ["nowpayments", "creation_failed", {}, "failed"],
      ["nowpayments", "expired", {}, "expired"],
      ["nowpayments", "creation_unknown", {}, "review"],
      ["nowpayments", "finished", { credited: false, recovery: true }, "review"],
      ["hooshpay", "paid", { credited: true }, "successful"],
      ["hooshpay", "pending", {}, "pending"],
      ["hooshpay", "reversed", {}, "refunded"],
      ["hooshpay", "cancelled", {}, "cancelled"],
      ["hooshpay", "failed", {}, "failed"],
      ["hooshpay", "expired", {}, "expired"],
      ["bank", "confirmed", { credited: true }, "successful"],
      ["bank", "waiting_for_approval", {}, "pending"],
      ["bank", "rejected", {}, "failed"],
      ["trx", "paid", { credited: true }, "successful"],
      ["trx", "unpaid", {}, "pending"],
      ["trx", "rejected", {}, "failed"],
      ["hooshpay", "something_new", {}, "other"],
    ];
    for (const [provider, status, flags, expected] of cases) {
      assert.equal(classifyPayment(provider, status, flags), expected, `${provider}/${status}`);
    }
  });

  test("success rate counts decided attempts only", () => {
    assert.equal(successRate({ successful: 3, failed: 1, cancelled: 0, expired: 0, pending: 50, partial: 9, refunded: 9, review: 9 }), 0.75);
    assert.equal(successRate({ successful: 0, failed: 0, pending: 10 }), null);
    assert.equal(successRate({}), null);
  });

  test("attempt rows are counted per invoice and tombstoned invoices are included once", () => {
    const summary = summarizeAttempts([
      { provider: "nowpayments", status: "finished", credited: true, recovery: false, count: 4 },
      { provider: "nowpayments", status: "waiting", credited: false, recovery: false, count: 2 },
      { provider: "nowpayments", status: "failed", credited: false, recovery: false, count: 1, fromTombstone: true },
      { provider: "hooshpay", status: "cancelled", credited: false, recovery: false, count: 3, fromTombstone: true },
      { provider: "hooshpay", status: "paid", credited: true, recovery: false, count: 1 },
    ]);
    assert.equal(summary.total, 11);
    assert.deepEqual([summary.outcomes.successful, summary.outcomes.pending, summary.outcomes.failed, summary.outcomes.cancelled], [5, 2, 1, 3]);
    assert.equal(summary.successRate, 5 / 9);
    assert.equal(summary.byProvider.hooshpay.cancelled, 3);
  });
});

function facts({ topups = [], sales = {}, refunds = { amount: 0, count: 0 }, attempts = [], users = {} } = {}) {
  const providers = ["hooshpay", "nowpayments", "trx", "bank"].map((provider) => {
    const found = topups.find((t) => t.provider === provider) || {};
    return { provider, amount: found.amount || 0, count: found.count || 0, series: found.series || [] };
  });
  return {
    topups: { providers, crypto: [] },
    attempts,
    refunds,
    sales: { amount: 0, count: 0, plans: [], series: [], refundAmount: 0, refundCount: 0, ...sales },
    users: { total: 0, created: 0, active: 0, newSeries: [], buyers: { current: 0, previous: 0, retained: 0 }, walletBalance: { total: 0, holders: 0 }, expiring: 0, activeServices: 0, ...users },
  };
}

describe("report assembly", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const range = resolveRange({ range: "7d", now });
  const gran = granularityFor(range.days);
  const kpiOf = (report, id) => report.kpis.find((k) => k.id === id);

  test("top-ups, sales and counts are separate families and never mixed", () => {
    const current = facts({
      topups: [{ provider: "nowpayments", amount: 500_000, count: 5, series: [{ _id: 6, amount: 500_000, count: 5 }] }, { provider: "hooshpay", amount: 100_000, count: 1 }],
      sales: { amount: 300_000, count: 3, refundAmount: 50_000, series: [{ _id: 6, amount: 300_000, count: 3 }] },
      refunds: { amount: 100_000, count: 1 },
      attempts: [{ provider: "nowpayments", status: "finished", credited: true, recovery: false, count: 5 }],
      users: { total: 100, created: 10, active: 40, walletBalance: { total: 900_000, holders: 8 }, buyers: { current: 3, previous: 2, retained: 1 }, activeServices: 20, expiring: 4 },
    });
    const previous = facts({ topups: [{ provider: "nowpayments", amount: 250_000, count: 2 }], sales: { amount: 100_000, count: 1 }, users: { created: 5, active: 30, buyers: { current: 1, previous: 0, retained: 0 } } });
    const report = assembleReport({ current, previous, range, now, granularity: gran });
    assert.equal(kpiOf(report, "topups_gross").value, 600_000);
    assert.equal(kpiOf(report, "topups_gross").group, "financial");
    assert.equal(kpiOf(report, "topups_net").value, 500_000);
    assert.equal(kpiOf(report, "topups_average").value, 100_000);
    assert.equal(kpiOf(report, "sales_gross").value, 300_000);
    assert.equal(kpiOf(report, "sales_gross").group, "sales");
    assert.equal(kpiOf(report, "sales_net").value, 250_000);
    assert.equal(kpiOf(report, "sales_average_order").value, 100_000);
    assert.equal(kpiOf(report, "wallet_balance_total").value, 900_000);
    assert.equal(kpiOf(report, "buyer_retention").value, 0.5);
    assert.deepEqual(kpiOf(report, "topups_gross").change, { pct: 1.4, delta: 350_000, state: "up" });
    assert.equal(kpiOf(report, "buyers_unique").previous, undefined === 1 ? 0 : 1, "previous period buyers come from the previous period itself");
    assert.equal(report.unit, "toman");
    assert.equal(report.timezone, "Asia/Tehran");
  });

  test("series puts values in the bucket of their credit time", () => {
    const current = facts({ topups: [{ provider: "bank", amount: 70, count: 1, series: [{ _id: 0, amount: 70, count: 1 }] }], sales: { series: [{ _id: 6, amount: 9, count: 2 }] }, users: { newSeries: [{ _id: 3, count: 4 }] } });
    const report = assembleReport({ current, previous: facts(), range, now, granularity: gran });
    assert.equal(report.series.length, 7);
    assert.equal(report.series[0].topups, 70);
    assert.equal(report.series[6].sales, 9);
    assert.equal(report.series[6].orders, 2);
    assert.equal(report.series[3].newUsers, 4);
    assert.equal(report.series[0].start, range.from.toISOString());
  });

  test("an empty period yields explicit nulls/zeros, never NaN or undefined, and stays JSON-safe", () => {
    const report = assembleReport({ current: facts(), previous: facts(), range, now, granularity: gran });
    assert.equal(kpiOf(report, "payment_success_rate").value, null);
    assert.equal(kpiOf(report, "sales_average_order").value, null);
    assert.equal(kpiOf(report, "sales_average_order").change.state, "unavailable");
    assert.equal(kpiOf(report, "topups_gross").value, 0);
    assert.equal(kpiOf(report, "topups_gross").change.state, "flat");
    const text = JSON.stringify(report);
    assert.equal(/NaN|Infinity|undefined/.test(text), false);
    assert.ok(report.series.every((row) => row.topups === 0 && row.sales === 0));
  });

  test("zero baseline is reported as no_baseline instead of infinity", () => {
    const report = assembleReport({ current: facts({ sales: { amount: 10, count: 1 } }), previous: facts(), range, now, granularity: gran });
    assert.deepEqual(kpiOf(report, "sales_gross").change, { pct: null, delta: 10, state: "no_baseline" });
  });

  test("every KPI has a definition, and unavailable data is explained rather than zeroed", () => {
    const report = assembleReport({ current: facts(), previous: facts(), range, now, granularity: gran });
    for (const item of report.kpis) assert.ok(DEFINITIONS[item.id], `definition for ${item.id}`);
    assert.ok(report.unavailable.some((u) => u.id === "renewal_trends" && u.reason.length > 20));
    assert.equal(report.unavailable.some((u) => u.id === "users_active_exact"), false, "range ending now is exact");
    const past = resolveRange({ range: "prevMonth", now });
    const pastReport = assembleReport({ current: facts(), previous: facts(), range: past, now, granularity: granularityFor(past.days) });
    assert.ok(pastReport.unavailable.some((u) => u.id === "users_active_exact"));
    assert.equal(kpiOf(pastReport, "users_active").exact, false);
  });

  test("failed and cancelled invoices removed by cleanup still count (via tombstones)", () => {
    const current = facts({ attempts: [
      { provider: "hooshpay", status: "failed", credited: false, recovery: false, count: 2, fromTombstone: true },
      { provider: "hooshpay", status: "paid", credited: true, recovery: false, count: 2 },
    ] });
    const report = assembleReport({ current, previous: facts(), range, now, granularity: gran });
    assert.equal(kpiOf(report, "payments_failed").value, 2);
    assert.equal(kpiOf(report, "payment_attempts").value, 4);
    assert.equal(kpiOf(report, "payment_success_rate").value, 0.5);
  });
});

describe("report service: authorization and caching", () => {
  beforeEach(() => clearAnalyticsCacheForTests());
  const now = new Date("2026-10-20T12:00:00Z");

  test("non-admins cannot read analytics", async () => {
    await assert.rejects(() => getAnalyticsReport({ actorId: 111, query: {}, now, collect: async () => facts() }), (e) => e.code === "forbidden");
    await assert.rejects(() => getAnalyticsReport({ actorId: undefined, now, collect: async () => facts() }), (e) => e.status === 403);
  });

  test("results are cached for a minute, flagged as cached, and refresh bypasses the cache", async () => {
    let calls = 0;
    const collect = async () => { calls += 1; return facts(); };
    const first = await getAnalyticsReport({ actorId: 424242, query: { range: "7d" }, now, collect });
    assert.equal(first.cache.cached, false);
    assert.equal(calls, 2, "current and previous period");
    const second = await getAnalyticsReport({ actorId: 424242, query: { range: "7d" }, now: new Date(now.getTime() + 20_000), collect });
    assert.equal(second.cache.cached, true);
    assert.equal(second.cache.ageSeconds, 20);
    assert.equal(calls, 2);
    const refreshed = await getAnalyticsReport({ actorId: 424242, query: { range: "7d" }, now: new Date(now.getTime() + 20_000), refresh: true, collect });
    assert.equal(refreshed.cache.cached, false);
    assert.equal(calls, 4);
    await getAnalyticsReport({ actorId: 424242, query: { range: "7d" }, now: new Date(now.getTime() + 90_000), collect });
    assert.equal(calls, 6, "expired after the freshness window");
  });

  test("different ranges and calendars never share a cache entry", async () => {
    let calls = 0;
    const collect = async () => { calls += 1; return facts(); };
    await getAnalyticsReport({ actorId: 424242, query: { range: "7d" }, now, collect });
    await getAnalyticsReport({ actorId: 424242, query: { range: "30d" }, now, collect });
    await getAnalyticsReport({ actorId: 424242, query: { range: "thisMonth", calendar: "jalali" }, now, collect });
    await getAnalyticsReport({ actorId: 424242, query: { range: "thisMonth", calendar: "gregorian" }, now, collect });
    assert.equal(calls, 8);
  });
});

describe("CSV export", () => {
  test("text cells that could be spreadsheet formulas are neutralised; numbers are untouched", () => {
    for (const hostile of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1", "  =HYPERLINK(\"http://x\")"]) {
      assert.ok(csvCell(hostile).startsWith("'") || csvCell(hostile).startsWith('"\''), hostile);
    }
    assert.equal(csvCell(-5), "-5");
    assert.equal(csvCell(1234567), "1234567");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(NaN), "");
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
    assert.equal(csvCell("line1\nline2"), "line1 line2");
  });

  test("the exported file contains the KPI table, series and plan data in a safe format", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const range = resolveRange({ range: "7d", now });
    const current = facts({ sales: { amount: 100, count: 1, plans: [{ planId: "p1", name: "=EVIL()", count: 1, amount: 100 }] } });
    const report = assembleReport({ current, previous: facts(), range, now, granularity: granularityFor(7) });
    const csv = reportToCsv(report);
    assert.ok(csv.startsWith("﻿section,id,group"));
    assert.ok(csv.includes("kpi,sales_gross,sales,100,0,"));
    assert.ok(csv.includes("'=EVIL()"));
    assert.equal(/(^|,)=EVIL/.test(csv), false);
    assert.ok(csv.split("\r\n").length > 30);
  });
});
