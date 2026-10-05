import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecentSuccessfulPayments,
  renderProfileMessage,
  successfulPaymentQuery,
} from "../../utils/profileView.js";

const date = (day) => new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`);

describe("profile payment history", () => {
  test("database filters use each provider's canonical settled status", () => {
    assert.deepEqual(successfulPaymentQuery("hoosh", "701"), {
      userId: 701,
      status: "paid",
      balanceCredited: true,
    });
    assert.deepEqual(successfulPaymentQuery("trx", 701), {
      userId: 701,
      paymentType: "trx",
      status: "paid",
      balanceCredited: true,
    });
    assert.deepEqual(successfulPaymentQuery("bank", 701), {
      userId: 701,
      paymentType: "bank",
      status: { $in: ["confirmed", "paid"] },
      balanceCredited: true,
    });
  });

  test("only fully credited paid/confirmed orders remain in the latest-four list", () => {
    const recentPayments = buildRecentSuccessfulPayments({
      hoosh: [
        { status: "pending", balanceCredited: false, amount: 10_000, createdAt: date(30) },
        { status: "expired", balanceCredited: false, amount: 11_000, createdAt: date(29) },
        { status: "cancelled", balanceCredited: false, amount: 12_000, createdAt: date(28) },
        { status: "failed", balanceCredited: false, amount: 13_000, createdAt: date(27) },
        { status: "reversed", balanceCredited: true, amount: 14_000, createdAt: date(26) },
        { status: "paid", balanceCredited: false, amount: 15_000, createdAt: date(25) },
        { status: "paid", balanceCredited: true, amount: 200_000, createdAt: date(24) },
      ],
      trx: [
        { status: "unpaid", paymentType: "trx", balanceCredited: false, amount: 20_000, createdAt: date(23) },
        { status: "rejected", paymentType: "trx", balanceCredited: false, amount: 21_000, createdAt: date(22) },
        { status: "paid", paymentType: "trx", balanceCredited: true, amount: 50_000, createdAt: date(21) },
      ],
      bank: [
        { status: "waiting_for_approval", paymentType: "bank", balanceCredited: false, amount: 30_000, createdAt: date(20) },
        { status: "rejected", paymentType: "bank", balanceCredited: false, amount: 31_000, createdAt: date(19) },
        { status: "confirmed", paymentType: "bank", balanceCredited: true, amount: 80_000, createdAt: date(18) },
      ],
    });

    assert.deepEqual(recentPayments.map(({ record }) => record.amount), [200_000, 50_000, 80_000]);
    assert.deepEqual(recentPayments.map(({ provider }) => provider), ["hoosh", "trx", "bank"]);
  });

  test("profile renders only successful payment lines and never renders phone fields", () => {
    const recentPayments = buildRecentSuccessfulPayments({
      hoosh: [
        { status: "expired", balanceCredited: false, amount: 50_000, createdAt: date(29) },
        { status: "paid", balanceCredited: true, amount: 200_000, createdAt: date(28) },
      ],
      trx: [],
      bank: [
        { status: "rejected", paymentType: "bank", balanceCredited: false, amount: 25_000, createdAt: date(27) },
      ],
    });
    const text = renderProfileMessage({
      user: {
        telegramId: "701",
        firstName: "آرمان",
        balance: 500_000,
        successfulPayments: 1,
        createdAt: date(1),
        // Legacy objects may still be passed during rolling deployments; the
        // profile renderer deliberately ignores all phone-related properties.
        phoneNumber: "09016405926",
      },
      activeServices: 2,
      serviceCount: 3,
      recentPayments,
      formattedJoinDate: "05/07/12",
      formatPaymentDate: (value) => value ? "05/07/12" : "—",
    });

    assert.match(text, /200,000.*✅ موفق/);
    assert.doesNotMatch(text, /منقضی|لغو|ناموفق|رد شده|pending|expired|cancelled|rejected/i);
    assert.doesNotMatch(text, /شماره تلفن|09016405926|phoneNumber/i);
    assert.match(text, /آخرین سفارش‌ها/);
  });
});
