import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";
import { TRON_PAY_CURRENCY } from "../../services/nowpayments/constants.js";
import { signNowPaymentsIpn, verifyNowPaymentsSignature } from "../../services/nowpayments/signature.js";
import { readNowPaymentsConfig, tomanToFiatCents, NowPaymentsFlowError } from "../../services/nowpayments/money.js";
import { resolveTomanPerFiat } from "../../services/nowpayments/exchangeRate.js";
import { createNowPaymentsRequest } from "../../services/nowpayments/nowpaymentsClient.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../../services/nowpayments/createInvoice.js";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { handleNowPaymentsIpn } from "../../services/nowpayments/ipnHandler.js";
import { recoverNowPaymentsInvoices } from "../../services/nowpayments/recovery.js";

const testRate = async () => ({ tomanPerFiat: 50_000, source: "test" });
const SECRET = "n".repeat(48);
const API_KEY = "unit-nowpayments-api-key";
const ORDER = "NP-11111111-1111-4111-8111-111111111111";
const ENV = {
  NOWPAYMENTS_API_KEY: API_KEY,
  NOWPAYMENTS_IPN_SECRET: SECRET,
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
  NOWPAYMENTS_TOMAN_PER_FIAT_UNIT: "50000",
  NOWPAYMENTS_PRICE_CURRENCY: "usd",
};

function matches(document, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((entry) => matches(document, entry));
    if (key === "$and") return condition.every((entry) => matches(document, entry));
    const value = key.split(".").reduce((current, part) => current?.[part], document);
    if (condition == null) return value == null;
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (Object.hasOwn(condition, "$in")) return condition.$in.some((item) => String(value) === String(item));
      if (Object.hasOwn(condition, "$nin")) {
        return !condition.$nin.some((item) => (item == null ? value == null || value === "" : String(value) === String(item)));
      }
      if (Object.hasOwn(condition, "$lt")) return new Date(value) < new Date(condition.$lt);
      if (Object.hasOwn(condition, "$ne")) return String(value) !== String(condition.$ne);
      return false;
    }
    return String(value) === String(condition);
  });
}

function applyUpdate(document, update) {
  for (const [path, value] of Object.entries(update.$set || {})) document[path] = value;
  for (const path of Object.keys(update.$unset || {})) delete document[path];
}

function makeInvoiceModel(seed = []) {
  const docs = new Map(seed.map((doc) => [doc.orderId, { ipnLog: [], balanceCredited: false, ...doc }]));
  return {
    docs,
    async create(fields) {
      if ([...docs.values()].some((doc) => doc.openCreateKey && doc.openCreateKey === fields.openCreateKey)) {
        const error = new Error("duplicate open create");
        error.code = 11000;
        throw error;
      }
      docs.set(fields.orderId, { ipnLog: [], balanceCredited: false, ...fields });
      return docs.get(fields.orderId);
    },
    findOne(filter) {
      return { lean: async () => [...docs.values()].find((doc) => matches(doc, filter)) || null };
    },
    async updateOne(filter, update) {
      const doc = [...docs.values()].find((item) => matches(item, filter));
      if (!doc) return { modifiedCount: 0 };
      applyUpdate(doc, update);
      return { modifiedCount: 1 };
    },
    find(filter) {
      const found = [...docs.values()].filter((doc) => matches(doc, filter));
      return { limit() { return this; }, lean: async () => found };
    },
  };
}

function successTransport(calls) {
  return async (options) => {
    calls.push(options);
    if (options.url.endsWith("/currencies")) return { status: 200, data: { currencies: ["btc", "trx", "eth"] } };
    return {
      status: 200,
      data: {
        id: "4522625843",
        invoice_url: "https://nowpayments.io/payment/?iid=4522625843",
        order_id: options.data.order_id,
        price_amount: options.data.price_amount,
        price_currency: options.data.price_currency,
        pay_currency: options.data.pay_currency,
      },
    };
  };
}

function invoiceFixture(overrides = {}) {
  return {
    orderId: ORDER,
    userId: 7001,
    amountToman: 50_000,
    priceAmountCents: 100,
    priceCurrency: "usd",
    payCurrency: "trx",
    tomanPerFiat: 50_000,
    rateSource: "env",
    invoiceId: "4522625843",
    invoiceUrl: "https://nowpayments.io/payment/?iid=4522625843",
    status: "pending",
    balanceCredited: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function finishedPayload(overrides = {}) {
  return {
    payment_id: "887766",
    invoice_id: "4522625843",
    order_id: ORDER,
    payment_status: "finished",
    price_amount: 1,
    price_currency: "usd",
    pay_amount: 15,
    actually_paid: 15,
    pay_currency: "trx",
    ...overrides,
  };
}

describe("NOWPayments configuration and signature", () => {
  test("derives the registered IPN path and does not treat the public key as the API key", () => {
    const derived = readNowPaymentsConfig({
      NOWPAYMENTS_API_KEY: API_KEY,
      NOWPAYMENTS_IPN_SECRET: SECRET,
      WEBHOOK_BASE_URL: "https://pay.example.test",
    });
    assert.equal(new URL(derived.callbackUrl).pathname, "/api/nowpayments/ipn");
    const server = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
    assert.match(server, /app\.post\("\/api\/nowpayments\/ipn", handleNowPaymentsWebhook\)/);
    assert.match(server, /req\.rawBody = buffer/);
    assert.equal(TRON_PAY_CURRENCY, "trx");
    assert.equal(readNowPaymentsConfig({ NOWPAYMENTS_PUBLIC_KEY: "public-key", NOWPAYMENTS_IPN_SECRET: SECRET }), null);
    const config = readNowPaymentsConfig(ENV);
    assert.equal(config.payCurrency, "trx");
    assert.equal(config.apiKey, API_KEY);
    assert.notEqual(config.apiKey, "public-key");
  });

  test("verifies the documented sorted HMAC-SHA512 signature and rejects tampering", () => {
    const payload = { payment_status: "finished", order_id: ORDER, fee: { serviceFee: 0, currency: "trx" } };
    const signature = signNowPaymentsIpn(payload, SECRET);
    assert.equal(verifyNowPaymentsSignature({ fee: { currency: "trx", serviceFee: 0 }, order_id: ORDER, payment_status: "finished" }, signature, SECRET), true);
    assert.equal(verifyNowPaymentsSignature(payload, "a".repeat(128), SECRET), false);
    assert.equal(verifyNowPaymentsSignature(payload, signature, "wrong-secret-value-not-the-real-one"), false);
    assert.equal(verifyNowPaymentsSignature({ ...payload, price_amount: 1 }, signature, SECRET), false);
    const nodeSignature = signNowPaymentsIpn({ ...payload, payment_extra_ids: ["a", "b"] }, SECRET, { arrayMode: "node" });
    assert.equal(verifyNowPaymentsSignature({ ...payload, payment_extra_ids: ["a", "b"] }, nodeSignature, SECRET), true);
    const topLevel = crypto.createHmac("sha512", SECRET).update(JSON.stringify(payload, Object.keys(payload).sort()), "utf8").digest("hex");
    assert.equal(verifyNowPaymentsSignature(payload, topLevel, SECRET), true);
  });

  test("refuses a missing or invalid conversion rate instead of inventing one", async () => {
    let calls = 0;
    await assert.rejects(() => resolveTomanPerFiat({
      priceCurrency: "usd",
      env: {},
      transport: async () => { calls += 1; throw new Error("down"); },
    }), (error) => error.code === "rate_unavailable");
    assert.equal(calls, 1);
    await assert.rejects(() => resolveTomanPerFiat({ priceCurrency: "eur", env: {}, transport: async () => { throw new Error("should not quote eur"); } }), (error) => error.code === "rate_unavailable");
    assert.equal(tomanToFiatCents(50_000, 250_000), 20);
  });
});

describe("NOWPayments invoice creation", () => {
  test("sends the converted fiat amount, TRON ticker, and API key header", async () => {
    resetNowPaymentsCreateLocksForTests();
    const calls = [];
    const model = makeInvoiceModel();
    const request = createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport: successTransport(calls) });
    const invoice = await createNowPaymentsTopUp({ userId: 7101, amountToman: 85_000, env: ENV, invoiceModel: model, request, resolveRate: testRate });
    const post = calls.find((call) => call.url.endsWith("/invoice"));
    assert.equal(post.headers["x-api-key"], API_KEY);
    assert.equal(post.data.price_currency, "usd");
    assert.equal(post.data.pay_currency, "trx");
    assert.equal(post.data.price_amount, 1.7);
    assert.notEqual(post.data.price_amount, 85_000);
    assert.equal(post.data.ipn_callback_url, ENV.NOWPAYMENTS_IPN_CALLBACK_URL);
    assert.equal(invoice.invoiceUrl.startsWith("https://nowpayments.io/"), true);
    assert.equal(JSON.stringify(invoice).includes(API_KEY), false);
    assert.equal(invoice.payAmount, null);
    assert.equal([...model.docs.values()][0].status, "pending");
    assert.equal([...model.docs.values()][0].amountToman, 85_000);
  });

  test("does not create an invoice when TRX is absent, the provider rejects, or the response has no URL", async () => {
    resetNowPaymentsCreateLocksForTests();
    const missing = [];
    const missingModel = makeInvoiceModel();
    await assert.rejects(() => createNowPaymentsTopUp({
      userId: 7102,
      amountToman: 50_000,
      env: ENV,
      invoiceModel: missingModel,
      resolveRate: testRate,
      request: createNowPaymentsRequest({
        apiKey: API_KEY,
        baseURL: "https://api.nowpayments.io/v1",
        transport: async (options) => {
          missing.push(options.url);
          return { status: 200, data: { currencies: ["btc", "usdttrc20"] } };
        },
      }),
    }), (error) => error instanceof NowPaymentsFlowError && error.code === "currency_unavailable");
    assert.equal(missing.some((url) => url.endsWith("/invoice")), false);
    assert.equal([...missingModel.docs.values()][0].status, "creation_failed");

    const rejected = makeInvoiceModel();
    await assert.rejects(() => createNowPaymentsTopUp({
      userId: 7103,
      amountToman: 50_000,
      env: ENV,
      invoiceModel: rejected,
      resolveRate: testRate,
      request: createNowPaymentsRequest({
        apiKey: API_KEY,
        baseURL: "https://api.nowpayments.io/v1",
        transport: async (options) => options.url.endsWith("/currencies")
          ? { status: 200, data: { currencies: ["trx"] } }
          : { status: 400, data: { message: API_KEY } },
      }),
    }), (error) => error.code === "provider_rejected" && !error.message.includes(API_KEY));
    assert.equal([...rejected.docs.values()][0].status, "creation_failed");

    const malformed = makeInvoiceModel();
    await assert.rejects(() => createNowPaymentsTopUp({
      userId: 7104,
      amountToman: 50_000,
      env: ENV,
      invoiceModel: malformed,
      resolveRate: testRate,
      request: createNowPaymentsRequest({
        apiKey: API_KEY,
        baseURL: "https://api.nowpayments.io/v1",
        transport: async (options) => options.url.endsWith("/currencies")
          ? { status: 200, data: { currencies: ["trx"] } }
          : { status: 200, data: { id: "999", price_amount: 1, price_currency: "usd" } },
      }),
    }), (error) => error.code === "malformed_response");
    assert.equal([...malformed.docs.values()][0].invoiceUrl ?? null, null);
    assert.equal([...malformed.docs.values()][0].balanceCredited, false);
  });

  test("an ambiguous timeout does not create another invoice or credit the wallet", async () => {
    resetNowPaymentsCreateLocksForTests();
    let posts = 0;
    const model = makeInvoiceModel();
    const request = createNowPaymentsRequest({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      transport: async (options) => {
        if (options.url.endsWith("/currencies")) return { status: 200, data: { currencies: ["trx"] } };
        posts += 1;
        const error = new Error("timeout");
        error.code = "ECONNABORTED";
        throw error;
      },
    });
    await assert.rejects(() => createNowPaymentsTopUp({ userId: 7105, amountToman: 50_000, env: ENV, invoiceModel: model, request, resolveRate: testRate }), (error) => error.code === "ambiguous");
    await assert.rejects(() => createNowPaymentsTopUp({ userId: 7105, amountToman: 50_000, env: ENV, invoiceModel: model, request, resolveRate: testRate }), (error) => error.code === "in_flight");
    assert.equal(posts, 1);
    assert.equal([...model.docs.values()][0].status, "creation_unknown");
    assert.equal([...model.docs.values()][0].balanceCredited, false);
  });

  test("missing configuration makes no provider call", async () => {
    resetNowPaymentsCreateLocksForTests();
    let calls = 0;
    await assert.rejects(() => createNowPaymentsTopUp({
      userId: 7106,
      amountToman: 50_000,
      env: {},
      invoiceModel: makeInvoiceModel(),
      resolveRate: testRate,
      request: async () => { calls += 1; return { status: 200, data: {} }; },
    }), (error) => error.code === "not_configured");
    assert.equal(calls, 0);
  });
});

describe("NOWPayments IPN crediting", () => {
  test("credits a finished TRON payment once and ignores unsafe statuses", async () => {
    const users = makeFakeWalletModels([{ telegramId: "7001", balance: 1_000 }]);
    const model = makeInvoiceModel([invoiceFixture()]);
    const waiting = await applyNowPaymentsUpdate({ payload: finishedPayload({ payment_status: "waiting", actually_paid: 0 }), invoiceModel: model, userModel: users.userModel });
    assert.equal(waiting.credited, false);
    assert.equal(users.users.get("7001").balance, 1_000);
    for (const status of ["confirming", "confirmed", "sending", "partially_paid", "failed", "expired"]) {
      const result = await applyNowPaymentsUpdate({ payload: finishedPayload({ payment_status: status, actually_paid: status === "partially_paid" ? 1 : 15 }), invoiceModel: model, userModel: users.userModel });
      assert.equal(result.credited, false, status);
    }
    assert.equal(users.users.get("7001").balance, 1_000);

    const first = await applyNowPaymentsUpdate({ payload: finishedPayload(), invoiceModel: model, userModel: users.userModel });
    const second = await applyNowPaymentsUpdate({ payload: finishedPayload(), invoiceModel: model, userModel: users.userModel });
    assert.equal(first.credited, true);
    assert.equal(second.alreadyCredited, true);
    assert.equal(users.users.get("7001").balance, 51_000);
    assert.equal(users.users.get("7001").appliedPaymentKeys.includes(`nowpayments:${ORDER}`), true);
  });

  test("concurrent finished callbacks credit exactly once", async () => {
    const users = makeFakeWalletModels([{ telegramId: "7002", balance: 0 }]);
    const model = makeInvoiceModel([invoiceFixture({ userId: 7002 })]);
    const results = await Promise.all([
      applyNowPaymentsUpdate({ payload: finishedPayload(), invoiceModel: model, userModel: users.userModel }),
      applyNowPaymentsUpdate({ payload: finishedPayload(), invoiceModel: model, userModel: users.userModel }),
    ]);
    assert.equal(results.filter((result) => result.credited).length, 1);
    assert.equal(users.users.get("7002").balance, 50_000);
  });

  test("rejects bad signatures, unknown orders, mismatched invoices, amounts, and currencies", async () => {
    const users = makeFakeWalletModels([{ telegramId: "7001", balance: 5 }]);
    const model = makeInvoiceModel([invoiceFixture()]);
    const res = () => ({ statusCode: 0, body: null, headersSent: false, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.headersSent = true; } });
    const bad = res();
    await handleNowPaymentsIpn({ rawBody: Buffer.from("{}"), get: () => "b".repeat(128) }, bad, { secret: SECRET, apply: async () => { throw new Error("should not apply"); } });
    assert.equal(bad.statusCode, 401);
    const missingSecret = res();
    await handleNowPaymentsIpn({ rawBody: Buffer.from("{}"), get: () => "b".repeat(128) }, missingSecret, { secret: "" });
    assert.equal(missingSecret.statusCode, 503);

    const unknown = await applyNowPaymentsUpdate({ payload: finishedPayload({ order_id: "NP-22222222-2222-4222-8222-222222222222" }), invoiceModel: model, userModel: users.userModel });
    assert.equal(unknown.outcome, "unknown_order");
    const mismatch = await applyNowPaymentsUpdate({ payload: finishedPayload({ invoice_id: "other-invoice" }), invoiceModel: model, userModel: users.userModel });
    assert.equal(mismatch.outcome, "invoice_mismatch");
    const amount = await applyNowPaymentsUpdate({ payload: finishedPayload({ price_amount: 2 }), invoiceModel: model, userModel: users.userModel });
    assert.equal(amount.outcome, "amount_mismatch");
    const currency = await applyNowPaymentsUpdate({ payload: finishedPayload({ pay_currency: "usdttrc20" }), invoiceModel: model, userModel: users.userModel });
    assert.equal(currency.outcome, "amount_mismatch");
    assert.equal(users.users.get("7001").balance, 5);
  });

  test("a refund does not debit or credit, and a later finished IPN cannot credit a refunded order", async () => {
    const users = makeFakeWalletModels([{ telegramId: "7003", balance: 10 }]);
    const model = makeInvoiceModel([invoiceFixture({ userId: 7003, status: "finished", balanceCredited: true })]);
    users.users.get("7003").appliedPaymentKeys.push(`nowpayments:${ORDER}`);
    const refunded = await applyNowPaymentsUpdate({ payload: finishedPayload({ payment_status: "refunded" }), invoiceModel: model, userModel: users.userModel });
    assert.equal(refunded.credited, false);
    assert.equal(users.users.get("7003").balance, 10);
    assert.equal(model.docs.get(ORDER).status, "refunded");
    const late = await applyNowPaymentsUpdate({ payload: finishedPayload(), invoiceModel: model, userModel: users.userModel });
    assert.equal(late.credited, false);
    assert.equal(users.users.get("7003").balance, 10);

    const unpaid = makeInvoiceModel([invoiceFixture({ userId: 7003, orderId: "NP-33333333-3333-4333-8333-333333333333", status: "pending", balanceCredited: false })]);
    await applyNowPaymentsUpdate({
      payload: finishedPayload({ order_id: "NP-33333333-3333-4333-8333-333333333333", payment_status: "refunded", payment_id: "111" }),
      invoiceModel: unpaid,
      userModel: users.userModel,
    });
    const afterRefund = await applyNowPaymentsUpdate({
      payload: finishedPayload({ order_id: "NP-33333333-3333-4333-8333-333333333333", payment_id: "111" }),
      invoiceModel: unpaid,
      userModel: users.userModel,
    });
    assert.equal(afterRefund.credited, false);
    assert.equal(users.users.get("7003").balance, 10);
  });

  test("an IPN after process restart credits a creation_unknown invoice exactly once", async () => {
    const users = makeFakeWalletModels([{ telegramId: "7004", balance: 0 }]);
    const model = makeInvoiceModel([invoiceFixture({ userId: 7004, status: "creation_unknown", invoiceId: null, openCreateKey: "user:7004" })]);
    const result = await applyNowPaymentsUpdate({ payload: finishedPayload(), invoiceModel: model, userModel: users.userModel });
    assert.equal(result.credited, true);
    assert.equal(users.users.get("7004").balance, 50_000);
    assert.equal(model.docs.get(ORDER).status, "finished");
    assert.equal(model.docs.get(ORDER).openCreateKey, undefined);
  });
});

describe("NOWPayments recovery", () => {
  test("polls a stored payment after restart and does not call the provider without configuration", async () => {
    const users = makeFakeWalletModels([{ telegramId: "7005", balance: 0 }]);
    const model = makeInvoiceModel([invoiceFixture({ userId: 7005, status: "confirming", paymentId: "887766" })]);
    let gets = 0;
    const recovered = await recoverNowPaymentsInvoices({
      invoiceModel: model,
      env: ENV,
      request: async ({ path }) => {
        gets += 1;
        assert.match(path, /\/payment\/887766$/);
        return { status: 200, data: finishedPayload() };
      },
      apply: (input) => applyNowPaymentsUpdate({ ...input, userModel: users.userModel }),
    });
    assert.equal(recovered.recovered, 1);
    assert.equal(gets, 1);
    const again = await recoverNowPaymentsInvoices({
      invoiceModel: model,
      env: ENV,
      request: async () => { gets += 1; return { status: 200, data: finishedPayload() }; },
      apply: (input) => applyNowPaymentsUpdate({ ...input, userModel: users.userModel }),
    });
    assert.equal(again.recovered, 0);
    assert.equal(users.users.get("7005").balance, 50_000);

    let blocked = 0;
    const skipped = await recoverNowPaymentsInvoices({
      invoiceModel: makeInvoiceModel([invoiceFixture({ status: "confirming", paymentId: "111" })]),
      env: {},
      request: async () => { blocked += 1; return { status: 200, data: finishedPayload() }; },
    });
    assert.equal(skipped.skipped, "not_configured");
    assert.equal(blocked, 0);
  });

  test("a stale create that never reached the provider can be failed without crediting", async () => {
    const model = makeInvoiceModel([invoiceFixture({ status: "creating", apiAttemptedAt: null, invoiceId: null, createdAt: new Date(Date.now() - 10 * 60_000), openCreateKey: "user:7001" })]);
    await recoverNowPaymentsInvoices({ invoiceModel: model, env: {}, request: async () => { throw new Error("no network"); } });
    assert.equal(model.docs.get(ORDER).status, "creation_failed");
    assert.equal(model.docs.get(ORDER).balanceCredited, false);
  });
});

describe("NOWPayments HTTP endpoint", () => {
  let server;
  let baseUrl;
  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("the IPN route rejects an invalid signature without a database", async () => {
    const previous = process.env.NOWPAYMENTS_IPN_SECRET;
    process.env.NOWPAYMENTS_IPN_SECRET = SECRET;
    const { default: app } = await import("../../server.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify({ payment_status: "finished", order_id: ORDER });
    const response = await fetch(`${baseUrl}/api/nowpayments/ipn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-nowpayments-sig": "c".repeat(128) },
      body,
    });
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(payload.error, "invalid_signature");
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    if (previous == null) delete process.env.NOWPAYMENTS_IPN_SECRET;
    else process.env.NOWPAYMENTS_IPN_SECRET = previous;
  });
});
