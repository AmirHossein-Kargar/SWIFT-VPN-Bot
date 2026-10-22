import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { recoverNowPaymentsInvoices } from "../../services/nowpayments/recovery.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../../services/nowpayments/createInvoice.js";
import { createNowPaymentsRequest } from "../../services/nowpayments/nowpaymentsClient.js";
import { buildCatalogFromProviderData } from "../../services/nowpayments/catalog.js";
import { makeFakeInvoiceModel } from "../helpers/fakeNowPaymentsInvoiceModel.js";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

const ORDER = "NP-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENV = {
  NOWPAYMENTS_API_KEY: "k".repeat(24),
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};

/** An invoice created before the allowlist existed: a coin that is no longer offered. */
const legacy = (overrides = {}) => ({
  orderId: ORDER, userId: 9600, amountToman: 70_000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "doge",
  ticker: "DOGE", network: "DOGE", invoiceId: "6100", invoiceUrl: "https://nowpayments.io/payment/?iid=6100",
  paymentId: "7100", payAmount: 12, status: "waiting", balanceCredited: false, createdAt: new Date(), ...overrides,
});
const ipn = (overrides = {}) => ({
  payment_id: "7100", invoice_id: "6100", order_id: ORDER, payment_status: "finished", price_amount: 1, price_currency: "usd",
  pay_amount: 12, actually_paid: 12, pay_currency: "doge", ...overrides,
});

describe("the allowlist never touches settlement of existing orders", () => {
  test("a pre-allowlist invoice for a no-longer-offered coin settles from its IPN, whatever the env narrowing", async () => {
    const prev = process.env.NOWPAYMENTS_ENABLED_CURRENCIES;
    process.env.NOWPAYMENTS_ENABLED_CURRENCIES = "trx";
    try {
      const model = makeFakeInvoiceModel([legacy()]);
      const users = makeFakeWalletModels([{ telegramId: "9600", balance: 0 }]);
      const out = await applyNowPaymentsUpdate({ payload: ipn(), invoiceModel: model, userModel: users.userModel });
      assert.equal(out.credited, true);
      assert.equal(users.users.get("9600").balance, 70_000);
    } finally {
      if (prev === undefined) delete process.env.NOWPAYMENTS_ENABLED_CURRENCIES; else process.env.NOWPAYMENTS_ENABLED_CURRENCIES = prev;
    }
  });

  test("the recovery poll reconciles it too, exactly once", async () => {
    const model = makeFakeInvoiceModel([legacy()]);
    const users = makeFakeWalletModels([{ telegramId: "9600", balance: 5 }]);
    const request = async ({ path }) => (path === "/payment/7100" ? { status: 200, data: ipn() } : { status: 404, data: {} });
    const apply = (args) => applyNowPaymentsUpdate({ ...args, userModel: users.userModel });
    const env = { ...ENV, NOWPAYMENTS_ENABLED_CURRENCIES: "btc" };
    const a = await recoverNowPaymentsInvoices({ invoiceModel: model, request, env, apply, notify: async () => true });
    const b = await recoverNowPaymentsInvoices({ invoiceModel: model, request, env, apply, notify: async () => true });
    assert.equal(a.recovered, 1);
    assert.equal(b.recovered, 0);
    assert.equal(users.users.get("9600").balance, 70_005);
  });
});

describe("recovery of an order whose invoice was created remotely but never recorded locally", () => {
  const rate = async () => ({ tomanPerFiat: 250_000, source: "test" });
  const catalog = buildCatalogFromProviderData({ currencies: ["trx"], merchantCoins: ["trx"] });
  const okTransport = async (o) => {
    if (o.url.includes("/min-amount")) return { status: 200, data: { currency_from: "trx", currency_to: "trx", min_amount: 0.1, fiat_equivalent: 0.01 } };
    if (o.url.endsWith("/currencies")) return { status: 200, data: { currencies: ["trx"] } };
    if (o.url.endsWith("/invoice")) return { status: 201, data: { id: "6200", order_id: o.data.order_id, price_amount: String(o.data.price_amount), price_currency: "usd", pay_currency: "trx", invoice_url: "https://nowpayments.io/payment/?iid=6200" } };
    return { status: 404, data: {} };
  };
  const call = createNowPaymentsRequest({ apiKey: ENV.NOWPAYMENTS_API_KEY, baseURL: "https://api.nowpayments.io/v1", transport: okTransport });

  test("when every local write fails the row ages into creation_unknown, blocks re-creation, and a later IPN credits once", async () => {
    resetNowPaymentsCreateLocksForTests();
    const model = makeFakeInvoiceModel();
    model.failOn((filter, update) => Boolean(update.$set?.status));
    await assert.rejects(() => createNowPaymentsTopUp({ userId: 9610, amountToman: 50_000, env: ENV, invoiceModel: model, catalog, payCurrency: "trx", request: call, resolveRate: rate }), (e) => e.code === "persistence_failed");
    model.failOn(null);
    const [row] = [...model.docs.values()];
    assert.equal(row.status, "creating");

    const later = new Date(Date.now() + 3 * 60_000);
    const swept = await recoverNowPaymentsInvoices({ invoiceModel: model, request: async () => ({ status: 404, data: {} }), env: ENV, now: later, notify: async () => true });
    assert.equal(swept.unresolved, 1);
    assert.equal(model.docs.get(row.orderId).status, "creation_unknown");
    assert.equal(model.docs.get(row.orderId).recoveryStatus, "required");
    await assert.rejects(() => createNowPaymentsTopUp({ userId: 9610, amountToman: 50_000, env: ENV, invoiceModel: model, catalog, payCurrency: "trx", request: call, resolveRate: rate }), (e) => e.code === "in_flight");

    const users = makeFakeWalletModels([{ telegramId: "9610", balance: 0 }]);
    const payload = { payment_id: "7200", invoice_id: "6200", order_id: row.orderId, payment_status: "finished", price_amount: 0.2, price_currency: "usd", pay_amount: 30, actually_paid: 30, pay_currency: "trx" };
    const results = await Promise.all([1, 2].map(() => applyNowPaymentsUpdate({ payload, invoiceModel: model, userModel: users.userModel })));
    assert.equal(results.filter((r) => r.credited).length, 1);
    assert.equal(users.users.get("9610").balance, 50_000);
    assert.equal(model.docs.get(row.orderId).openCreateKey, undefined);
  });

  test("the polling job cannot find a payment it has no payment_id for (IPN or an admin is required)", async () => {
    resetNowPaymentsCreateLocksForTests();
    const model = makeFakeInvoiceModel();
    model.failOn((filter, update) => update.$set?.status === "pending");
    await assert.rejects(() => createNowPaymentsTopUp({ userId: 9611, amountToman: 50_000, env: ENV, invoiceModel: model, catalog, payCurrency: "trx", request: call, resolveRate: rate }), (e) => e.code === "persistence_failed");
    model.failOn(null);
    const polled = [];
    const out = await recoverNowPaymentsInvoices({ invoiceModel: model, request: async (o) => { polled.push(o.path); return { status: 404, data: {} }; }, env: ENV, notify: async () => true });
    assert.deepEqual(polled, []);
    assert.equal(out.recovered, 0);
    assert.equal(out.unresolved, 1);
  });
});

describe("provider response shapes from the official reference", () => {
  const rate = async () => ({ tomanPerFiat: 250_000, source: "test" });
  const catalog = buildCatalogFromProviderData({ currencies: ["usdttrc20"], merchantCoins: ["usdttrc20"] });

  function build(extraBody = {}) {
    const transport = async (o) => {
      if (o.url.includes("/min-amount")) return { status: 200, data: { currency_from: "usdttrc20", currency_to: "usdttrc20", min_amount: 1, fiat_equivalent: 0.01 } };
      if (o.url.endsWith("/currencies")) return { status: 200, data: { currencies: ["usdttrc20"] } };
      // Documented: HTTP 201, price_amount as a STRING, invoice_url https://nowpayments.io/payment/?iid=<id>
      return { status: 201, data: { id: "4522625843", order_id: o.data.order_id, price_amount: String(o.data.price_amount), price_currency: "usd", pay_currency: "usdttrc20", invoice_url: "https://nowpayments.io/payment/?iid=4522625843", ...extraBody } };
    };
    return createNowPaymentsRequest({ apiKey: ENV.NOWPAYMENTS_API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
  }
  const create = (request) => createNowPaymentsTopUp({ userId: 9620, amountToman: 50_000, env: ENV, invoiceModel: makeFakeInvoiceModel(), catalog, payCurrency: "usdttrc20", request, resolveRate: rate });

  test("HTTP 201 with a string price_amount and the documented hosted URL is accepted unchanged", async () => {
    resetNowPaymentsCreateLocksForTests();
    const invoice = await create(build());
    assert.equal(invoice.invoiceUrl, "https://nowpayments.io/payment/?iid=4522625843");
    assert.equal(invoice.invoiceId, "4522625843");
  });

  test("a payout_currency different from the pair used for the minimum is logged, a matching one is not", async () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      resetNowPaymentsCreateLocksForTests();
      await create(build({ payout_currency: "usdttrc20" }));
      assert.equal(warnings.some((w) => w.includes("outcome_pair_differs")), false);
      resetNowPaymentsCreateLocksForTests();
      await create(build({ payout_currency: "btc" }));
      assert.equal(warnings.some((w) => w.includes("outcome_pair_differs")), true);
      assert.equal(warnings.join("\n").includes(ENV.NOWPAYMENTS_API_KEY), false);
    } finally {
      console.warn = original;
    }
  });
});
