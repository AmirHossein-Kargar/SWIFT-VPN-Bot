/**
 * Admin payment retry on a REAL MongoDB: an already-settled payment is an idempotent no-op and an ineligible one is
 * refused, and NEITHER mutates the record, touches the balance, calls a provider, or lands in the recovery queue.
 * Only a genuine, eligible attempt that really fails may flag a payment for manual recovery.
 *
 * Regression for: a second retry of a credited bank invoice threw 409 and, through the shared catch handler, flagged the
 * fully credited invoice recoveryStatus:"required" (so it appeared in the recovery queue). Every provider shared that path.
 *
 * Only DB-local paths are exercised (no HooshPay / NOWPayments / WizardXray / Telegram calls). Needs the guarded test
 * database (tests/helpers/db.js); skips when MongoDB is not reachable.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";
const ADMIN = "424242";
const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let User, Bank, Hoosh, Now, Trx, Wallet, AuditLog;
let payments, recovery;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: Bank } = await import("../../models/invoice.js"));
  ({ default: Hoosh } = await import("../../models/HooshPayInvoice.js"));
  ({ default: Now } = await import("../../models/NowPaymentsInvoice.js"));
  ({ default: Trx } = await import("../../models/CryptoInvoice.js"));
  ({ default: Wallet } = await import("../../models/WalletPurchase.js"));
  ({ default: AuditLog } = await import("../../models/AdminAuditLog.js"));
  payments = await import("../../services/admin/payments.js");
  recovery = await import("../../services/admin/recovery.js");
  await Promise.all([User, Bank, Hoosh, Now, Trx, Wallet, AuditLog].map((model) => model.init()));
}

after(async () => { await disconnectTestDB(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await Promise.all([User, Bank, Hoosh, Now, Trx, Wallet, AuditLog].map((model) => model.deleteMany({})));
});

let n = 0;
const op = () => `retry-regression-op-${String(++n).padStart(6, "0")}`;
const retry = (key, operationId = op()) => payments.retryPayment({ actorId: ADMIN, operationId, key });
const nowFields = (extra) => ({ userId: 31, amountToman: 100000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "trx", tomanPerFiat: 1000, rateSource: "test", ...extra });
const trxFields = (extra) => ({ userId: 41, amount: 50000, usdAmount: 1, cryptoAmount: 10, currency: "TRX", ...extra });
const inQueue = async (key) => (await recovery.getRecoveryQueue({ actorId: ADMIN, page: 1, pageSize: 100 })).items.some((item) => item.key === key);
const balanceOf = async (id) => (await User.findOne({ telegramId: String(id) }).lean()).balance;

/** Snapshot the whole stored document so ANY field change (retry stamps, flags, timestamps) is caught. */
const snapshot = (model, filter) => model.findOne(filter).lean();

async function assertNoOp(provider, key, model, filter, expectedStatus) {
  const before = await snapshot(model, filter);
  const result = await retry(key);
  assert.equal(result.ok, true);
  assert.equal(result.status, expectedStatus);
  assert.equal(result.noop, true);
  assert.deepEqual(await snapshot(model, filter), before, `${provider}: the record is byte-for-byte unchanged`);
  assert.equal(await inQueue(key), false, `${provider}: no false recovery-queue entry`);
  const audit = await AuditLog.findOne({ action: "PAYMENT_RETRIED", targetId: key.split(":")[1] }).lean();
  assert.equal(audit.status, "succeeded", "the request itself is still audited");
}

async function assertRefusedUnchanged(provider, key, model, filter, code) {
  const before = await snapshot(model, filter);
  // Some refused records (e.g. a paid-but-uncredited TRX invoice) legitimately sit in the recovery queue on their OWN state;
  // the invariant is that the retry neither flags them nor changes queue membership.
  const queuedBefore = await inQueue(key);
  await assert.rejects(() => retry(key), (error) => error.status === 409 && error.code === code, `${provider} refusal`);
  assert.deepEqual(await snapshot(model, filter), before, `${provider}: a refused retry writes nothing (no stamp, no recovery flag)`);
  assert.equal(before.recoveryStatus ?? "none", "none");
  assert.equal(await inQueue(key), queuedBefore, `${provider}: the refused retry did not change recovery-queue membership`);
}

describe("bank: the confirmed bug", () => {
  async function creditedAfterFirstRetry(id = 5001) {
    await User.create({ telegramId: String(id), balance: 0 });
    await Bank.create({ paymentId: `BANK-${id}`, userId: id, amount: 25_000, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: false, confirmedAt: new Date() });
    const first = await retry(`bank:BANK-${id}`);
    return first;
  }

  skip("the first retry of a confirmed-but-uncredited invoice credits exactly once and leaves it clean", async () => {
    const first = await creditedAfterFirstRetry();
    assert.equal(first.status, "credited");
    assert.equal(await balanceOf(5001), 25_000);
    const stored = await Bank.findOne({ paymentId: "BANK-5001" }).lean();
    assert.equal(stored.balanceCredited, true);
    assert.equal(stored.recoveryStatus, "none");
    assert.equal(stored.retryCount, 1);
  });

  skip("a second retry (new operationId) is an idempotent no-op: same response family, nothing changes, no recovery entry", async () => {
    await creditedAfterFirstRetry();
    await assertNoOp("bank", "bank:BANK-5001", Bank, { paymentId: "BANK-5001" }, "already_confirmed");
    assert.equal(await balanceOf(5001), 25_000, "never credited twice");
    const detail = await payments.getPaymentDetail({ actorId: ADMIN, key: "bank:BANK-5001" });
    assert.equal(detail.status, "fulfilled", "still shown as fulfilled, not recovery-required");
    assert.deepEqual(detail.actions, { retryVerification: false, retryFulfillment: false, manualResolve: false });
  });

  skip("many repeated retries never change the invoice or the balance", async () => {
    await creditedAfterFirstRetry();
    const before = await snapshot(Bank, { paymentId: "BANK-5001" });
    for (let i = 0; i < 5; i += 1) assert.equal((await retry("bank:BANK-5001")).status, "already_confirmed");
    assert.deepEqual(await snapshot(Bank, { paymentId: "BANK-5001" }), before);
    assert.equal(await balanceOf(5001), 25_000);
    assert.equal(await inQueue("bank:BANK-5001"), false);
  });

  skip("replaying the SAME operationId returns the recorded outcome and writes nothing more", async () => {
    await creditedAfterFirstRetry();
    const operationId = op();
    const first = await retry("bank:BANK-5001", operationId);
    const before = await snapshot(Bank, { paymentId: "BANK-5001" });
    const replay = await retry("bank:BANK-5001", operationId);
    assert.equal(replay.status, first.status);
    assert.deepEqual(await snapshot(Bank, { paymentId: "BANK-5001" }), before);
    assert.equal(await AuditLog.countDocuments({ operationId }), 1);
  });

  skip("concurrent retries of an uncredited invoice credit it exactly once and flag nothing", async () => {
    await User.create({ telegramId: "5002", balance: 0 });
    await Bank.create({ paymentId: "BANK-5002", userId: 5002, amount: 25_000, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: false, confirmedAt: new Date() });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => retry("bank:BANK-5002")));
    assert.equal(await balanceOf(5002), 25_000, "exactly one credit under concurrency");
    const stored = await Bank.findOne({ paymentId: "BANK-5002" }).lean();
    assert.equal(stored.balanceCredited, true);
    assert.equal(stored.recoveryStatus, "none", `no false flag; outcomes: ${JSON.stringify(results.map((r) => r.status === "fulfilled" ? r.value.status : r.reason.code))}`);
    assert.equal(await inQueue("bank:BANK-5002"), false);
  });

  skip("an ineligible invoice (receipt not yet confirmed) is refused with the established 409 and writes nothing", async () => {
    await Bank.create({ paymentId: "BANK-WAIT", userId: 5003, amount: 1, status: "waiting_for_approval", receiptFileId: "f" });
    await assertRefusedUnchanged("bank", "bank:BANK-WAIT", Bank, { paymentId: "BANK-WAIT" }, "bank_auto_verify_unavailable");
    await Bank.create({ paymentId: "BANK-LEGACY", userId: 5004, amount: 1, status: "confirmed", balanceCredited: false }); // no ledger version => never auto-replayed
    await assertRefusedUnchanged("bank", "bank:BANK-LEGACY", Bank, { paymentId: "BANK-LEGACY" }, "bank_auto_verify_unavailable");
  });

  skip("a GENUINE eligible attempt that really fails still flags recovery (behaviour preserved)", async () => {
    await Bank.create({ paymentId: "BANK-NOUSER", userId: 5005, amount: 25_000, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: false, confirmedAt: new Date() }); // no User row
    await assert.rejects(() => retry("bank:BANK-NOUSER"), (error) => /^bank_/.test(error.code));
    const stored = await Bank.findOne({ paymentId: "BANK-NOUSER" }).lean();
    assert.equal(stored.balanceCredited, false);
    assert.equal(stored.recoveryStatus, "required", "a real failed recovery attempt needs a human");
    assert.equal(stored.retryCount, 1, "the attempt was stamped");
  });

  skip("a settled invoice that was ALREADY (wrongly) flagged is left exactly as it is by a retry", async () => {
    await User.create({ telegramId: "5006", balance: 25_000 });
    await Bank.create({ paymentId: "BANK-FLAGGED", userId: 5006, amount: 25_000, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: true, balanceCreditedAt: new Date(), recoveryStatus: "required", recoveryReason: "old false flag" });
    const before = await snapshot(Bank, { paymentId: "BANK-FLAGGED" });
    const result = await retry("bank:BANK-FLAGGED");
    assert.equal(result.noop, true);
    assert.deepEqual(await snapshot(Bank, { paymentId: "BANK-FLAGGED" }), before, "retry neither clears nor adds flags; manual 'resolve' is the way to clear it");
  });
});

describe("every provider sharing the retry path", () => {
  skip("hooshpay: settled -> no-op; ineligible -> refused; neither writes", async () => {
    await User.create({ telegramId: "11", balance: 120_000 });
    await Hoosh.create({ uid: "H-SETTLED", orderId: "OH1", userId: 11, amount: 120_000, status: "paid", balanceCredited: true, balanceCreditedAt: new Date(), fulfilled: true, paidAt: new Date() });
    await assertNoOp("hooshpay", "hooshpay:H-SETTLED", Hoosh, { uid: "H-SETTLED" }, "already-fulfilled");
    assert.equal(await balanceOf(11), 120_000);
    await Hoosh.create({ uid: "H-FAILED", orderId: "OH2", userId: 11, amount: 1, status: "failed" });
    await assertRefusedUnchanged("hooshpay", "hooshpay:H-FAILED", Hoosh, { uid: "H-FAILED" }, "payment_not_retryable");
  });

  skip("nowpayments: settled -> no-op; ineligible (no provider id / terminal) -> refused; neither writes", async () => {
    await Now.create(nowFields({ orderId: "NP-SETTLED", status: "finished", paymentId: "9001", balanceCredited: true, balanceCreditedAt: new Date() }));
    await assertNoOp("nowpayments", "nowpayments:NP-SETTLED", Now, { orderId: "NP-SETTLED" }, "already_credited");
    await Now.create(nowFields({ orderId: "NP-NOID", status: "waiting" }));
    await assertRefusedUnchanged("nowpayments", "nowpayments:NP-NOID", Now, { orderId: "NP-NOID" }, "payment_not_retryable");
    await Now.create(nowFields({ orderId: "NP-FAILED", status: "failed", paymentId: "9002" }));
    await assertRefusedUnchanged("nowpayments", "nowpayments:NP-FAILED", Now, { orderId: "NP-FAILED" }, "payment_not_retryable");
  });

  skip("trx: settled -> no-op; unpaid / unversioned -> refused; neither writes", async () => {
    await Trx.create(trxFields({ invoiceId: "TRX-SETTLED", status: "paid", balanceCredited: true, balanceCreditedAt: new Date(), creditLedgerVersion: 2, transactionHash: "0xabc" }));
    await assertNoOp("trx", "trx:TRX-SETTLED", Trx, { invoiceId: "TRX-SETTLED" }, "already-fulfilled");
    await Trx.create(trxFields({ invoiceId: "TRX-UNPAID", status: "unpaid" }));
    await assertRefusedUnchanged("trx", "trx:TRX-UNPAID", Trx, { invoiceId: "TRX-UNPAID" }, "payment_not_retryable");
    await Trx.create(trxFields({ invoiceId: "TRX-OLDLEDGER", status: "paid", balanceCredited: false, transactionHash: "0xdef" })); // no ledger version
    await assertRefusedUnchanged("trx", "trx:TRX-OLDLEDGER", Trx, { invoiceId: "TRX-OLDLEDGER" }, "payment_not_retryable");
  });

  skip("wallet orders: completed -> no-op; stalled provisioning -> refused without being flagged", async () => {
    await Wallet.create({ purchaseId: "wp_done", telegramId: "11", planId: "p", planName: "p", gig: 1, days: 1, amount: 1, status: "completed", completedAt: new Date(), notificationPending: false });
    await assertNoOp("wallet", "wallet:wp_done", Wallet, { purchaseId: "wp_done" }, "already-completed");
    await Wallet.create({ purchaseId: "wp_stalled", telegramId: "11", planId: "p", planName: "p", gig: 1, days: 1, amount: 1, status: "provisioning" });
    const before = await snapshot(Wallet, { purchaseId: "wp_stalled" });
    await assert.rejects(() => retry("wallet:wp_stalled"), (error) => error.code === "non_idempotent_provisioning_blocked" && error.status === 409);
    assert.deepEqual(await snapshot(Wallet, { purchaseId: "wp_stalled" }), before);
  });
});

describe("shared consumers of the retry path", () => {
  skip("the recovery batch treats settled invoices as success and never flags or stamps them", async () => {
    await User.create({ telegramId: "5001", balance: 25_000 });
    await Bank.create({ paymentId: "B-SET-1", userId: 5001, amount: 1, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: true, balanceCreditedAt: new Date() });
    await Hoosh.create({ uid: "H-SET-1", orderId: "OHS", userId: 5001, amount: 1, status: "paid", balanceCredited: true, fulfilled: true });
    const beforeBank = await snapshot(Bank, { paymentId: "B-SET-1" });
    const beforeHoosh = await snapshot(Hoosh, { uid: "H-SET-1" });
    const result = await recovery.retrySafeRecoveryItems({ actorId: ADMIN, operationId: op(), keys: ["bank:B-SET-1", "hooshpay:H-SET-1"] });
    assert.equal(result.attempted, 2);
    assert.equal(result.succeeded, 2);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(await snapshot(Bank, { paymentId: "B-SET-1" }), beforeBank);
    assert.deepEqual(await snapshot(Hoosh, { uid: "H-SET-1" }), beforeHoosh);
  });

  skip("the detail `actions` and the retry always agree: a retry is offered only when it can run", async () => {
    await Bank.create({ paymentId: "B-ELIG", userId: 1, amount: 1, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: false });
    await Bank.create({ paymentId: "B-DONE", userId: 1, amount: 1, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: true });
    await Bank.create({ paymentId: "B-WAIT", userId: 1, amount: 1, status: "waiting_for_approval" });
    await Hoosh.create({ uid: "H-PEND", orderId: "OHP", userId: 1, amount: 1, status: "pending" });
    await Hoosh.create({ uid: "H-PAID-UNCREDITED", orderId: "OHU", userId: 1, amount: 1, status: "paid", balanceCredited: false });
    await Hoosh.create({ uid: "H-DONE", orderId: "OHD", userId: 1, amount: 1, status: "paid", balanceCredited: true });
    await Wallet.create({ purchaseId: "wp_a", telegramId: "1", planId: "p", planName: "p", gig: 1, days: 1, amount: 1, status: "completed", notificationPending: false });
    await Wallet.create({ purchaseId: "wp_b", telegramId: "1", planId: "p", planName: "p", gig: 1, days: 1, amount: 1, status: "completed", notificationPending: true });
    const actions = async (key) => (await payments.getPaymentDetail({ actorId: ADMIN, key })).actions;
    assert.deepEqual([(await actions("bank:B-ELIG")).retryFulfillment, (await actions("bank:B-DONE")).retryFulfillment, (await actions("bank:B-WAIT")).retryFulfillment], [true, false, false]);
    assert.deepEqual([(await actions("hooshpay:H-PEND")).retryVerification, (await actions("hooshpay:H-PEND")).retryFulfillment], [true, false]);
    assert.deepEqual([(await actions("hooshpay:H-PAID-UNCREDITED")).retryVerification, (await actions("hooshpay:H-PAID-UNCREDITED")).retryFulfillment], [false, true]);
    assert.equal((await actions("hooshpay:H-DONE")).retryFulfillment, false);
    assert.deepEqual([(await actions("wallet:wp_a")).retryFulfillment, (await actions("wallet:wp_b")).retryFulfillment], [false, true]);
  });

  skip("retryPlan is pure and total: every provider/status combination yields exactly one outcome and never throws", async () => {
    const providers = ["hooshpay", "nowpayments", "bank", "trx", "wallet"];
    const statuses = ["pending", "paid", "confirmed", "finished", "failed", "expired", "refunded", "unpaid", "rejected", "waiting_for_approval", "completed", "provisioned", "provisioning", "uncertain", "manual_review"];
    for (const provider of providers) {
      for (const status of statuses) {
        for (const balanceCredited of [true, false]) {
          for (const creditLedgerVersion of [2, undefined]) {
            const plan = payments.retryPlan(provider, { status, balanceCredited, creditLedgerVersion, paymentId: "x", notificationPending: false });
            assert.ok(["settled", "refuse", "attempt"].includes(plan.kind), `${provider}/${status}`);
            if (balanceCredited && provider !== "wallet") assert.equal(plan.kind, "settled", `${provider}/${status}: a credited record is never re-attempted`);
          }
        }
      }
    }
    assert.equal(payments.retryPlan("nope", {}).error.code, "invalid_payment_provider");
  });
});

describe("stalled wallet provisioning stays discoverable and actionable (refused retry must not be the only way to flag it)", () => {
  const STALE = () => new Date(Date.now() - 30 * 60_000);
  const queueItem = async (key) => (await recovery.getRecoveryQueue({ actorId: ADMIN, page: 1, pageSize: 100 })).items.find((item) => item.key === key);

  skip("discoverable by STATE in the recovery queue (no flag needed); the retry is refused without writes; the operator path works and is audited without any financial change", async () => {
    await User.create({ telegramId: "6001", balance: 50_000 });
    await Wallet.create({ purchaseId: "wp_stalled_flow", telegramId: "6001", planId: "p", planName: "Stalled plan", gig: 10, days: 30, amount: 90_000, status: "provisioning", provisioningStartedAt: STALE(), walletDebitStatus: "reserved" });
    const key = "wallet:wp_stalled_flow";

    // 1. Discoverable without any recovery flag.
    const found = await queueItem(key);
    assert.ok(found, "a stalled provisioning order is listed in the recovery queue");
    assert.equal(found.kind, "provisioning-stalled");
    assert.equal(found.provider, "wallet");
    assert.equal((await Wallet.findOne({ purchaseId: "wp_stalled_flow" }).lean()).recoveryStatus ?? "none", "none");

    // 2. The retry is refused (the provider create call is not idempotent) and writes nothing; it stays discoverable.
    const before = await snapshot(Wallet, { purchaseId: "wp_stalled_flow" });
    await assert.rejects(() => retry(key), (error) => error.status === 409 && error.code === "non_idempotent_provisioning_blocked");
    assert.deepEqual(await snapshot(Wallet, { purchaseId: "wp_stalled_flow" }), before);
    assert.ok(await queueItem(key), "still listed after the refused retry");

    // 3. The operator can act: resolving an unflagged stalled order first needs the explicit flag (audited), then the disposition.
    await assert.rejects(() => payments.resolvePaymentRecovery({ actorId: ADMIN, operationId: op(), key, reason: "operator checked the VPN panel manually" }), (error) => error.code === "not_recovery_required");
    const detailBefore = await payments.getPaymentDetail({ actorId: ADMIN, key });
    assert.equal(detailBefore.actions.manualResolve, false);
    await payments.markPaymentRecoveryRequired({ actorId: ADMIN, operationId: op(), key, reason: "stalled for 30 minutes, checking the VPN panel" });
    const flagged = await payments.getPaymentDetail({ actorId: ADMIN, key });
    assert.equal(flagged.status, "recovery-required");
    assert.equal(flagged.actions.manualResolve, true, "the 'Mark resolved' action is now available");
    const resolved = await payments.resolvePaymentRecovery({ actorId: ADMIN, operationId: op(), key, reason: "VPN created manually and delivered to the customer" });
    assert.equal(resolved.recoveryStatus, "resolved");
    assert.equal(resolved.financialMutation, false);

    // 4. Disposition only: no wallet, order-state or balance change, and every operator step is in the audit log.
    const after = await Wallet.findOne({ purchaseId: "wp_stalled_flow" }).lean();
    assert.equal(after.status, "provisioning", "marking/resolving never provisions, completes, refunds or credits");
    assert.equal(after.walletDebitStatus, "reserved");
    assert.equal(await balanceOf(6001), 50_000);
    const actions = (await AuditLog.find({ targetId: "wp_stalled_flow" }).sort({ createdAt: 1 }).lean()).map((entry) => `${entry.action}:${entry.status}`);
    // The refused retry and the refused (unflagged) resolve are audited too, so the trail shows exactly what the operator tried.
    assert.deepEqual(actions, ["PAYMENT_RETRIED:failed", "PAYMENT_MANUALLY_RESOLVED:failed", "PAYMENT_MARKED_RECOVERY_REQUIRED:succeeded", "PAYMENT_MANUALLY_RESOLVED:succeeded"]);
  });

  skip("a purchase still within the 10-minute grace period is not yet queued, and a retry still writes nothing", async () => {
    await Wallet.create({ purchaseId: "wp_fresh", telegramId: "6002", planId: "p", planName: "p", gig: 1, days: 1, amount: 1, status: "provisioning", provisioningStartedAt: new Date() });
    assert.equal(await queueItem("wallet:wp_fresh"), undefined);
    const before = await snapshot(Wallet, { purchaseId: "wp_fresh" });
    await assert.rejects(() => retry("wallet:wp_fresh"), (error) => error.code === "non_idempotent_provisioning_blocked");
    assert.deepEqual(await snapshot(Wallet, { purchaseId: "wp_fresh" }), before);
  });
});
