/**
 * Admin payment deletion against a REAL MongoDB (the unit tests use in-memory models, which cannot prove
 * Mongo operator semantics, unique indexes or atomic conditional deletes).
 *
 * Needs the guarded test database (tests/helpers/db.js: name must contain "test", unique per file);
 * skips with an explicit reason when MongoDB is not reachable.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";
const ADMIN = "424242";
const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let Hoosh, Now, Bank, Trx, Tombstone, AuditLog, User, WalletPurchase;
let svc, cleanup, ipn;
if (dbAvailable) {
  ({ default: Hoosh } = await import("../../models/HooshPayInvoice.js"));
  ({ default: Now } = await import("../../models/NowPaymentsInvoice.js"));
  ({ default: Bank } = await import("../../models/invoice.js"));
  ({ default: Trx } = await import("../../models/CryptoInvoice.js"));
  ({ default: Tombstone } = await import("../../models/PaymentTombstone.js"));
  ({ default: AuditLog } = await import("../../models/AdminAuditLog.js"));
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  svc = await import("../../services/admin/paymentDeletion.js");
  cleanup = await import("../../services/payments/invoiceCleanup.js");
  ipn = await import("../../services/nowpayments/ipnHandler.js");
}

after(async () => { await disconnectTestDB(); });

const H = 3_600_000;
const old = () => new Date(Date.now() - 200 * H);
const fresh = () => new Date(Date.now() - 2 * H);
let n = 0;
const op = () => `real-mongo-op-${String(++n).padStart(6, "0")}-abcdef`;
const nowFields = (extra) => ({ userId: 31, amountToman: 100000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "trx", tomanPerFiat: 1000, rateSource: "test", ...extra });
const trxFields = (extra) => ({ userId: 41, amount: 50000, usdAmount: 1, cryptoAmount: 10, currency: "TRX", ...extra });

beforeEach(async () => {
  if (!dbAvailable) return;
  await Promise.all([Hoosh, Now, Bank, Trx, Tombstone, AuditLog, User, WalletPurchase].map((model) => model.deleteMany({})));
});

describe("payment deletion on a real MongoDB", () => {
  skip("deletes eligible records from all four collections, writes tombstones and an audit row", async () => {
    await Hoosh.create({ uid: "H-FAILED", orderId: "OH1", userId: 11, amount: 150000, status: "failed" });
    await Hoosh.create({ uid: "H-OLD", orderId: "OH2", userId: 12, amount: 250000, status: "pending", createdAt: old() });
    await Now.create(nowFields({ orderId: "ON1", status: "failed" }));
    await Bank.create({ paymentId: "BANK-REJ", userId: 21, amount: 100000, status: "rejected" });
    await Trx.create(trxFields({ invoiceId: "TRX-OLD", status: "unpaid", createdAt: old() }));

    const keys = ["hooshpay:H-FAILED", "hooshpay:H-OLD", "nowpayments:ON1", "bank:BANK-REJ", "trx:TRX-OLD"];
    const preview = await svc.previewPaymentDeletion({ actorId: ADMIN, keys });
    assert.equal(preview.eligible, 5, JSON.stringify(preview.items));

    const result = await svc.deletePayments({ actorId: ADMIN, operationId: op(), keys, confirmCount: 5 });
    assert.equal(result.deleted, 5);
    assert.deepEqual(result.skipped, []);
    assert.equal(await Hoosh.countDocuments(), 0);
    assert.equal(await Now.countDocuments(), 0);
    assert.equal(await Bank.countDocuments(), 0);
    assert.equal(await Trx.countDocuments(), 0);

    const stones = await Tombstone.find({}).lean();
    assert.equal(stones.length, 5);
    assert.ok(stones.every((stone) => stone.deletedAt instanceof Date), "every tombstone is completed");
    assert.deepEqual(new Set(stones.map((stone) => stone.provider)), new Set(["hooshpay", "nowpayments", "bank", "trx"]));
    const audit = await AuditLog.findOne({ action: "PAYMENTS_DELETED" }).lean();
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.actorTelegramId, ADMIN);
  });

  skip("never deletes money-touching records, even when selected directly (real operator semantics for null/$in/$or)", async () => {
    await Hoosh.create({ uid: "H-PAIDAT", orderId: "OH3", userId: 1, amount: 1, status: "pending", createdAt: old(), paidAt: new Date() });
    await Hoosh.create({ uid: "H-TRACK", orderId: "OH4", userId: 1, amount: 1, status: "failed", trackingCode: "TRK1" });
    await Hoosh.create({ uid: "H-CRED", orderId: "OH5", userId: 1, amount: 1, status: "failed", balanceCredited: true });
    await Hoosh.create({ uid: "H-UNEXP", orderId: "OH6", userId: 1, amount: 1, status: "pending", createdAt: old(), expiresAt: new Date(Date.now() + H) });
    await Hoosh.create({ uid: "H-NEW", orderId: "OH7", userId: 1, amount: 1, status: "pending", createdAt: fresh() });
    await Now.create(nowFields({ orderId: "ON2", status: "failed", actuallyPaid: 5 }));
    await Now.create(nowFields({ orderId: "ON3", status: "confirming", createdAt: old() }));
    await Bank.create({ paymentId: "BANK-RCPT", userId: 1, amount: 1, status: "waiting_for_approval", receiptFileId: "f", createdAt: old() });
    await Trx.create(trxFields({ invoiceId: "TRX-PAID", status: "unpaid", createdAt: old(), transactionHash: "0xabc" }));

    const keys = ["hooshpay:H-PAIDAT", "hooshpay:H-TRACK", "hooshpay:H-CRED", "hooshpay:H-UNEXP", "hooshpay:H-NEW", "nowpayments:ON2", "nowpayments:ON3", "bank:BANK-RCPT", "trx:TRX-PAID"];
    for (const key of keys) {
      await assert.rejects(() => svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: [key], confirmCount: 1 }), { code: "payments_not_deletable" }, key);
    }
    assert.equal(await Hoosh.countDocuments(), 5);
    assert.equal(await Now.countDocuments(), 2);
    assert.equal(await Bank.countDocuments(), 1);
    assert.equal(await Trx.countDocuments(), 1);
    assert.equal(await Tombstone.countDocuments(), 0, "nothing was tombstoned for refused records");
  });

  skip("one ineligible record blocks the whole batch: nothing is deleted or tombstoned", async () => {
    await Hoosh.create({ uid: "H-OK", orderId: "OHA", userId: 1, amount: 1, status: "failed" });
    await Hoosh.create({ uid: "H-BAD", orderId: "OHB", userId: 1, amount: 1, status: "paid", balanceCredited: true });
    await assert.rejects(() => svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["hooshpay:H-OK", "hooshpay:H-BAD"], confirmCount: 2 }), { code: "payments_not_deletable" });
    assert.equal(await Hoosh.countDocuments(), 2);
    assert.equal(await Tombstone.countDocuments(), 0);
  });

  skip("a status that flips to paid after preflight is skipped by the atomic conditional delete", async () => {
    const doc = await Hoosh.create({ uid: "H-RACE", orderId: "OHR", userId: 1, amount: 1, status: "failed" });
    const realDelete = Hoosh.deleteOne.bind(Hoosh);
    Hoosh.deleteOne = async (filter, ...rest) => {
      // The webhook credits the invoice in the window between preflight and the delete.
      await Hoosh.updateOne({ _id: doc._id }, { $set: { status: "paid", balanceCredited: true, paidAt: new Date() } });
      return realDelete(filter, ...rest);
    };
    try {
      const result = await svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["hooshpay:H-RACE"], confirmCount: 1 });
      assert.equal(result.deleted, 0);
      assert.equal(result.skipped.length, 1);
    } finally {
      Hoosh.deleteOne = realDelete;
    }
    const survivor = await Hoosh.findOne({ uid: "H-RACE" }).lean();
    assert.ok(survivor, "the now-paid invoice survives");
    assert.equal(survivor.balanceCredited, true);
    assert.equal((await Tombstone.findOne({ orderId: "OHR" }).lean()).deletedAt ?? null, null, "unfinished tombstone stays visibly incomplete");
  });

  skip("concurrent requests delete a record once; the unique tombstone index holds", async () => {
    await Bank.create({ paymentId: "BANK-CONC", userId: 1, amount: 1, status: "rejected" });
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["bank:BANK-CONC"], confirmCount: 1 })));
    const deleted = settled.filter((entry) => entry.status === "fulfilled" && entry.value.deleted === 1).length;
    assert.equal(deleted, 1, JSON.stringify(settled.map((entry) => entry.status)));
    assert.equal(await Bank.countDocuments(), 0);
    assert.equal(await Tombstone.countDocuments({ provider: "bank", orderId: "BANK-CONC" }), 1);
  });

  skip("replaying the same operationId returns the first outcome and writes no second audit row or tombstone", async () => {
    await Bank.create({ paymentId: "BANK-IDEM", userId: 1, amount: 1, status: "rejected" });
    const operationId = op();
    const first = await svc.deletePayments({ actorId: ADMIN, operationId, keys: ["bank:BANK-IDEM"], confirmCount: 1 });
    const second = await svc.deletePayments({ actorId: ADMIN, operationId, keys: ["bank:BANK-IDEM"], confirmCount: 1 });
    assert.equal(first.deleted, 1);
    assert.equal(second.deleted, 1, "replay returns the stored outcome");
    assert.equal(await AuditLog.countDocuments({ action: "PAYMENTS_DELETED" }), 1);
    assert.equal(await Tombstone.countDocuments(), 1);
  });

  skip("wallet orders, balances and ledgers are untouched by deletions", async () => {
    await User.create({ telegramId: "11", balance: 777, appliedPaymentKeys: ["hoosh:keep"] });
    await WalletPurchase.create({ purchaseId: "wp_keep", telegramId: "11", planId: "p", planName: "p", gig: 1, days: 1, amount: 1, status: "completed" });
    await Hoosh.create({ uid: "H-DEL", orderId: "OHD", userId: 11, amount: 1, status: "failed" });
    await svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["hooshpay:H-DEL"], confirmCount: 1 });
    const user = await User.findOne({ telegramId: "11" }).lean();
    assert.equal(user.balance, 777);
    assert.deepEqual(user.appliedPaymentKeys, ["hoosh:keep"]);
    assert.equal(await WalletPurchase.countDocuments({ purchaseId: "wp_keep" }), 1);
    await assert.rejects(() => svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["wallet:wp_keep"], confirmCount: 1 }), { code: "wallet_order_not_deletable" });
  });

  skip("the 24h cleanup job and the admin deletion agree on tombstones (no duplicate tombstone for the same invoice)", async () => {
    await Hoosh.create({ uid: "H-BOTH", orderId: "OHBOTH", userId: 1, amount: 1, status: "failed", terminalStatusAt: old() });
    await svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["hooshpay:H-BOTH"], confirmCount: 1 });
    await cleanup.runInvoiceCleanupBatches({});
    assert.equal(await Tombstone.countDocuments({ orderId: "OHBOTH" }), 1);
  });

  skip("a late 'finished' IPN for a deleted stale NOWPayments invoice is acknowledged, recorded, alerts admins and credits nothing", async () => {
    process.env.GROUP_ID = "-100777";
    await User.create({ telegramId: "31", balance: 0 });
    await Now.create(nowFields({ orderId: "NP-LATE", status: "waiting", createdAt: old() }));
    await svc.deletePayments({ actorId: ADMIN, operationId: op(), keys: ["nowpayments:NP-LATE"], confirmCount: 1 });
    assert.equal(await Now.countDocuments(), 0);

    const { signNowPaymentsIpn } = await import("../../services/nowpayments/signature.js");
    const secret = "s".repeat(40);
    const payload = { order_id: "NP-LATE", payment_id: 9001, payment_status: "finished", price_amount: 1, price_currency: "usd", pay_amount: 10, actually_paid: 10, pay_currency: "trx" };
    const sent = [];
    const send = async () => {
      const req = { rawBody: Buffer.from(JSON.stringify(payload)), headers: { "x-nowpayments-sig": signNowPaymentsIpn(payload, secret) }, get(name) { return this.headers[name.toLowerCase()]; } };
      const res = { statusCode: null, body: null, headersSent: false, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
      await ipn.handleNowPaymentsIpn(req, res, { secret, bot: { sendMessage: async (...args) => { sent.push(args); } } });
      return res;
    };
    for (let i = 0; i < 3; i += 1) {
      const res = await send();
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ignored, "invoice_removed");
    }
    assert.equal((await User.findOne({ telegramId: "31" }).lean()).balance, 0, "no wallet credit, however many times it is redelivered");
    const stone = await Tombstone.findOne({ provider: "nowpayments", orderId: "NP-LATE" }).lean();
    assert.equal(stone.lateEventCount, 3);
    assert.equal(sent.length, 3);
    assert.equal(await Now.countDocuments(), 0, "the invoice is not resurrected");
  });
});
