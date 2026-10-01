/**
 * HooshPay fulfillment — REAL code against a REAL MongoDB.
 *
 * Exercises the two-phase, atomically-guarded credit path in
 * services/hooshpay/fulfillHooshOrder.js. These assertions depend on MongoDB's
 * findOneAndUpdate semantics, so a mock driver would prove nothing.
 *
 * Skipped automatically when no MongoDB is reachable.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

// Availability must be known BEFORE the test cases are declared, because the
// `skip` option is evaluated at declaration time.
const dbAvailable = await connectTestDB();

let HooshPayInvoice, User, fulfillHooshOrder;
if (dbAvailable) {
  ({ default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js"));
  ({ default: User } = await import("../../models/User.js"));
  ({ fulfillHooshOrder } = await import("../../services/hooshpay/fulfillHooshOrder.js"));
}

after(async () => {
  await disconnectTestDB();
});

async function seed({ telegramId = "1001", amount = 50000, uid = `inv_${Date.now()}_${Math.random()}` } = {}) {
  // Upsert so the same user can back several invoices in one test.
  await User.updateOne(
    { telegramId: String(telegramId) },
    { $setOnInsert: { balance: 0 } },
    { upsert: true }
  );
  const invoice = await HooshPayInvoice.create({
    uid,
    orderId: `HP-${uid}`,
    userId: Number(telegramId),
    amount,
    paymentUrl: "https://hooshpay.xyz/pay/x",
    status: "pending",
  });
  return invoice;
}

const opts = () => ({ skip: dbAvailable ? false : "MongoDB not reachable" });

describe("fulfillHooshOrder — real two-phase credit", () => {
  test("credits the wallet exactly once and sets both phase flags", opts(), async () => {
    const invoice = await seed({ telegramId: "2001", amount: 50000 });
    const bot = makeBotStub();

    await fulfillHooshOrder({ invoice, bot, chatId: invoice.userId, correlationId: "t1" });

    const user = await User.findOne({ telegramId: "2001" });
    const stored = await HooshPayInvoice.findById(invoice._id);

    assert.equal(user.balance, 50000, "balance credited once");
    assert.equal(user.successfulPayments, 1);
    assert.equal(stored.status, "paid");
    assert.equal(stored.fulfilled, true);
    assert.equal(stored.balanceCredited, true);
    assert.ok(bot.texts().some((t) => t.includes("پرداخت شما تأیید شد")), "user notified");
  });

  test("a duplicate fulfillment call does NOT credit again", opts(), async () => {
    const invoice = await seed({ telegramId: "2002", amount: 70000 });

    await fulfillHooshOrder({ invoice, bot: makeBotStub(), chatId: invoice.userId });
    await fulfillHooshOrder({ invoice, bot: makeBotStub(), chatId: invoice.userId });
    await fulfillHooshOrder({ invoice, bot: makeBotStub(), chatId: invoice.userId });

    const user = await User.findOne({ telegramId: "2002" });
    assert.equal(user.balance, 70000, "credited exactly once across sequential calls");
    assert.equal(user.successfulPayments, 1);
  });

  test("10 CONCURRENT fulfillments credit exactly once", opts(), async () => {
    const invoice = await seed({ telegramId: "2003", amount: 123000 });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fulfillHooshOrder({ invoice, bot: null, chatId: invoice.userId, correlationId: `c${i}` })
      )
    );

    const user = await User.findOne({ telegramId: "2003" });
    assert.equal(user.balance, 123000, "concurrent duplicate webhooks credited exactly once");
    assert.equal(user.successfulPayments, 1);

    const stored = await HooshPayInvoice.findById(invoice._id);
    assert.equal(stored.status, "paid");
    assert.equal(stored.balanceCredited, true);
  });

  test("crash between Phase-1 and Phase-2 is repaired exactly once", opts(), async () => {
    const invoice = await seed({ telegramId: "2004", amount: 30000 });

    // Simulate a crash after Phase 1 committed but before Phase 2 ran.
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
      $set: { fulfilled: true, fulfilledAt: new Date(), status: "paid", paidAt: new Date() },
    });

    const stuck = await HooshPayInvoice.findOne({ _id: invoice._id });
    assert.equal(stuck.fulfilled, true);
    assert.equal(stuck.balanceCredited, false);

    // Recovery path (what hooshpayRecoveryCron does)
    await fulfillHooshOrder({ invoice: stuck, bot: null, chatId: stuck.userId });

    const user = await User.findOne({ telegramId: "2004" });
    assert.equal(user.balance, 30000, "recovery credited the missing amount");

    // A second recovery pass must not credit again
    await fulfillHooshOrder({ invoice: await HooshPayInvoice.findById(invoice._id), bot: null, chatId: "2004" });
    const after = await User.findOne({ telegramId: "2004" });
    assert.equal(after.balance, 30000, "recovery is idempotent");
  });

  test("concurrent crash-recovery workers credit exactly once", opts(), async () => {
    const invoice = await seed({ telegramId: "2005", amount: 45000 });
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
      $set: { fulfilled: true, status: "paid", paidAt: new Date() },
    });

    const stuck = await HooshPayInvoice.findById(invoice._id);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        fulfillHooshOrder({ invoice: stuck, bot: null, chatId: stuck.userId })
      )
    );

    const user = await User.findOne({ telegramId: "2005" });
    assert.equal(user.balance, 45000, "8 concurrent recovery workers => one credit");
  });

  test("missing user leaves the invoice fulfilled without crediting anyone else", opts(), async () => {
    const invoice = await HooshPayInvoice.create({
      uid: `inv_nouser_${Date.now()}`,
      orderId: `HP-nouser-${Date.now()}`,
      userId: 999999,
      amount: 10000,
      paymentUrl: "https://hooshpay.xyz/pay/y",
      status: "pending",
    });
    const stranger = await User.create({ telegramId: "777", balance: 5 });

    await fulfillHooshOrder({ invoice, bot: null, chatId: 999999 });

    const after = await User.findOne({ telegramId: "777" });
    assert.equal(after.balance, 5, "no other user was credited");

    const stored = await HooshPayInvoice.findById(invoice._id);
    assert.equal(stored.fulfilled, true);
  });

  test("wallet balance is never overwritten by a concurrent payment (no lost update)", opts(), async () => {
    // Two different invoices for the SAME user, fulfilled concurrently.
    const a = await seed({ telegramId: "2006", amount: 10000, uid: `inv_a_${Date.now()}` });
    const b = await seed({ telegramId: "2006", amount: 25000, uid: `inv_b_${Date.now()}` });
    assert.ok(a && b);

    await Promise.all([
      fulfillHooshOrder({ invoice: a, bot: null, chatId: 2006 }),
      fulfillHooshOrder({ invoice: b, bot: null, chatId: 2006 }),
    ]);

    const user = await User.findOne({ telegramId: "2006" });
    assert.equal(user.balance, 35000, "$inc semantics preserved both credits");
    assert.equal(user.successfulPayments, 2);
  });
});
