import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleNowPaymentsIpn } from "../../services/nowpayments/ipnHandler.js";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { signNowPaymentsIpn } from "../../services/nowpayments/signature.js";
import { makeFakeInvoiceModel } from "../helpers/fakeNowPaymentsInvoiceModel.js";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

const ORDER = "NP-abababab-abab-4bab-8bab-abababababab";
const SECRET = "s".repeat(40);
const invoice = (overrides = {}) => ({
  orderId: ORDER, userId: 9900, amountToman: 50_000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "trx", invoiceId: "6600",
  paymentId: null, status: "pending", balanceCredited: false, recoveryStatus: "none", createdAt: new Date(), ...overrides,
});
const ipn = (status = "finished", extra = {}) => ({
  payment_id: "7600", invoice_id: "6600", order_id: ORDER, payment_status: status, price_amount: 1, price_currency: "usd",
  pay_amount: 30, actually_paid: status === "finished" ? 30 : 0, pay_currency: "trx", ...extra,
});

let savedGroup;
beforeEach(() => { savedGroup = process.env.GROUP_ID; process.env.GROUP_ID = "-100123"; });
afterEach(() => { if (savedGroup === undefined) delete process.env.GROUP_ID; else process.env.GROUP_ID = savedGroup; });

function harness(rowOverrides = {}) {
  const model = makeFakeInvoiceModel([invoice(rowOverrides)]);
  const users = makeFakeWalletModels([{ telegramId: "9900", balance: 5 }]);
  const alerts = [];
  const bot = { sendMessage: async (chat, text) => { alerts.push({ chat, text }); } };
  async function deliver(payload) {
    const req = { rawBody: Buffer.from(JSON.stringify(payload)), headers: { "x-nowpayments-sig": signNowPaymentsIpn(payload, SECRET) }, get(name) { return this.headers[name.toLowerCase()]; } };
    const res = { statusCode: 0, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await handleNowPaymentsIpn(req, res, {
      secret: SECRET, bot, notify: async () => true,
      apply: ({ payload: p }) => applyNowPaymentsUpdate({ payload: p, invoiceModel: model, userModel: users.userModel }),
    });
    return res;
  }
  return { model, users, alerts, deliver, row: () => model.docs.get(ORDER), balance: () => users.users.get("9900").balance };
}

describe("a verified payment for an order that was already closed is never credited and a human is told once", () => {
  for (const status of ["expired", "failed", "refunded"]) {
    test(`finished after ${status}: no credit, flagged for review, one alert even if the provider retries`, async () => {
      const h = harness({ status, paymentId: "7600", recoveryStatus: "none" });
      const first = await h.deliver(ipn());
      const second = await h.deliver(ipn());
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.equal(h.balance(), 5);
      assert.equal(h.row().balanceCredited, false);
      assert.equal(h.row().recoveryStatus, "required");
      assert.equal(h.row().recoveryReason, "payment_after_terminal_status");
      assert.equal(h.alerts.length, 1, "alerted once, not per retry");
      assert.match(h.alerts[0].text, /سفارش بسته‌شده/);
      assert.match(h.alerts[0].text, /بررسی دستی/);
      assert.equal(h.alerts[0].text.includes(SECRET), false);
    });
  }

  test("after an admin released an unknown create, a late signed payment is held (409 to the provider), flagged and alerted, never credited", async () => {
    const h = harness({ status: "creation_failed", recoveryStatus: "resolved", recoveryResolvedBy: "424242", paymentId: null });
    const res = await h.deliver(ipn());
    assert.equal(res.statusCode, 409);
    assert.equal(h.balance(), 5);
    assert.equal(h.row().status, "creation_failed");
    assert.equal(h.row().recoveryStatus, "required");
    assert.equal(h.row().recoveryReason, "ipn_after_rejected_create");
    assert.equal(h.alerts.length, 1);
    await h.deliver(ipn());
    assert.equal(h.alerts.length, 1, "provider retries do not re-alert");
    assert.equal(h.balance(), 5);
  });

  test("every money-bearing status after a release is alerted once; non-money statuses are flagged silently", async () => {
    for (const status of ["confirming", "confirmed", "sending", "partially_paid", "finished"]) {
      const h = harness({ status: "creation_failed", recoveryStatus: "resolved" });
      await h.deliver(ipn(status, { actually_paid: status === "partially_paid" ? 1 : 30 }));
      assert.equal(h.alerts.length, 1, status);
      assert.equal(h.balance(), 5, status);
    }
    const quiet = harness({ status: "creation_failed", recoveryStatus: "resolved" });
    await quiet.deliver(ipn("waiting"));
    assert.equal(quiet.alerts.length, 0);
    assert.equal(quiet.row().recoveryStatus, "required");
  });

  test("an alert failure never changes the response or the money", async () => {
    const h = harness({ status: "expired", paymentId: "7600" });
    h.alerts.push = () => { throw new Error("telegram down"); };
    const res = await h.deliver(ipn());
    assert.equal(res.statusCode, 200);
    assert.equal(h.balance(), 5);
    assert.equal(h.row().recoveryReason, "payment_after_terminal_status");
  });

  test("an already-resolved terminal order is not re-flagged or re-alerted", async () => {
    const h = harness({ status: "expired", paymentId: "7600", recoveryStatus: "resolved" });
    await h.deliver(ipn());
    assert.equal(h.alerts.length, 0);
    assert.equal(h.row().recoveryStatus, "resolved");
  });

  test("an order that is still open settles normally and raises no review alert", async () => {
    const h = harness({ status: "pending" });
    const res = await h.deliver(ipn());
    assert.equal(res.statusCode, 200);
    assert.equal(h.balance(), 50_005);
    assert.equal(h.alerts.length, 0);
  });
});
