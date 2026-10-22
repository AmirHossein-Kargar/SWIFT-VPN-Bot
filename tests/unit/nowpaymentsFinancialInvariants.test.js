import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { notifyNowPaymentsCredit } from "../../services/nowpayments/notify.js";
import { recoverNowPaymentsInvoices } from "../../services/nowpayments/recovery.js";
import { makeFakeInvoiceModel } from "../helpers/fakeNowPaymentsInvoiceModel.js";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

const ORDER = "NP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = `nowpayments:${ORDER}`;

function invoice(overrides = {}) {
  return {
    orderId: ORDER, userId: 9500, amountToman: 50_000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "usdttrc20",
    ticker: "USDT", network: "TRC20", invoiceId: "6001", invoiceUrl: "https://nowpayments.io/payment/?iid=6001",
    paymentId: null, payAmount: null, status: "pending", balanceCredited: false, createdAt: new Date(), ...overrides,
  };
}
function ipn(overrides = {}) {
  return {
    payment_id: "7001", invoice_id: "6001", order_id: ORDER, payment_status: "finished", price_amount: 1, price_currency: "usd",
    pay_amount: 15, actually_paid: 15, pay_currency: "usdttrc20", ...overrides,
  };
}
const world = (invoiceOverrides = {}, balance = 100) => {
  const model = makeFakeInvoiceModel([invoice(invoiceOverrides)]);
  const users = makeFakeWalletModels([{ telegramId: "9500", balance }]);
  const apply = (payload) => applyNowPaymentsUpdate({ payload, invoiceModel: model, userModel: users.userModel });
  return { model, users, apply, balance: () => users.users.get("9500").balance, row: () => model.docs.get(ORDER) };
};

describe("a verified payment credits an eligible order at most once", () => {
  test("pending, waiting, confirming, confirmed, sending, partially_paid, failed, expired never credit", async () => {
    for (const status of ["waiting", "pending", "confirming", "confirmed", "sending", "partially_paid", "failed", "expired"]) {
      const w = world();
      const out = await w.apply(ipn({ payment_status: status, actually_paid: status === "partially_paid" ? 1 : 15 }));
      assert.equal(out.credited, false, status);
      assert.equal(w.balance(), 100, status);
      assert.equal(w.row().balanceCredited, false, status);
    }
  });

  test("unknown provider states are rejected and change nothing", async () => {
    const w = world();
    for (const status of ["mystery", "", "paid", "done", null, 7, undefined]) {
      const out = await w.apply(ipn({ payment_status: status }));
      assert.equal(out.outcome, "invalid_status", String(status));
    }
    assert.equal(w.balance(), 100);
    assert.equal(w.row().status, "pending");
  });

  test("ten concurrent finished deliveries (replays) credit exactly once and leave one ledger key", async () => {
    const w = world();
    const results = await Promise.all(Array.from({ length: 10 }, () => w.apply(ipn())));
    assert.equal(results.filter((r) => r.credited).length, 1);
    assert.equal(w.balance(), 50_100);
    assert.deepEqual(w.users.users.get("9500").appliedPaymentKeys, [KEY]);
    assert.equal(w.row().balanceCredited, true);
    assert.equal(w.users.users.get("9500").successfulPayments, 1);
  });

  test("a stale non-final IPN after settlement changes neither the status nor the balance", async () => {
    const w = world();
    await w.apply(ipn());
    for (const status of ["waiting", "confirming", "sending", "partially_paid", "failed", "expired"]) {
      await w.apply(ipn({ payment_status: status }));
    }
    assert.equal(w.row().status, "finished");
    assert.equal(w.balance(), 50_100);
  });

  test("out-of-order progress never moves a payment backwards", async () => {
    const w = world();
    await w.apply(ipn({ payment_status: "confirming", actually_paid: 0 }));
    await w.apply(ipn({ payment_status: "waiting", actually_paid: 0 }));
    assert.equal(w.row().status, "confirming");
    await w.apply(ipn({ payment_status: "sending" }));
    await w.apply(ipn({ payment_status: "confirming" }));
    assert.equal(w.row().status, "sending");
    assert.equal(w.balance(), 100);
  });

  test("the credit is the Toman amount the customer confirmed, whatever the crypto amount", async () => {
    const over = world();
    const out = await over.apply(ipn({ actually_paid: 99 }));
    assert.equal(out.credited, true);
    assert.equal(over.balance(), 50_100);
    assert.equal(over.row().overpaidAmount, 84);
  });
});

describe("underpayment, partial payment and tampering never credit", () => {
  test("finished with actually_paid below pay_amount is held for review", async () => {
    const w = world();
    const out = await w.apply(ipn({ actually_paid: 14.99999 }));
    assert.equal(out.credited, false);
    assert.equal(w.balance(), 100);
    assert.equal(w.row().recoveryStatus, "required");
    assert.equal(w.row().recoveryReason, "crypto_amount_mismatch");
  });

  test("partially_paid records the shortfall for review and credits nothing", async () => {
    const w = world();
    const out = await w.apply(ipn({ payment_status: "partially_paid", actually_paid: 5 }));
    assert.equal(out.credited, false);
    assert.equal(w.row().recoveryReason, "partially_paid_underpayment");
    assert.equal(w.row().underpaidAmount, 10);
    assert.equal(w.balance(), 100);
  });

  test("wrong order currency, network code, fiat amount, invoice id or payment id are refused", async () => {
    const cases = [
      [{ pay_currency: "usdtbsc" }, "pay_currency_mismatch"],
      [{ price_currency: "eur" }, "currency_mismatch"],
      [{ price_amount: 0.99 }, "amount_mismatch"],
      [{ invoice_id: "6002" }, "invoice_mismatch"],
      [{ invoice_id: "" }, "missing_provider_id"],
      [{ payment_id: null }, "missing_provider_id"],
    ];
    for (const [override, reason] of cases) {
      const w = world();
      const out = await w.apply(ipn(override));
      assert.equal(out.credited, false, reason);
      assert.equal(out.reason, reason);
      assert.equal(w.balance(), 100);
      assert.equal(w.row().status, "pending");
    }
  });

  test("a second payment id on an already-bound invoice cannot settle it again", async () => {
    const w = world();
    await w.apply(ipn());
    const out = await w.apply(ipn({ payment_id: "7002" }));
    assert.equal(out.credited, false);
    assert.equal(w.balance(), 50_100);
  });

  test("a pay_amount that differs from the one bound to the invoice is refused", async () => {
    const w = world({ payAmount: 15, paymentId: "7001" });
    const out = await w.apply(ipn({ pay_amount: 14, actually_paid: 14 }));
    assert.equal(out.credited, false);
    assert.equal(out.reason, "pay_amount_mismatch");
    assert.equal(w.balance(), 100);
  });

  test("malformed order ids and payloads are unknown, not credited", async () => {
    const w = world();
    for (const payload of [null, [], "x", {}, ipn({ order_id: "NP-1" }), ipn({ order_id: ["NP"] }), ipn({ order_id: `${ORDER}x` })]) {
      const out = await w.apply(payload);
      assert.equal(out.credited, false);
    }
    assert.equal(w.balance(), 100);
  });
});

describe("payment after the order was already closed", () => {
  test("a verified finished payment for an expired, failed or refunded order is not credited but is flagged for a human", async () => {
    for (const status of ["expired", "failed", "refunded"]) {
      const w = world({ status, paymentId: "7001" });
      const out = await w.apply(ipn());
      assert.equal(out.credited, false, status);
      assert.equal(w.balance(), 100, status);
      assert.equal(w.row().balanceCredited, false, status);
      assert.equal(w.row().recoveryStatus, "required", status);
      assert.equal(w.row().recoveryReason, "payment_after_terminal_status", status);
      assert.equal(w.row().status, status, status);
    }
  });

  test("replays keep it flagged without crediting; a resolved flag is not reopened", async () => {
    const w = world({ status: "expired", paymentId: "7001" });
    await w.apply(ipn());
    await w.apply(ipn());
    assert.equal(w.balance(), 100);
    Object.assign(w.row(), { recoveryStatus: "resolved", recoveryReason: "refunded manually" });
    await w.apply(ipn());
    assert.equal(w.row().recoveryStatus, "resolved");
    assert.equal(w.balance(), 100);
  });

  test("non-finished callbacks on a closed order do not raise a false alarm", async () => {
    const w = world({ status: "expired", paymentId: "7001" });
    await w.apply(ipn({ payment_status: "waiting", actually_paid: 0 }));
    await w.apply(ipn({ payment_status: "expired" }));
    assert.notEqual(w.row().recoveryStatus, "required");
  });
});

describe("crash and database-failure recovery", () => {
  test("a wallet failure after the claim leaves a finished, uncredited order that recovery completes once", async () => {
    const w = world();
    const failingUsers = { ...w.users.userModel, findOneAndUpdate: async () => { throw new Error("mongo down"); } };
    await assert.rejects(() => applyNowPaymentsUpdate({ payload: ipn(), invoiceModel: w.model, userModel: failingUsers }), /mongo down/);
    assert.equal(w.row().status, "finished");
    assert.equal(w.row().balanceCredited, false);
    assert.equal(w.balance(), 100);

    const request = async () => ({ status: 200, data: ipn() });
    const env = { NOWPAYMENTS_API_KEY: "k".repeat(24), NOWPAYMENTS_IPN_SECRET: "s".repeat(40), NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn" };
    const apply = (args) => applyNowPaymentsUpdate({ ...args, userModel: w.users.userModel });
    const first = await recoverNowPaymentsInvoices({ invoiceModel: w.model, request, env, apply, notify: async () => true });
    const second = await recoverNowPaymentsInvoices({ invoiceModel: w.model, request, env, apply, notify: async () => true });
    assert.equal(first.recovered, 1);
    assert.equal(second.recovered, 0);
    assert.equal(w.balance(), 50_100);
    assert.equal(w.row().balanceCredited, true);
  });

  test("a crash between the wallet credit and the invoice flag cannot double credit on retry", async () => {
    const w = world();
    const realUpdate = w.model.updateOne.bind(w.model);
    let dropped = false;
    w.model.updateOne = async (filter, update) => {
      if (!dropped && update.$set?.balanceCredited === true) { dropped = true; throw new Error("process killed"); }
      return realUpdate(filter, update);
    };
    await assert.rejects(() => w.apply(ipn()), /process killed/);
    assert.equal(w.balance(), 50_100);
    assert.equal(w.row().balanceCredited, false);
    const retry = await w.apply(ipn());
    assert.equal(retry.credited, false);
    assert.equal(retry.alreadyCredited, true);
    assert.equal(w.balance(), 50_100);
    assert.equal(w.row().balanceCredited, true);
  });

  test("a missing user is parked for review and never reported as credited", async () => {
    const model = makeFakeInvoiceModel([invoice({ userId: 9999 })]);
    const users = makeFakeWalletModels([{ telegramId: "9500", balance: 100 }]);
    const out = await applyNowPaymentsUpdate({ payload: ipn(), invoiceModel: model, userModel: users.userModel });
    assert.equal(out.outcome, "user_missing");
    assert.equal(model.docs.get(ORDER).recoveryReason, "user_missing");
    assert.equal(model.docs.get(ORDER).balanceCredited, false);
  });
});

describe("customer notification failures never touch the money", () => {
  test("a failed Telegram send keeps the credit, stays pending, and retries after the claim goes stale", async () => {
    const w = world();
    await w.apply(ipn());
    assert.equal(w.row().notificationPending, true);
    const t0 = new Date("2026-10-22T10:00:00Z");
    let sends = 0;
    const failing = { sendMessage: async () => { sends += 1; throw new Error("telegram timeout"); } };
    assert.equal(await notifyNowPaymentsCredit(ORDER, failing, { invoiceModel: w.model, now: () => t0 }), false);
    assert.equal(w.balance(), 50_100);
    assert.equal(w.row().notificationPending, true);
    assert.equal(await notifyNowPaymentsCredit(ORDER, failing, { invoiceModel: w.model, now: () => new Date(t0.getTime() + 60_000) }), false);
    assert.equal(sends, 1, "the fresh claim delays the retry");
    const working = { sendMessage: async () => { sends += 1; return { message_id: 1 }; } };
    assert.equal(await notifyNowPaymentsCredit(ORDER, working, { invoiceModel: w.model, now: () => new Date(t0.getTime() + 6 * 60_000) }), true);
    assert.equal(w.row().notificationPending, false);
    assert.equal(await notifyNowPaymentsCredit(ORDER, working, { invoiceModel: w.model, now: () => new Date(t0.getTime() + 20 * 60_000) }), false);
    assert.equal(w.balance(), 50_100);
    assert.equal(sends, 2);
  });
});
