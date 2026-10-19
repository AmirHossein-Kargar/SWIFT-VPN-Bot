import { describe, test } from "node:test";
import assert from "node:assert/strict";
import handleProfile, {
  EMPTY_RECENT_ORDERS,
  formatJalaliDate,
  formatToman,
  loadRecentProfileOrders,
  paymentStatusFa,
  renderProfileMessage,
} from "../../handlers/message/handleProfile.js";
import {
  ACTIVE_PENDING_WINDOW_MS,
  activeWindowQuery,
  eligibleRecentOrderStatusQuery,
  isVisibleRecentOrder,
} from "../../services/payments/status.js";

const NOW = new Date("2026-10-20T12:00:00Z").getTime();
const minutesAgo = (m) => new Date(NOW - m * 60_000);
const hoursAgo = (h) => new Date(NOW - h * 3_600_000);

function model(rows, queries = []) {
  return {
    find(query) {
      queries.push(query);
      return { sort() { return this; }, limit() { return this; }, async lean() { return rows; } };
    },
  };
}
const empty = model([]);
const load = (overrides) => loadRecentProfileOrders(1, { hooshModel: empty, nowPaymentsModel: empty, cryptoModel: empty, bankModel: empty, now: NOW, ...overrides });

describe("profile recent orders: which statuses are shown", () => {
  test("successful and genuinely active pending orders are shown", async () => {
    const orders = await load({
      nowPaymentsModel: model([
        { orderId: "NP-1", status: "finished", balanceCredited: true, amountToman: 50_000, createdAt: hoursAgo(3) },
        { orderId: "NP-2", status: "waiting", amountToman: 40_000, createdAt: minutesAgo(10) },
      ]),
      hooshModel: model([{ uid: "H1", status: "paid", balanceCredited: true, amount: 20_000, createdAt: hoursAgo(5) }]),
    });
    assert.deepEqual(orders.map((o) => o.record.status), ["waiting", "finished", "paid"]);
    assert.equal(paymentStatusFa("nowpayments", orders[1].record), "✅ موفق");
    assert.equal(paymentStatusFa("nowpayments", orders[0].record), "⏳ در انتظار پرداخت");
  });

  test("failed, cancelled, expired, rejected and creation_failed are hidden", async () => {
    const orders = await load({
      hooshModel: model([
        { uid: "a", status: "failed", amount: 1, createdAt: minutesAgo(1) },
        { uid: "b", status: "Cancelled", amount: 1, createdAt: minutesAgo(2) },
        { uid: "c", status: "expired", amount: 1, createdAt: minutesAgo(3) },
      ]),
      nowPaymentsModel: model([
        { orderId: "NP-x", status: "creation_failed", amountToman: 1, createdAt: minutesAgo(4) },
        { orderId: "NP-y", status: "expired", amountToman: 1, createdAt: minutesAgo(5) },
        { orderId: "NP-z", status: "failed", amountToman: 1, createdAt: minutesAgo(6) },
      ]),
      bankModel: model([{ paymentId: "b1", status: "rejected", amount: 1, createdAt: minutesAgo(7) }]),
      cryptoModel: model([{ invoiceId: "t1", status: "rejected", amount: 1, createdAt: minutesAgo(8) }]),
    });
    assert.deepEqual(orders, []);
  });

  test("the database predicate excludes the same unsuccessful statuses", async () => {
    const queries = [];
    await load({ hooshModel: model([], queries), nowPaymentsModel: model([], queries), bankModel: model([], queries), cryptoModel: model([], queries) });
    assert.equal(queries.length, 4);
    for (const query of queries) {
      for (const status of ["cancelled", "expired", "failed", "rejected", "creation_failed"]) {
        assert.ok(query.status.$nin.includes(status), status);
      }
      assert.ok(Array.isArray(query.$or), "age window is part of the query");
    }
    assert.deepEqual(eligibleRecentOrderStatusQuery().$nin.includes("failed"), true);
    const window = activeWindowQuery("nowpayments", NOW);
    assert.equal(window.$or[1].createdAt.$gte.getTime(), NOW - ACTIVE_PENDING_WINDOW_MS);
    assert.deepEqual(window.$or[2], { recoveryStatus: "required" });
  });

  test("partially paid, refunded and manual-review rows stay visible with their real label, never as success", async () => {
    const orders = await load({
      nowPaymentsModel: model([
        { orderId: "NP-p", status: "partially_paid", amountToman: 10_000, createdAt: minutesAgo(1) },
        { orderId: "NP-r", status: "refunded", amountToman: 20_000, createdAt: minutesAgo(2) },
        { orderId: "NP-m", status: "finished", balanceCredited: false, recoveryStatus: "required", amountToman: 30_000, createdAt: minutesAgo(3) },
        { orderId: "NP-u", status: "creation_unknown", recoveryStatus: "required", amountToman: 40_000, createdAt: hoursAgo(72) },
      ]),
    });
    const labels = orders.map((o) => paymentStatusFa(o.provider, o.record));
    assert.deepEqual(labels, ["⚠️ پرداخت ناقص", "↩️ بازگشت داده شد", "🔔 در حال بررسی", "🔔 در حال بررسی"]);
    assert.equal(labels.some((l) => l.includes("موفق")), false);
  });

  test("a paid order whose wallet credit is not recorded yet is 'settling', not successful", () => {
    assert.equal(paymentStatusFa("hoosh", { status: "paid", balanceCredited: false }), "⏳ در حال تسویه");
    assert.equal(paymentStatusFa("bank", { status: "confirmed", balanceCredited: true }), "✅ موفق");
  });

  test("abandoned pending invoices older than the active window are hidden, manual review is not", () => {
    assert.equal(isVisibleRecentOrder("nowpayments", { status: "waiting", createdAt: hoursAgo(30) }, NOW), false);
    assert.equal(isVisibleRecentOrder("nowpayments", { status: "waiting", createdAt: hoursAgo(2) }, NOW), true);
    assert.equal(isVisibleRecentOrder("bank", { status: "waiting_for_approval", createdAt: hoursAgo(2) }, NOW), true);
    assert.equal(isVisibleRecentOrder("nowpayments", { status: "waiting", createdAt: hoursAgo(30), recoveryStatus: "required" }, NOW), true);
    assert.equal(isVisibleRecentOrder("nowpayments", { status: "finished", createdAt: hoursAgo(900) }, NOW), true);
  });

  test("repeated open invoices collapse to the newest per provider and duplicates are removed", async () => {
    const orders = await load({
      nowPaymentsModel: model([
        { orderId: "NP-3", status: "waiting", amountToman: 3, createdAt: minutesAgo(1) },
        { orderId: "NP-2", status: "pending", amountToman: 2, createdAt: minutesAgo(2) },
        { orderId: "NP-1", status: "waiting", amountToman: 1, createdAt: minutesAgo(3) },
        { orderId: "NP-F", status: "finished", balanceCredited: true, amountToman: 9, createdAt: hoursAgo(1) },
        { orderId: "NP-F", status: "finished", balanceCredited: true, amountToman: 9, createdAt: hoursAgo(1) },
      ]),
    });
    assert.deepEqual(orders.map((o) => o.record.orderId), ["NP-3", "NP-F"]);
  });

  test("the list is newest-first and capped at five", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ uid: `H${i}`, status: "paid", balanceCredited: true, amount: 1000 + i, createdAt: hoursAgo(i + 1) }));
    const orders = await load({ hooshModel: model(rows) });
    assert.equal(orders.length, 5);
    assert.deepEqual(orders.map((o) => o.record.uid), ["H0", "H1", "H2", "H3", "H4"]);
  });
});

describe("profile layout", () => {
  const baseUser = { telegramId: "42", firstName: "سارا", lastName: null, username: null, balance: 1_250_000, successfulPayments: 3, referralCode: "SW-ABC", createdAt: new Date("2025-03-21T00:00:00Z") };

  test("renders the sections with Persian digits and tap-to-copy identifiers", () => {
    const text = renderProfileMessage({ user: baseUser, activeServices: 2, orders: [] });
    for (const heading of ["پروفایل من", "اطلاعات حساب", "کیف پول", "سرویس‌های من", "دعوت از دوستان", "آخرین سفارش‌ها"]) {
      assert.ok(text.includes(heading), heading);
    }
    assert.ok(text.includes("<code>42</code>"));
    assert.ok(text.includes("<code>SW-ABC</code>"));
    assert.ok(text.includes("<b>۱٬۲۵۰٬۰۰۰ تومان</b>"));
    assert.ok(text.includes(EMPTY_RECENT_ORDERS));
    assert.equal(/\d/.test(text.replace(/<code>[^<]*<\/code>/g, "")), false, "no Latin digits outside code spans");
  });

  test("missing username and name use fallbacks, and the referral block is omitted without a code", () => {
    const text = renderProfileMessage({ user: { ...baseUser, firstName: null, referralCode: null }, activeServices: 0, orders: [] });
    assert.equal((text.match(/ثبت نشده/g) || []).length, 2);
    assert.equal(text.includes("دعوت از دوستان"), false);
    assert.equal(text.includes("undefined") || text.includes("null"), false);
  });

  test("order lines show status, amount, provider and Jalali date", async () => {
    const orders = await load({ nowPaymentsModel: model([{ orderId: "NP-1", status: "finished", balanceCredited: true, amountToman: 50_000, createdAt: new Date("2026-10-18T10:00:00Z") }]) });
    const text = renderProfileMessage({ user: baseUser, activeServices: 1, orders });
    assert.ok(text.includes("✅ موفق · ۵۰٬۰۰۰ تومان"));
    assert.ok(text.includes("پرداخت با کریپتو · ۱۴۰۵/۰۷/۲۶"));
    assert.equal(formatJalaliDate(null), "—");
    assert.equal(formatToman("abc"), "۰ تومان");
  });

  test("handleProfile sends one HTML message and escapes user-controlled text", async () => {
    const sent = [];
    await handleProfile({ async sendMessage(...a) { sent.push(a); } }, 5, 42, {
      userModel: { async findOne() { return { ...baseUser, firstName: "<b>x</b>", services: [] }; } },
      hooshModel: empty, nowPaymentsModel: empty, cryptoModel: empty, bankModel: empty,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0][2].parse_mode, "HTML");
    assert.ok(sent[0][1].includes("&lt;b&gt;x&lt;/b&gt;"));
  });
});
