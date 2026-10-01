/**
 * Manual (card-to-card) payment confirmation — REAL handleCallbackQuery against
 * a REAL MongoDB.
 *
 * Covers the two defects fixed here:
 *   1. the callback had NO admin authorization check, and
 *   2. a double-click credited the wallet twice,
 *   3. plus the amount was taken from callback_data instead of the database.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

const ADMIN_ID = 900001;
const GROUP_ID = -100999001;

process.env.ADMINS = String(ADMIN_ID);
process.env.GROUP_ID = String(GROUP_ID);

const dbAvailable = await connectTestDB();

let invoiceModel, User, handleCallbackQuery;
if (dbAvailable) {
  ({ default: invoiceModel } = await import("../../models/invoice.js"));
  ({ default: User } = await import("../../models/User.js"));
  ({ default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js"));
}

after(async () => {
  await disconnectTestDB();
});

const skip = () => (dbAvailable ? false : "MongoDB not reachable");

async function seed(paymentId, { userId = 5001, amount = 50000 } = {}) {
  await User.updateOne(
    { telegramId: String(userId) },
    { $set: { balance: 0 } },
    { upsert: true }
  );
  return invoiceModel.create({
    paymentId,
    userId: Number(userId),
    amount,
    paymentType: "bank",
    status: "waiting_for_approval",
  });
}

function makeQuery({ data, chatId = GROUP_ID, fromId = ADMIN_ID, messageId = 77 }) {
  return { id: `cb_${Math.random()}`, data, message: { chat: { id: chatId }, message_id: messageId }, from: { id: fromId } };
}

describe("admin bank payment confirmation", () => {
  test("an admin confirmation credits the wallet once", skip(), async () => {
    const inv = await seed("PAYOK01", { userId: 5101, amount: 50000 });
    const bot = makeBotStub();

    await handleCallbackQuery(bot, makeQuery({ data: `confirm_payment_5101_50,000_${inv.paymentId}` }));

    const user = await User.findOne({ telegramId: "5101" });
    assert.equal(user.balance, 50000);

    const stored = await invoiceModel.findOne({ paymentId: inv.paymentId });
    assert.equal(stored.status, "confirmed");
    assert.ok(stored.confirmedAt, "audit timestamp recorded");
    assert.equal(stored.confirmedBy, String(ADMIN_ID));
  });

  test("a rapid DOUBLE-CLICK credits the wallet only once", skip(), async () => {
    const inv = await seed("PAYDBL01", { userId: 5102, amount: 70000 });
    const bot = makeBotStub();
    const data = `confirm_payment_5102_70,000_${inv.paymentId}`;

    await handleCallbackQuery(bot, makeQuery({ data }));
    await handleCallbackQuery(bot, makeQuery({ data }));
    await handleCallbackQuery(bot, makeQuery({ data }));

    const user = await User.findOne({ telegramId: "5102" });
    assert.equal(user.balance, 70000, "credited exactly once across 3 clicks");
    assert.equal(user.successfulPayments, 1);
  });

  test("5 CONCURRENT confirmations credit the wallet only once", skip(), async () => {
    const inv = await seed("PAYCONC01", { userId: 5103, amount: 91000 });
    const bot = makeBotStub();
    const data = `confirm_payment_5103_91,000_${inv.paymentId}`;

    await Promise.all(
      Array.from({ length: 5 }, () => handleCallbackQuery(bot, makeQuery({ data })))
    );

    const user = await User.findOne({ telegramId: "5103" });
    assert.equal(user.balance, 91000, "exactly one credit under concurrency");
  });

  test("a NON-ADMIN cannot confirm a payment", skip(), async () => {
    const inv = await seed("PAYNONADM", { userId: 5104, amount: 88000 });
    const bot = makeBotStub();

    await handleCallbackQuery(
      bot,
      makeQuery({ data: `confirm_payment_5104_88,000_${inv.paymentId}`, fromId: 123456 })
    );

    const user = await User.findOne({ telegramId: "5104" });
    assert.equal(user.balance, 0, "non-admin click is rejected");

    const stored = await invoiceModel.findOne({ paymentId: inv.paymentId });
    assert.equal(stored.status, "waiting_for_approval", "invoice untouched");
  });

  test("an admin clicking OUTSIDE the admin group is rejected (forged/forwarded callback)", skip(), async () => {
    const inv = await seed("PAYFORGE", { userId: 5105, amount: 64000 });
    const bot = makeBotStub();

    await handleCallbackQuery(
      bot,
      makeQuery({ data: `confirm_payment_5105_64,000_${inv.paymentId}`, chatId: 424242 })
    );

    const user = await User.findOne({ telegramId: "5105" });
    assert.equal(user.balance, 0, "admin identity alone is not enough outside the group");
  });

  test("the credited amount comes from the DB, not from callback_data", skip(), async () => {
    const inv = await seed("PAYTAMPER", { userId: 5106, amount: 30000 });
    const bot = makeBotStub();

    // Attacker-controlled callback claiming a 999,999,999 payout.
    await handleCallbackQuery(
      bot,
      makeQuery({ data: `confirm_payment_5106_999,999,999_${inv.paymentId}` })
    );

    const user = await User.findOne({ telegramId: "5106" });
    assert.equal(user.balance, 30000, "only the persisted invoice amount is credited");
  });

  test("confirming an unknown payment id does not credit anyone", skip(), async () => {
    const bot = makeBotStub();

    await handleCallbackQuery(
      bot,
      makeQuery({ data: "confirm_payment_5107_50,000_DOESNOTEXIST" })
    );

    const user = await User.findOne({ telegramId: "5107" });
    assert.equal(user, null, "no user created/credited");
  });
});

describe("admin bank payment rejection", () => {
  test("a non-admin cannot reject a payment", skip(), async () => {
    const inv = await seed("PAYREJ01", { userId: 5201, amount: 40000 });
    const bot = makeBotStub();

    await handleCallbackQuery(
      bot,
      makeQuery({ data: `reject_payment_${inv.paymentId}_5201`, fromId: 999 })
    );

    const stored = await invoiceModel.findOne({ paymentId: inv.paymentId });
    assert.ok(stored, "invoice still present — rejection was denied");
  });

  test("an admin rejection removes the invoice and notifies the user", skip(), async () => {
    const inv = await seed("PAYREJ02", { userId: 5202, amount: 40000 });
    const bot = makeBotStub();

    await handleCallbackQuery(bot, makeQuery({ data: `reject_payment_${inv.paymentId}_5202` }));

    const stored = await invoiceModel.findOne({ paymentId: inv.paymentId });
    assert.equal(stored, null, "invoice deleted");

    const user = await User.findOne({ telegramId: "5202" });
    assert.equal(user.balance, 0, "rejection never credits");
  });
});
