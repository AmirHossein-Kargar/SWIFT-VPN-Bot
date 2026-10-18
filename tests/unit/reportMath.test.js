import { test, describe } from "node:test";
import assert from "node:assert/strict";
import moment from "moment-jalaali";
import escapeHtml, { escapeErrorMessage } from "../../utils/escapeHtml.js";
import {
  estimateCatalogConsumption,
  gregorianMonthWindow,
  invoiceAverage,
  jalaliMonthWindow,
  recentLocalMonths,
  summarizeUserRecords,
} from "../../services/admin/reportMath.js";

describe("escapeHtml", () => {
  test("escapes characters that would break a Telegram HTML message", () => {
    assert.equal(escapeHtml(`a<b>&"'`), "a&lt;b&gt;&amp;&quot;&#39;");
    assert.equal(escapeErrorMessage({ message: "<script>" }), "&lt;script&gt;");
    assert.equal(escapeErrorMessage({}), "خطای ناشناخته");
    assert.equal(escapeErrorMessage({ message: "x".repeat(500) }).length, 300);
  });
});

describe("admin report math", () => {
  test("user summary keeps the historical active/inactive split", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const summary = summarizeUserRecords([
      { balance: 10_000, totalServices: 0, successfulPayments: 1, createdAt: now },
      { balance: 0, totalServices: 2, successfulPayments: 0, createdAt: new Date("2020-01-01") },
      { balance: null, totalServices: null, successfulPayments: null, createdAt: null },
      { balance: 250_000, totalServices: 1, successfulPayments: 4, createdAt: new Date("2026-10-01T00:00:00Z") },
    ], now);
    assert.equal(summary.totalUsers, 4);
    assert.equal(summary.activeUsers, 2);
    assert.equal(summary.inactiveUsers, 1);
    assert.equal(summary.premiumUsers, 2);
    assert.equal(summary.totalBalance, 260_000);
    assert.equal(summary.totalServices, 3);
    assert.equal(summary.totalPayments, 5);
    assert.equal(summary.lowBalance, 1);
    assert.equal(summary.highBalance, 1);
    assert.equal(summary.avgBalance, 65_000);
  });

  test("catalog estimate consumes the most expensive plan first", () => {
    const result = estimateCatalogConsumption(250, [
      { price: 40, gig: 4, days: 7 },
      { price: 100, gig: 10, days: 30 },
    ]);
    assert.deepEqual(result, { estGigSold: 24, estDaysSold: 67, remaining: 10 });
    assert.deepEqual(estimateCatalogConsumption(0, []), { estGigSold: 0, estDaysSold: 0, remaining: 0 });
  });

  test("invoice average uses the paid count, never an undefined total", () => {
    assert.equal(invoiceAverage(300, 2), 150);
    assert.equal(invoiceAverage(300, 0), 0);
  });

  test("monthly window is the Jalali month named in the report, not the Gregorian month", () => {
    const now = new Date(2026, 9, 18, 15, 0, 0);
    const window = jalaliMonthWindow(now);
    const gregorian = gregorianMonthWindow(now);
    assert.equal(window.startOfMonth.getTime(), moment(now).startOf("jMonth").toDate().getTime());
    assert.equal(window.endOfMonth.getTime(), moment(now).endOf("jMonth").toDate().getTime());
    assert.equal(window.persianYear, moment(now).jYear());
    assert.equal(window.persianMonth, moment(now).jMonth() + 1);
    assert.equal(window.monthName, ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"][moment(now).jMonth()]);
    assert.notEqual(window.startOfMonth.getTime(), gregorian.startOfMonth.getTime());
    assert.ok(window.startOfMonth <= now && now <= window.endOfMonth);
    assert.ok(window.lastMonthEnd < window.startOfMonth);
  });

  test("recent local months stay newest-first and do not overlap", () => {
    const months = recentLocalMonths(3, new Date(2026, 9, 18, 8, 0, 0));
    assert.equal(months.length, 3);
    assert.ok(months[0].monthStart > months[1].monthStart);
    assert.ok(months[1].monthEnd < months[0].monthStart);
    assert.equal(months[0].monthStart.getDate(), 1);
    assert.equal(months[0].monthEnd.getHours(), 23);
  });
});
