import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handleProfile, { EMPTY_RECENT_ORDERS, loadRecentProfileOrders } from "../../handlers/message/handleProfile.js";
import { ensureTelegramUser } from "../../services/users/ensureTelegramUser.js";

function historyModel(rows, capture = []) {
  return {
    find(query) {
      capture.push(query);
      return {
        sort() { return this; },
        limit() { return this; },
        async lean() { return rows; },
      };
    },
  };
}

describe("profile history and privacy", () => {
  test("cancelled and expired HooshPay/NOWPayments rows are excluded at query and output layers", async () => {
    const hooshQueries = [];
    const nowQueries = [];
    const orders = await loadRecentProfileOrders(123, {
      hooshModel: historyModel([
        { status: "Cancelled", amount: 1, createdAt: new Date("2026-01-04") },
        { status: "paid", amount: 20_000, createdAt: new Date("2026-01-03") },
      ], hooshQueries),
      nowPaymentsModel: historyModel([
        { status: "expired", amountToman: 1, createdAt: new Date("2026-01-05") },
        { status: "finished", amountToman: 30_000, createdAt: new Date("2026-01-02") },
      ], nowQueries),
      cryptoModel: historyModel([]),
      bankModel: historyModel([]),
    });

    assert.deepEqual(orders.map((item) => item.record.status), ["paid", "finished"]);
    assert.equal(hooshQueries[0].userId, 123);
    assert.deepEqual(hooshQueries[0].creationStatus.$in, [null, "created"]);
    assert.ok(hooshQueries[0].status.$nin.includes("cancelled"));
    assert.ok(hooshQueries[0].status.$nin.includes("expired"));
    assert.ok(nowQueries[0].status.$nin.includes("creation_failed"));
  });

  test("profile keeps required account fields, active services, and a Persian empty state without phone data", async () => {
    const sent = [];
    const bot = { async sendMessage(...args) { sent.push(args); } };
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const user = {
      telegramId: "123",
      firstName: "علی",
      lastName: "<تست>",
      username: "ali_user",
      phoneNumber: "+49123456789",
      balance: 125_000,
      successfulPayments: 4,
      referralCode: "SWIFT-TEST",
      createdAt: new Date("2025-01-01"),
      services: [
        { username: "active", expiresAt: future },
        { username: "expired", expiresAt: past },
        { username: "revoked", revokedAt: new Date(), expiresAt: future },
      ],
    };
    const empty = historyModel([]);
    await handleProfile(bot, 123, 123, {
      userModel: { async findOne() { return user; } },
      hooshModel: empty,
      nowPaymentsModel: empty,
      cryptoModel: empty,
      bankModel: empty,
    });

    assert.equal(sent.length, 1);
    const message = sent[0][1];
    assert.match(message, /شناسه کاربری: <code>123<\/code>/);
    assert.match(message, /علی &lt;تست&gt;/);
    assert.match(message, /@ali_user/);
    assert.match(message, /125,000 تومان/);
    assert.match(message, /خدمات فعال: <b>1<\/b> از 3 سرویس/);
    assert.match(message, /پرداخت‌های موفق: <b>4<\/b>/);
    assert.match(message, /SWIFT-TEST/);
    assert.ok(message.includes(EMPTY_RECENT_ORDERS));
    assert.equal(message.includes(user.phoneNumber), false);
    assert.doesNotMatch(message, /شماره (?:تلفن|موبایل)/);
  });

  test("minimal Telegram registration never writes contact or phone fields", async () => {
    let captured;
    const userModel = {
      async findOneAndUpdate(...args) { captured = args; return { telegramId: "123" }; },
    };
    await ensureTelegramUser({
      id: 123,
      first_name: " Mina ",
      last_name: "User",
      username: "mina",
      phone_number: "+491111111",
      contact: { phone_number: "+492222222" },
    }, { userModel, now: () => new Date("2026-01-01") });
    const serialized = JSON.stringify(captured);
    assert.equal(serialized.includes("phone"), false);
    assert.equal(serialized.includes("contact"), false);
    assert.equal(captured[1].$set.firstName, "Mina");
  });

  test("active runtime has no contact handler or phone-number checkout gate", () => {
    const botSource = readFileSync(new URL("../../bot.js", import.meta.url), "utf8");
    const profileSource = readFileSync(new URL("../../handlers/message/handleProfile.js", import.meta.url), "utf8");
    const receiptSource = readFileSync(new URL("../../paymentHandlers/handleBankRecipt.js", import.meta.url), "utf8");
    assert.doesNotMatch(botSource, /request_contact|contactHandler|on\(["']contact["']/);
    assert.doesNotMatch(profileSource, /phoneNumber|شماره تلفن|شماره موبایل/);
    assert.doesNotMatch(receiptSource, /phoneNumber|شماره تلفن|شماره موبایل/);
  });
});
