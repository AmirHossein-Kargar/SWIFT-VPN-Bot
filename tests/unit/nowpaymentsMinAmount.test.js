import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assertMeetsMinimum,
  minimumPriceCents,
  minimumTomanForCents,
  parseMinAmount,
  requestMinAmount,
} from "../../services/nowpayments/minAmount.js";
import {
  invoiceUrlIsTrusted,
  invoiceUrlIidDiffers,
  invoiceUrlIsUsable,
  readNowPaymentsConfig,
  tomanToFiatCents,
} from "../../services/nowpayments/money.js";
import { PAYMENT_ALLOWLIST } from "../../services/nowpayments/allowlist.js";
import { buildCatalogFromProviderData } from "../../services/nowpayments/catalog.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../../services/nowpayments/createInvoice.js";
import { createNowPaymentsRequest } from "../../services/nowpayments/nowpaymentsClient.js";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { quoteTronTopUp, resetTronQuoteCacheForTests } from "../../services/pricing/tronQuote.js";
import { confirmNowPaymentsTopUp, failureText, resetNowPaymentsConfirmLocksForTests } from "../../paymentHandlers/payNowPayments.js";
import { parseTopUpAmount } from "../../utils/validationAmount.js";
import { makeFakeInvoiceModel } from "../helpers/fakeNowPaymentsInvoiceModel.js";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

const API_KEY = "unit-min-amount-api-key-0001";
const ENV = {
  NOWPAYMENTS_API_KEY: API_KEY,
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};
const CONFIG = readNowPaymentsConfig(ENV);
const NOW = new Date("2026-10-22T10:00:00.000Z");
const RATE = 250_000; // toman per USD: 50,000 toman = 20 cents
const usdtQuote = async () => ({ tomanPerUsdt: RATE, createdAt: NOW.toISOString(), source: "gheymat" });

/** Transport-level fake: min-amount answers from `minFiat`, estimate is optional, invoice succeeds. */
function provider({ minFiat = 0.2, minCrypto = 0.5, minStatus = 200, minData, minThrows, posts = [], paths = [], estimateStatus = 404 } = {}) {
  const transport = async (options) => {
    paths.push(options.url.replace("https://api.nowpayments.io/v1", ""));
    if (options.url.includes("/min-amount")) {
      if (minThrows) throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
      return { status: minStatus, data: minData ?? { currency_from: new URL(options.url).searchParams.get("currency_from"), min_amount: minCrypto, fiat_equivalent: minFiat } };
    }
    if (options.url.includes("/estimate")) return { status: estimateStatus, data: {} };
    if (options.url.endsWith("/currencies")) return { status: 200, data: { currencies: PAYMENT_ALLOWLIST.map((e) => e.payCurrency) } };
    if (options.url.endsWith("/invoice")) {
      posts.push(options.data);
      return { status: 200, data: { id: "5001", order_id: options.data.order_id, price_amount: options.data.price_amount, price_currency: "usd", pay_currency: options.data.pay_currency, invoice_url: "https://nowpayments.io/payment/?iid=5001" } };
    }
    return { status: 404, data: {} };
  };
  return createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
}

const CATALOG = buildCatalogFromProviderData({
  currencies: PAYMENT_ALLOWLIST.map((e) => e.payCurrency),
  merchantCoins: PAYMENT_ALLOWLIST.map((e) => e.payCurrency),
});

describe("min-amount parsing and arithmetic", () => {
  test("parses the documented schema and keeps eight decimals", () => {
    const parsed = parseMinAmount({ currency_from: "BTC", currency_to: "btc", min_amount: 0.00004123456789, fiat_equivalent: 3.123456789 }, "btc");
    assert.deepEqual(parsed, { currencyTo: "btc", minCryptoAmount: 0.00004123, minFiatEquivalent: 3.12345679 });
    assert.equal(parseMinAmount({ min_amount: "12.5", fiat_equivalent: "2" }, "trx").minCryptoAmount, 12.5);
  });

  test("rejects another currency, non-positive, non-numeric and non-object bodies", () => {
    for (const body of [{ currency_from: "eth", min_amount: 1, fiat_equivalent: 1 }, { min_amount: 0 }, { min_amount: -1 }, { min_amount: "abc" }, {}, [], null, "x"]) {
      assert.equal(parseMinAmount(body, "btc"), null, JSON.stringify(body));
    }
    assert.equal(parseMinAmount({ min_amount: 1 }, "btc").minFiatEquivalent, null);
  });

  test("minimum price in cents rounds up and is immune to float noise", () => {
    assert.equal(minimumPriceCents(3.13), 313);
    assert.equal(minimumPriceCents(3.1300001), 314);
    assert.equal(minimumPriceCents(3.1234), 313);
    assert.equal(minimumPriceCents(0.01), 1);
    assert.equal(minimumPriceCents(0.2), 20);
    assert.equal(minimumPriceCents(0.29), 29);
    assert.equal(minimumPriceCents(1.1), 110);
    for (const bad of [0, -1, NaN, null, undefined, "x"]) assert.equal(minimumPriceCents(bad), null);
  });

  test("the Toman amount quoted as the minimum really converts to at least the minimum", () => {
    for (const [cents, rate] of [[21, 250_000], [313, 262_721], [1, 100_000], [500, 99_999.5]]) {
      const toman = minimumTomanForCents(cents, rate);
      assert.ok(tomanToFiatCents(toman, rate) >= cents, `${cents}@${rate}`);
      assert.ok(tomanToFiatCents(toman - Math.ceil(rate / 100) * 2, rate) < cents, `${cents}@${rate} is not wildly over`);
    }
    assert.equal(minimumTomanForCents(0, 250_000), null);
    assert.equal(minimumTomanForCents(10, 0), null);
  });

  test("below / equal / above the minimum", () => {
    const minInfo = { minCryptoAmount: 1, minFiatEquivalent: 0.21 };
    assert.throws(() => assertMeetsMinimum({ priceAmountCents: 20, minInfo, tomanPerFiat: RATE }), (e) => e.code === "below_min_amount" && e.minToman === 52_500 && e.minPriceCents === 21);
    assert.equal(assertMeetsMinimum({ priceAmountCents: 21, minInfo, tomanPerFiat: RATE }), 21);
    assert.equal(assertMeetsMinimum({ priceAmountCents: 22, minInfo, tomanPerFiat: RATE }), 21);
  });

  test("no usable fiat minimum means unavailable, never a pass", () => {
    for (const minInfo of [null, undefined, {}, { minCryptoAmount: 1, minFiatEquivalent: null }, { minFiatEquivalent: 0 }]) {
      assert.throws(() => assertMeetsMinimum({ priceAmountCents: 99_999, minInfo, tomanPerFiat: RATE }), (e) => e.code === "min_amount_unavailable");
    }
  });
});

describe("optional safety margin for rate movement", () => {
  test("is off by default and applies on top of the provider minimum when configured", () => {
    assert.equal(CONFIG.minAmountMarginPercent, 0);
    assert.equal(minimumPriceCents(1, 0), 100);
    assert.equal(minimumPriceCents(1, 10), 110);
    assert.equal(minimumPriceCents(0.2, 5), 21);
    assert.equal(minimumPriceCents(3.13, 0), 313);
    assert.equal(minimumPriceCents(1, -1), null);
    assert.equal(minimumPriceCents(1, NaN), 100); // a non-numeric margin is treated as none; config rejects it earlier
  });

  test("a configured margin rejects an amount that only just meets the raw minimum, and the Toman hint includes it", async () => {
    const config = readNowPaymentsConfig({ ...ENV, NOWPAYMENTS_MIN_AMOUNT_MARGIN_PERCENT: "10" });
    assert.equal(config.minAmountMarginPercent, 10);
    const minInfo = { minCryptoAmount: 1, minFiatEquivalent: 1 };
    assert.throws(() => assertMeetsMinimum({ priceAmountCents: 100, minInfo, tomanPerFiat: RATE, marginPercent: 10 }), (e) => e.code === "below_min_amount" && e.minPriceCents === 110 && e.minToman === 275_000);
    assert.equal(assertMeetsMinimum({ priceAmountCents: 110, minInfo, tomanPerFiat: RATE, marginPercent: 10 }), 110);
    assert.equal(assertMeetsMinimum({ priceAmountCents: 100, minInfo, tomanPerFiat: RATE }), 100);
  });

  test("the quote path honours it, and the entered amount is still never raised", async () => {
    resetTronQuoteCacheForTests();
    const env = { ...ENV, NOWPAYMENTS_MIN_AMOUNT_MARGIN_PERCENT: "10" };
    const call = provider({ minFiat: 0.2 });
    await assert.rejects(() => quoteTronTopUp({ amountToman: 50_000, payCurrency: "trx", env, now: NOW, usdtQuote, request: call }), (e) => e.code === "below_min_amount" && e.minPriceCents === 22);
    const ok = await quoteTronTopUp({ amountToman: 55_000, payCurrency: "trx", env, now: NOW, usdtQuote, request: call });
    assert.equal(ok.amountToman, 55_000);
  });

  test("nonsense values are a configuration error, not a silent zero", () => {
    for (const bad of ["abc", "-1", "101", "NaN", "1e999"]) {
      assert.throws(() => readNowPaymentsConfig({ ...ENV, NOWPAYMENTS_MIN_AMOUNT_MARGIN_PERCENT: bad }), (e) => e.code === "not_configured", bad);
    }
    assert.equal(readNowPaymentsConfig({ ...ENV, NOWPAYMENTS_MIN_AMOUNT_MARGIN_PERCENT: "  " }).minAmountMarginPercent, 0);
  });
});

describe("GET /v1/min-amount request", () => {
  test("asks for the documented pair (pay currency -> same coin by default) in the invoice price currency", async () => {
    const paths = [];
    await requestMinAmount({ call: provider({ paths }), config: CONFIG, payCurrency: "usdttrc20" });
    const url = new URL(`https://x${paths[0]}`);
    assert.equal(url.pathname, "/min-amount");
    assert.equal(url.searchParams.get("currency_from"), "usdttrc20");
    assert.equal(url.searchParams.get("currency_to"), "usdttrc20");
    assert.equal(url.searchParams.get("fiat_equivalent"), "usd");
    assert.equal(url.searchParams.get("is_fixed_rate"), "false");
    assert.equal(url.searchParams.get("is_fee_paid_by_user"), "false");
  });

  test("a configured outcome currency becomes currency_to; a bad value is a configuration error", async () => {
    const paths = [];
    const config = readNowPaymentsConfig({ ...ENV, NOWPAYMENTS_MIN_AMOUNT_CURRENCY_TO: "USDTTRC20" });
    assert.equal(config.minAmountCurrencyTo, "usdttrc20");
    await requestMinAmount({ call: provider({ paths }), config, payCurrency: "btc" });
    assert.equal(new URL(`https://x${paths[0]}`).searchParams.get("currency_to"), "usdttrc20");
    assert.equal(readNowPaymentsConfig(ENV).minAmountCurrencyTo, null);
    assert.throws(() => readNowPaymentsConfig({ ...ENV, NOWPAYMENTS_MIN_AMOUNT_CURRENCY_TO: "bad value!" }), (e) => e.code === "not_configured");
  });

  test("a minimum returned for another outcome pair than requested is never used", async () => {
    const call = provider({ minData: { currency_from: "btc", currency_to: "trx", min_amount: 1, fiat_equivalent: 1 } });
    await assert.rejects(() => requestMinAmount({ call, config: CONFIG, payCurrency: "btc" }), (e) => e.code === "min_amount_unavailable");
  });

  test("passes the configured fixed-rate / fee options through", async () => {
    const paths = [];
    const config = readNowPaymentsConfig({ ...ENV, NOWPAYMENTS_FIXED_RATE: "true", NOWPAYMENTS_FEE_PAID_BY_USER: "1" });
    await requestMinAmount({ call: provider({ paths }), config, payCurrency: "btc" });
    const url = new URL(`https://x${paths[0]}`);
    assert.equal(url.searchParams.get("is_fixed_rate"), "true");
    assert.equal(url.searchParams.get("is_fee_paid_by_user"), "true");
  });

  test("timeouts, HTTP errors and malformed bodies are all min_amount_unavailable", async () => {
    const cases = [
      provider({ minThrows: true }),
      provider({ minStatus: 500 }),
      provider({ minStatus: 429 }),
      provider({ minStatus: 404 }),
      provider({ minStatus: 403, minData: { code: "INVALID_API_KEY", message: API_KEY } }),
      provider({ minData: { message: "nope" } }),
      provider({ minData: { currency_from: "eth", min_amount: 1, fiat_equivalent: 1 } }),
      provider({ minData: [] }),
    ];
    for (const call of cases) {
      await assert.rejects(() => requestMinAmount({ call, config: CONFIG, payCurrency: "btc" }), (e) => e.code === "min_amount_unavailable" && !String(e.message).includes(API_KEY));
    }
  });
});

describe("quote enforces the minimum for every enabled currency", () => {
  const quote = (amountToman, call, payCurrency = "usdttrc20", extra = {}) => {
    resetTronQuoteCacheForTests();
    return quoteTronTopUp({ amountToman, payCurrency, ticker: "X", network: "Y", env: ENV, now: NOW, usdtQuote, request: call, ...extra });
  };

  test("below the minimum is refused with the minimum in Toman; equal and above pass; the amount is never raised", async () => {
    const call = provider({ minFiat: 0.21 });
    await assert.rejects(() => quote(50_000, call), (e) => e.code === "below_min_amount" && e.minToman === 52_500);
    const equal = await quote(52_500, call);
    assert.equal(equal.amountToman, 52_500);
    assert.equal(equal.priceAmountCents, 21);
    const above = await quote(80_000, call);
    assert.equal(above.amountToman, 80_000);
    assert.equal(above.minAmount.minFiatEquivalent, 0.21);
  });

  test("rounding boundary: 20.5 cents rounds to 21 and meets a 0.21 minimum, 20.4 cents does not", async () => {
    const call = provider({ minFiat: 0.21 });
    assert.equal(tomanToFiatCents(51_250, RATE), 21); // 20.5 -> 21
    assert.equal((await quote(51_250, call)).priceAmountCents, 21);
    assert.equal(tomanToFiatCents(51_000, RATE), 20); // 20.4 -> 20
    await assert.rejects(() => quote(51_000, call), (e) => e.code === "below_min_amount");
  });

  test("decimal minimums keep their precision (no early rounding down)", async () => {
    const call = provider({ minFiat: 0.200049 }); // needs 21 cents, not 20
    await assert.rejects(() => quote(50_000, call), (e) => e.code === "below_min_amount");
    assert.equal((await quote(52_500, call)).priceAmountCents, 21);
  });

  test("each allowlisted currency is checked against its own minimum", async () => {
    for (const entry of PAYMENT_ALLOWLIST) {
      const call = provider({ minFiat: 5 });
      await assert.rejects(() => quote(100_000, call, entry.payCurrency), (e) => e.code === "below_min_amount", entry.payCurrency);
      assert.equal((await quote(1_300_000, call, entry.payCurrency)).payCurrency, entry.payCurrency);
    }
  });

  test("a minimum-amount outage never produces a quote, even if the estimate would work", async () => {
    for (const call of [provider({ minThrows: true }), provider({ minStatus: 500 }), provider({ minData: { garbage: true } })]) {
      await assert.rejects(() => quote(500_000, call), (e) => e.code === "min_amount_unavailable");
    }
  });

  test("a failing optional estimate does not affect an established minimum", async () => {
    const q = await quote(500_000, provider({ minFiat: 0.5, estimateStatus: 500 }));
    assert.equal(q.estimateAvailable, false);
    assert.equal(q.amountToman, 500_000);
  });
});

describe("invoice creation re-checks the minimum and the hosted URL", () => {
  const base = (call, overrides = {}) => ({ userId: 8800, amountToman: 50_000, env: ENV, invoiceModel: overrides.model, request: call, catalog: CATALOG, resolveRate: async () => ({ tomanPerFiat: RATE, source: "test" }), payCurrency: "trx", ticker: "TRX", network: "TRX", ...overrides });

  test("no quote: the live minimum blocks a too-small invoice before any POST /invoice", async () => {
    resetNowPaymentsCreateLocksForTests();
    const posts = [];
    const model = makeFakeInvoiceModel();
    await assert.rejects(() => createNowPaymentsTopUp(base(provider({ minFiat: 0.21, posts }), { model })), (e) => e.code === "below_min_amount" && e.minToman === 52_500);
    assert.equal(posts.length, 0);
    const [row] = [...model.docs.values()];
    assert.equal(row.status, "creation_failed");
    assert.equal(row.openCreateKey, undefined);
  });

  test("no quote: equal to the live minimum creates the invoice and records the minimum", async () => {
    resetNowPaymentsCreateLocksForTests();
    const posts = [];
    const model = makeFakeInvoiceModel();
    const invoice = await createNowPaymentsTopUp(base(provider({ minFiat: 0.2, minCrypto: 0.5, posts }), { model }));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].price_amount, 0.2);
    assert.equal(invoice.amountToman, 50_000);
    const [row] = [...model.docs.values()];
    assert.equal(row.minFiatEquivalent, 0.2);
    assert.equal(row.minPayAmount, 0.5);
    assert.equal(row.quoteSnapshot.minAmount.minFiatEquivalent, 0.2);
  });

  test("no quote: a min-amount outage blocks creation and is not reported as a provider rejection", async () => {
    for (const call of [provider({ minThrows: true }), provider({ minStatus: 503 }), provider({ minData: {} })]) {
      resetNowPaymentsCreateLocksForTests();
      const posts = [];
      const model = makeFakeInvoiceModel();
      await assert.rejects(() => createNowPaymentsTopUp(base(call, { model, userId: 8801 })), (e) => e.code === "min_amount_unavailable");
      assert.equal(posts.length, 0);
      assert.equal([...model.docs.values()][0].status, "creation_failed");
    }
  });

  test("a quote that already carries a too-high minimum is refused before any row is written", async () => {
    resetNowPaymentsCreateLocksForTests();
    const posts = [];
    const model = makeFakeInvoiceModel();
    const quote = { payCurrency: "trx", ticker: "TRX", network: "TRX", minAmount: { minCryptoAmount: 1, minFiatEquivalent: 5 } };
    await assert.rejects(() => createNowPaymentsTopUp(base(provider({ posts }), { model, quote })), (e) => e.code === "below_min_amount");
    assert.equal(posts.length, 0);
    assert.equal(model.docs.size, 0);
  });

  test("the user's amount is never silently increased", async () => {
    resetNowPaymentsCreateLocksForTests();
    const posts = [];
    const model = makeFakeInvoiceModel();
    const invoice = await createNowPaymentsTopUp(base(provider({ minFiat: 0.1, posts }), { model, amountToman: 83_333 }));
    assert.equal(invoice.amountToman, 83_333);
    assert.equal(posts[0].price_amount, 0.33);
    assert.equal([...model.docs.values()][0].amountToman, 83_333);
  });
});

describe("hosted invoice URL validation", () => {
  test("accepts the documented hosted URL shape, sandbox host and a differing iid (no documented contract)", () => {
    assert.equal(invoiceUrlIsUsable("https://nowpayments.io/payment/?iid=5001"), true);
    assert.equal(invoiceUrlIsUsable("https://sandbox.nowpayments.io/payment/?iid=5001"), true);
    assert.equal(invoiceUrlIsUsable("https://nowpayments.io/payment/"), true);
    assert.equal(invoiceUrlIsUsable("https://nowpayments.io/payment/?iid=9999"), true);
    assert.equal(invoiceUrlIidDiffers("https://nowpayments.io/payment/?iid=9999", "5001"), true);
    assert.equal(invoiceUrlIidDiffers("https://nowpayments.io/payment/?iid=5001", 5001), false);
    assert.equal(invoiceUrlIidDiffers("https://nowpayments.io/payment/", "5001"), false);
  });

  test("rejects unusable URLs: wrong host or scheme, credentials, bare host, junk", () => {
    for (const url of [
      "http://nowpayments.io/payment/?iid=5001",
      "https://evil.example/payment/?iid=5001",
      "https://nowpayments.io.evil.example/payment/?iid=5001",
      "https://user:pw@nowpayments.io/payment/?iid=5001",
      "https://nowpayments.io",
      "https://nowpayments.io/",
      "javascript:alert(1)",
      "nowpayments.io/payment/?iid=5001",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(invoiceUrlIsUsable(url), false, String(url));
    }
    assert.equal(invoiceUrlIsTrusted("https://nowpayments.io/"), true); // host-only trust is what the old check accepted
  });

  function providerWithInvoice(invoiceBody) {
    const transport = async (options) => {
      if (options.url.includes("/min-amount")) return { status: 200, data: { min_amount: 0.1, fiat_equivalent: 0.01 } };
      if (options.url.endsWith("/currencies")) return { status: 200, data: { currencies: ["trx"] } };
      if (options.url.endsWith("/invoice")) return { status: 200, data: { order_id: options.data.order_id, price_amount: options.data.price_amount, price_currency: "usd", pay_currency: "trx", ...invoiceBody } };
      return { status: 404, data: {} };
    };
    return createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
  }

  test("an unusable invoice_url is never delivered; the order is parked with the provider invoice id", async () => {
    for (const url of [undefined, null, "", "https://nowpayments.io/", "https://evil.example/pay", "ftp://nowpayments.io/x"]) {
      resetNowPaymentsCreateLocksForTests();
      const model = makeFakeInvoiceModel();
      await assert.rejects(() => createNowPaymentsTopUp({
        userId: 8802, amountToman: 50_000, env: ENV, invoiceModel: model, catalog: CATALOG, payCurrency: "trx",
        resolveRate: async () => ({ tomanPerFiat: RATE, source: "test" }),
        request: providerWithInvoice({ id: "5001", invoice_url: url }),
      }), (e) => e.code === "malformed_response", String(url));
      const [row] = [...model.docs.values()];
      assert.equal(row.status, "creation_unknown", String(url));
      assert.equal(row.invoiceId, "5001", String(url));
      assert.equal(row.invoiceUrl, undefined, String(url));
      assert.equal(row.recoveryStatus, "required", String(url));
      assert.equal(row.balanceCredited, false);
    }
  });

  test("incomplete provider bodies are malformed, not success", async () => {
    const bodies = [{ id: "5001" }, { invoice_url: "https://nowpayments.io/payment/?iid=5001" }, { id: "x y", invoice_url: "https://nowpayments.io/payment/?iid=x%20y" }, { id: "5001", invoice_url: "https://nowpayments.io/payment/?iid=5001", price_amount: 999 }];
    for (const body of bodies) {
      resetNowPaymentsCreateLocksForTests();
      const model = makeFakeInvoiceModel();
      await assert.rejects(() => createNowPaymentsTopUp({
        userId: 8803, amountToman: 50_000, env: ENV, invoiceModel: model, catalog: CATALOG, payCurrency: "trx",
        resolveRate: async () => ({ tomanPerFiat: RATE, source: "test" }),
        request: providerWithInvoice(body),
      }), (e) => e.code === "malformed_response", JSON.stringify(body));
      assert.equal([...model.docs.values()][0].status, "creation_unknown");
    }
  });
});

describe("provider created the invoice but the local write fails", () => {
  const args = (model, extra = {}) => ({
    userId: 8810, amountToman: 50_000, env: ENV, invoiceModel: model, catalog: CATALOG, payCurrency: "trx",
    resolveRate: async () => ({ tomanPerFiat: RATE, source: "test" }),
    request: provider({ minFiat: 0.01 }), ...extra,
  });

  test("the URL is withheld, the order is parked with the invoice id, and a re-create is blocked", async () => {
    resetNowPaymentsCreateLocksForTests();
    const model = makeFakeInvoiceModel();
    model.failOn((filter, update) => update.$set?.status === "pending");
    await assert.rejects(() => createNowPaymentsTopUp(args(model)), (e) => e.code === "persistence_failed" && !("invoiceUrl" in e));
    const [row] = [...model.docs.values()];
    assert.equal(row.status, "creation_unknown");
    assert.equal(row.invoiceId, "5001");
    assert.equal(row.invoiceUrl, undefined);
    assert.equal(row.recoveryStatus, "required");
    assert.equal(row.openCreateKey, "user:8810");
    model.failOn(null);
    await assert.rejects(() => createNowPaymentsTopUp(args(model)), (e) => e.code === "in_flight");
  });

  test("even a total database outage reports persistence_failed, not success or a provider rejection", async () => {
    resetNowPaymentsCreateLocksForTests();
    const model = makeFakeInvoiceModel();
    model.failOn((filter, update) => Boolean(update.$set?.status));
    await assert.rejects(() => createNowPaymentsTopUp(args(model)), (e) => e.code === "persistence_failed");
    const [row] = [...model.docs.values()];
    assert.equal(row.status, "creating");
    assert.notEqual(row.apiAttemptedAt, null);
  });

  test("a parked order is still settled exactly once by the verified IPN", async () => {
    resetNowPaymentsCreateLocksForTests();
    const model = makeFakeInvoiceModel();
    model.failOn((filter, update) => update.$set?.status === "pending");
    await assert.rejects(() => createNowPaymentsTopUp(args(model)), (e) => e.code === "persistence_failed");
    model.failOn(null);
    const [row] = [...model.docs.values()];
    const users = makeFakeWalletModels([{ telegramId: "8810", balance: 5 }]);
    const payload = { payment_id: "777", invoice_id: "5001", order_id: row.orderId, payment_status: "finished", price_amount: row.priceAmountCents / 100, price_currency: "usd", pay_amount: 10, actually_paid: 10, pay_currency: "trx" };
    const results = await Promise.all([1, 2, 3].map(() => applyNowPaymentsUpdate({ payload, invoiceModel: model, userModel: users.userModel })));
    assert.equal(results.filter((r) => r.credited).length, 1);
    assert.equal(users.users.get("8810").balance, 5 + 50_000);
  });
});

describe("customer-facing Persian messages", () => {
  test("every failure class has its own safe message; none leaks secrets, codes or stacks", () => {
    const codes = ["below_min_amount", "min_amount_unavailable", "persistence_failed", "malformed_response", "ambiguous", "provider_rejected", "currency_unavailable", "rate_unavailable", "estimate_unavailable"];
    const texts = codes.map((code) => failureText(Object.assign(new Error(`${code} ${API_KEY}`), { code, stack: `at secret ${API_KEY}` })));
    assert.equal(new Set(texts).size, codes.length);
    for (const text of texts) {
      assert.match(text, /[؀-ۿ]/);
      assert.equal(text.includes(API_KEY), false);
      assert.equal(/at \w|Error|stack|undefined|null/.test(text), false, text);
    }
  });

  test("below-minimum states the minimum in Toman, or stays generic when it is unknown", () => {
    assert.match(failureText({ code: "below_min_amount", minToman: 1_234_567 }), /1,234,567/);
    assert.doesNotMatch(failureText({ code: "below_min_amount" }), /\d{3}/);
    assert.doesNotMatch(failureText({ code: "below_min_amount", minToman: "<b>1</b>" }), /<b>/);
  });

  function botStub() {
    const edits = [];
    return { edits, async editMessageText(text, options) { edits.push({ text, options }); }, async answerCallbackQuery() {}, async deleteMessage() {}, async sendMessage() { return { message_id: 1 }; } };
  }

  test("a persistence failure shows its own message and a second tap cannot create another invoice", async () => {
    resetNowPaymentsConfirmLocksForTests();
    resetTronQuoteCacheForTests();
    const quote = await quoteTronTopUp({ amountToman: 500_000, payCurrency: "trx", env: ENV, now: new Date(), usdtQuote: async () => ({ tomanPerUsdt: RATE, createdAt: new Date().toISOString() }), request: provider({ minFiat: 0.1 }) });
    const bot = botStub();
    let creates = 0;
    const create = async () => { creates += 1; throw Object.assign(new Error("persistence_failed"), { code: "persistence_failed" }); };
    const session = { step: "nowpayments_confirm", messageId: 3, ownerId: 61, paymentType: "nowpayments", nowpaymentsAmount: 500_000, nowpaymentsQuote: quote, nowpaymentsAsset: { payCurrency: "trx", ticker: "TRX", network: "TRX" } };
    const query = { id: "q", from: { id: 61 }, message: { chat: { id: 61 }, message_id: 3 } };
    await confirmNowPaymentsTopUp(bot, query, session, { createNowPaymentsTopUp: create });
    assert.match(bot.edits.at(-1).text, /ثبت فاکتور/);
    assert.doesNotMatch(bot.edits.at(-1).text, /دوباره تلاش کنید/);
    await confirmNowPaymentsTopUp(bot, query, session, { createNowPaymentsTopUp: create });
    assert.equal(creates, 1);
  });
});

describe("amount parsing feeding the minimum check", () => {
  test("Persian/Arabic digits and separators become the same integer; garbage never reaches a provider", () => {
    for (const text of ["50000", "50,000", "۵۰۰۰۰", "۵۰٬۰۰۰", "٥٠٠٠٠", "٥٠،٠٠٠", " 50,000 "]) {
      assert.deepEqual(parseTopUpAmount(text, 10_000, 50_000_000), { valid: true, amount: 50_000 }, text);
    }
    for (const text of ["50.5", "-50000", "+50000", "5e4", "50,00", "050000", "٫", "", "abc", "9999", "50000001"]) {
      assert.equal(parseTopUpAmount(text, 10_000, 50_000_000).valid, false, text);
    }
  });
});
