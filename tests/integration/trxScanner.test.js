/**
 * TRX scanner crediting — REAL services/trxWalletScanner.js against a REAL
 * MongoDB.
 *
 * The scan loop itself talks to TronScan, but the money-moving part
 * (confirmInvoice / creditAndNotify / recoverStuckInvoices) is exercised
 * directly so the atomic claims are genuinely tested.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

process.env.GROUP_ID = ""; // suppress admin alerts

const dbAvailable = await connectTestDB();

let CryptoInvoice, User, trxScanner;
if (dbAvailable) {
  ({ default: CryptoInvoice } = await import("../../models/CryptoInvoice.js"));
  ({ default: User } = await import("../../models/User.js"));
  ({ default: trxScanner } = await import("../../services/trxWalletScanner.js"));
  trxScanner.setBotInstance(makeBotStub());
}

after(async () => {
  await disconnectTestDB();
});

const skip = () => (dbAvailable ? false : "MongoDB not reachable");

async function seedInvoice({ telegramId, amount = 50000, cryptoAmount = 12.5, invoiceId }) {
  await User.updateOne(
    { telegramId: String(telegramId) },
    { $set: { balance: 0 } },
    { upsert: true }
  );
  const id = invoiceId || `TRX${Date.now()}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const doc = await CryptoInvoice.create({
    invoiceId: id,
    userId: Number(telegramId),
    amount,
    usdAmount: amount / 60000,
    cryptoAmount,
    currency: "TRX",
    paymentType: "trx",
    status: "unpaid",
  });
  return doc;
}

const tx = (hash) => ({ hash, confirmed: true, contractRet: "SUCCESS", revert: false });

describe("TRX invoice confirmation", () => {
  test("a confirmed transaction credits the wallet once", skip(), async () => {
    const inv = await seedInvoice({ telegramId: "6001", amount: 50000 });
    const claimed = await trxScanner.confirmInvoice(inv, tx("hash_a_1"));
    assert.equal(claimed, true);

    const user = await User.findOne({ telegramId: "6001" });
    assert.equal(user.balance, 50000);

    const stored = await CryptoInvoice.findById(inv._id);
    assert.equal(stored.status, "paid");
    assert.equal(stored.balanceCredited, true);
    assert.equal(stored.transactionHash, "hash_a_1");
  });

  test("processing the same transaction twice credits only once", skip(), async () => {
    const inv = await seedInvoice({ telegramId: "6002", amount: 70000 });

    await trxScanner.confirmInvoice(inv, tx("hash_a_2"));
    await trxScanner.confirmInvoice(inv, tx("hash_a_2"));

    const user = await User.findOne({ telegramId: "6002" });
    assert.equal(user.balance, 70000, "second pass is a no-op");
    assert.equal(user.successfulPayments, 1);
  });

  test("10 CONCURRENT confirmations credit only once", skip(), async () => {
    const inv = await seedInvoice({ telegramId: "6003", amount: 123000 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => trxScanner.confirmInvoice(inv, tx("hash_a_3")))
    );

    assert.equal(results.filter(Boolean).length, 1, "exactly one worker wins the claim");
    const user = await User.findOne({ telegramId: "6003" });
    assert.equal(user.balance, 123000);
  });

  test("one on-chain transaction cannot settle two different invoices", skip(), async () => {
    const first = await seedInvoice({ telegramId: "6004", amount: 20000, cryptoAmount: 5, invoiceId: "TRXUNIQ1" });
    const second = await seedInvoice({ telegramId: "6005", amount: 20000, cryptoAmount: 5, invoiceId: "TRXUNIQ2" });

    const ok1 = await trxScanner.confirmInvoice(first, tx("hash_shared"));
    const ok2 = await trxScanner.confirmInvoice(second, tx("hash_shared"));

    assert.equal(ok1, true);
    assert.equal(ok2, false, "hash reuse is rejected by the unique sparse index");

    const u1 = await User.findOne({ telegramId: "6004" });
    const u2 = await User.findOne({ telegramId: "6005" });
    assert.equal(u1.balance, 20000);
    assert.equal(u2.balance, 0, "the second invoice was not settled by a reused hash");
  });

  test("a reverted transaction rejects the invoice and never credits", skip(), async () => {
    const inv = await seedInvoice({ telegramId: "6006", amount: 30000 });

    const rejected = await trxScanner.rejectInvoice(inv, {
      hash: "hash_revert_1",
      confirmed: false,
      contractRet: "REVERT",
      revert: true,
    });
    assert.equal(rejected, true);

    const user = await User.findOne({ telegramId: "6006" });
    assert.equal(user.balance, 0, "reverted transactions never credit");

    const stored = await CryptoInvoice.findById(inv._id);
    assert.equal(stored.status, "rejected");
  });

  test("a crash between claim and credit is repaired exactly once", skip(), async () => {
    const inv = await seedInvoice({ telegramId: "6007", amount: 44000 });

    // Simulate: Phase-1 committed, process died before Phase-2.
    await CryptoInvoice.findByIdAndUpdate(inv._id, {
      $set: { status: "paid", transactionHash: "hash_crash_1", confirmedAt: new Date() },
    });

    const stuck = await CryptoInvoice.findById(inv._id);
    assert.equal(stuck.balanceCredited, false);

    const repaired = await trxScanner.recoverStuckInvoices();
    assert.equal(repaired, 1, "one stuck invoice repaired");

    const user = await User.findOne({ telegramId: "6007" });
    assert.equal(user.balance, 44000, "the missing credit was applied");

    // A second sweep must not credit again.
    await trxScanner.recoverStuckInvoices();
    const after = await User.findOne({ telegramId: "6007" });
    assert.equal(after.balance, 44000, "recovery is idempotent");
  });
});

describe("TRX invoice matching", () => {
  test("matches within 1% tolerance and rejects larger deviations", skip(), async () => {
    await seedInvoice({ telegramId: "7001", amount: 10000, cryptoAmount: 100, invoiceId: "TRXMATCH1" });

    const close = await trxScanner.findMatchingInvoices(100.5); // 0.5% off
    const far = await trxScanner.findMatchingInvoices(120); // 20% off

    assert.equal(close.length, 1, "0.5% deviation matches");
    assert.equal(far.length, 0, "20% deviation does not match");
  });

  test("already-paid invoices are never matched again", skip(), async () => {
    const inv = await seedInvoice({ telegramId: "7002", amount: 10000, cryptoAmount: 55.5, invoiceId: "TRXPAID1" });
    await trxScanner.confirmInvoice(inv, tx("hash_paid_1"));

    const matches = await trxScanner.findMatchingInvoices(55.5);
    assert.equal(matches.length, 0, "settled invoices are excluded from matching");
  });
});
