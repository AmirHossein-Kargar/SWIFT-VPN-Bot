import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PAYMENT_CHOICES,
  PAYMENT_ALLOWLIST,
  allowlistEntryFor,
  resolvePaymentAllowlist,
} from "../../services/nowpayments/allowlist.js";
import {
  applyPaymentAllowlist,
  buildCatalogFromProviderData,
  fetchPaymentCatalog,
  resetNowPaymentsCatalogCacheForTests,
  validateCatalogSelection,
} from "../../services/nowpayments/catalog.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../../services/nowpayments/createInvoice.js";
import { createNowPaymentsRequest } from "../../services/nowpayments/nowpaymentsClient.js";
import { handleNowPaymentsCurrencyMenu } from "../../paymentHandlers/payNowPayments.js";
import { makeFakeInvoiceModel } from "../helpers/fakeNowPaymentsInvoiceModel.js";

const API_KEY = "unit-allowlist-api-key-0001";
const ENV = {
  NOWPAYMENTS_API_KEY: API_KEY,
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};
const ALL_CODES = PAYMENT_ALLOWLIST.map((entry) => entry.payCurrency);
const EXTRA_CODES = ["doge", "eth", "usdterc20", "xrp", "sol", "usdcsol"];

/** A merchant that enabled the whole allowlist plus coins that must never reach customers. */
function wideCatalog(extra = EXTRA_CODES, drop = []) {
  const codes = [...ALL_CODES.filter((code) => !drop.includes(code)), ...extra];
  return buildCatalogFromProviderData({ currencies: codes, merchantCoins: codes });
}

describe("payment allowlist definition", () => {
  test("lists at most ten unique, well-formed choices", () => {
    assert.ok(PAYMENT_ALLOWLIST.length >= 1 && PAYMENT_ALLOWLIST.length <= MAX_PAYMENT_CHOICES);
    assert.equal(new Set(ALL_CODES).size, ALL_CODES.length);
    assert.equal(new Set(PAYMENT_ALLOWLIST.map((e) => `${e.ticker}:${e.network}`)).size, PAYMENT_ALLOWLIST.length);
    for (const entry of PAYMENT_ALLOWLIST) assert.match(entry.payCurrency, /^[a-z0-9]{2,24}$/);
    assert.equal(resolvePaymentAllowlist({}).length, PAYMENT_ALLOWLIST.length);
  });

  test("every USDT network is its own choice with its own provider code", () => {
    const usdt = PAYMENT_ALLOWLIST.filter((entry) => entry.ticker === "USDT");
    assert.ok(usdt.length >= 2);
    assert.equal(new Set(usdt.map((e) => e.network)).size, usdt.length);
    assert.equal(allowlistEntryFor("usdttrc20").network, "TRC20");
    assert.equal(allowlistEntryFor("usdtbsc").network, "BEP20");
    assert.notEqual(allowlistEntryFor("usdttrc20").payCurrency, allowlistEntryFor("usdtbsc").payCurrency);
  });

  test("the environment can narrow the list but never extend it", () => {
    assert.deepEqual(resolvePaymentAllowlist({ NOWPAYMENTS_ENABLED_CURRENCIES: "btc, TRX" }).map((e) => e.payCurrency), ["trx", "btc"]);
    assert.deepEqual(resolvePaymentAllowlist({ NOWPAYMENTS_ENABLED_CURRENCIES: "doge,eth" }), []);
    assert.deepEqual(resolvePaymentAllowlist({ NOWPAYMENTS_ENABLED_CURRENCIES: "btc,doge" }).map((e) => e.payCurrency), ["btc"]);
    assert.equal(allowlistEntryFor("doge", { NOWPAYMENTS_ENABLED_CURRENCIES: "doge" }), null);
  });

  test("a malformed list resolves to nothing instead of everything", () => {
    const entry = (n) => ({ payCurrency: `c${n}x`, ticker: `T${n}X`, network: `N${n}X` });
    assert.deepEqual(resolvePaymentAllowlist({}, Array.from({ length: MAX_PAYMENT_CHOICES + 1 }, (_, i) => entry(i))), []);
    assert.deepEqual(resolvePaymentAllowlist({}, [entry(1), entry(1)]), []);
    assert.deepEqual(resolvePaymentAllowlist({}, [{ payCurrency: "BTC", ticker: "BTC", network: "BTC" }]), []);
    assert.deepEqual(resolvePaymentAllowlist({}, []), []);
    assert.deepEqual(resolvePaymentAllowlist({}, null), []);
  });
});

describe("customer catalog is allowlist ∩ merchant account", () => {
  test("only allowlisted, merchant-enabled assets survive; extras are removed", () => {
    const catalog = applyPaymentAllowlist(wideCatalog(), { env: {} });
    assert.deepEqual(catalog.assets.map((a) => a.code), ALL_CODES);
    for (const code of EXTRA_CODES) assert.equal(catalog.byCode[code], undefined, code);
    assert.ok(catalog.assets.length <= MAX_PAYMENT_CHOICES);
  });

  test("an allowlisted code the merchant has not enabled is hidden, not substituted", () => {
    const catalog = applyPaymentAllowlist(wideCatalog(EXTRA_CODES, ["usdtbsc", "ltc"]), { env: {} });
    assert.equal(catalog.byCode.usdtbsc, undefined);
    assert.equal(catalog.byCode.ltc, undefined);
    assert.equal(catalog.assets.length, ALL_CODES.length - 2);
    assert.throws(() => validateCatalogSelection(catalog, { payCurrency: "usdtbsc" }), (e) => e.code === "currency_unavailable");
  });

  test("customer labels come from the allowlist, not from provider-name heuristics", () => {
    const catalog = applyPaymentAllowlist(wideCatalog(), { env: {} });
    assert.equal(catalog.byCode.usdtbsc.network, "BEP20");
    assert.equal(catalog.byCode.bnbbsc.ticker, "BNB");
    const usdt = catalog.groups.find((g) => g.ticker === "USDT");
    assert.deepEqual(usdt.networks.map((n) => n.network), ["TRC20", "BEP20", "TON", "SOL", "POLYGON"]);
    assert.equal(usdt.requiresNetworkSelection, true);
    const total = catalog.groups.reduce((sum, group) => sum + group.networks.length, 0);
    assert.ok(total <= MAX_PAYMENT_CHOICES);
  });

  test("fails closed when the merchant list was not part of the catalog or the intersection is empty", () => {
    const unverified = buildCatalogFromProviderData({ currencies: ALL_CODES });
    assert.equal(unverified.merchantVerified, false);
    assert.throws(() => applyPaymentAllowlist(unverified, { env: {} }), (e) => e.code === "currency_unavailable");
    const disjoint = buildCatalogFromProviderData({ currencies: ["doge", "eth"], merchantCoins: ["doge", "eth"] });
    assert.throws(() => applyPaymentAllowlist(disjoint, { env: {} }), (e) => e.code === "currency_unavailable");
    assert.throws(() => applyPaymentAllowlist(wideCatalog(), { env: { NOWPAYMENTS_ENABLED_CURRENCIES: "doge" } }), (e) => e.code === "currency_unavailable");
    assert.throws(() => applyPaymentAllowlist(null, { env: {} }), (e) => e.code === "currency_unavailable");
  });

  test("fetchPaymentCatalog does not fall back to the global list when /merchant/coins is down", async () => {
    resetNowPaymentsCatalogCacheForTests();
    const transport = async ({ url }) => {
      if (url.endsWith("/merchant/coins")) return { status: 500, data: {} };
      if (url.includes("/currencies")) return { status: 200, data: { currencies: [...ALL_CODES, ...EXTRA_CODES] } };
      return { status: 404, data: {} };
    };
    const request = createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
    await assert.rejects(() => fetchPaymentCatalog({ env: ENV, request, forceRefresh: true }), (e) => e.code === "currency_unavailable");
  });

  test("fetchPaymentCatalog returns only the allowlisted intersection from the provider endpoints", async () => {
    resetNowPaymentsCatalogCacheForTests();
    const merchantEnabled = ["btc", "trx", "usdttrc20", "doge", "eth"];
    const transport = async ({ url }) => {
      if (url.endsWith("/merchant/coins")) return { status: 200, data: { selectedCurrencies: merchantEnabled.map((c) => c.toUpperCase()) } };
      if (url.includes("/currencies")) return { status: 200, data: { currencies: [...ALL_CODES, ...EXTRA_CODES] } };
      return { status: 404, data: {} };
    };
    const request = createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
    const catalog = await fetchPaymentCatalog({ env: ENV, request, forceRefresh: true });
    assert.deepEqual(catalog.assets.map((a) => a.code), ["usdttrc20", "trx", "btc"]);
  });

  test("the currency menu offers allowlisted tickers only, in at most ten choices", async () => {
    const edits = [];
    const bot = {
      async editMessageText(text, options) { edits.push({ text, options }); },
      async answerCallbackQuery() {},
    };
    const catalog = applyPaymentAllowlist(wideCatalog(), { env: {} });
    await handleNowPaymentsCurrencyMenu(bot, { id: "q", from: { id: 5 }, message: { chat: { id: 5 }, message_id: 9 } }, {
      step: "waiting_for_nowpayments_currency",
      paymentType: "nowpayments",
      ownerId: 5,
      messageId: 9,
    }, { catalog });
    const buttons = edits.at(-1).options.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data?.startsWith("np_asset:"));
    assert.deepEqual(buttons.map((b) => b.callback_data.slice(9)).sort(), ["BNB", "BTC", "LTC", "TON", "TRX", "USDT"]);
    assert.ok(buttons.length <= MAX_PAYMENT_CHOICES);
  });
});

describe("server-side currency/network enforcement", () => {
  const FIAT_RATE = async () => ({ tomanPerFiat: 100_000, source: "test" });
  function harness(overrides = {}) {
    const posts = [];
    const transport = async (options) => {
      if (options.url.includes("/min-amount")) return { status: 200, data: { min_amount: 0.0001, fiat_equivalent: 0.01 } };
      if (options.url.endsWith("/currencies")) return { status: 200, data: { currencies: [...ALL_CODES, ...EXTRA_CODES] } };
      if (options.url.endsWith("/invoice")) {
        posts.push(options.data);
        const id = String(4000 + posts.length);
        return { status: 200, data: { id, order_id: options.data.order_id, price_amount: options.data.price_amount, price_currency: options.data.price_currency, pay_currency: options.data.pay_currency, invoice_url: `https://nowpayments.io/payment/?iid=${id}` } };
      }
      return { status: 404, data: {} };
    };
    const model = makeFakeInvoiceModel();
    const request = createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
    return { posts, model, base: { amountToman: 200_000, env: ENV, invoiceModel: model, request, catalog: wideCatalog(), resolveRate: FIAT_RATE, ...overrides } };
  }

  test("each enabled currency/network creates an invoice with exactly its own pay_currency", async () => {
    for (const [index, entry] of PAYMENT_ALLOWLIST.entries()) {
      resetNowPaymentsCreateLocksForTests();
      const { posts, base } = harness();
      const invoice = await createNowPaymentsTopUp({ ...base, userId: 9000 + index, payCurrency: entry.payCurrency, ticker: entry.ticker, network: entry.network });
      assert.equal(posts.length, 1, entry.payCurrency);
      assert.equal(posts[0].pay_currency, entry.payCurrency);
      assert.equal(invoice.ticker, entry.ticker);
      assert.equal(invoice.network, entry.network);
    }
  });

  test("a currency outside the allowlist is rejected before any row or provider call, even if the merchant has it", async () => {
    for (const code of EXTRA_CODES) {
      resetNowPaymentsCreateLocksForTests();
      const { posts, model, base } = harness();
      await assert.rejects(() => createNowPaymentsTopUp({ ...base, userId: 9100, payCurrency: code }), (e) => e.code === "currency_unavailable", code);
      assert.equal(posts.length, 0, code);
      assert.equal(model.docs.size, 0, code);
    }
  });

  test("a wrong network or ticker for an allowlisted code is refused, never silently switched", async () => {
    resetNowPaymentsCreateLocksForTests();
    const { posts, model, base } = harness();
    await assert.rejects(() => createNowPaymentsTopUp({ ...base, userId: 9101, payCurrency: "usdtbsc", ticker: "USDT", network: "TRC20" }), (e) => e.code === "invalid_network_selection");
    await assert.rejects(() => createNowPaymentsTopUp({ ...base, userId: 9101, payCurrency: "usdtbsc", ticker: "USDC", network: "BEP20" }), (e) => e.code === "invalid_currency_selection");
    assert.equal(posts.length, 0);
    assert.equal(model.docs.size, 0);
  });

  test("narrowing the allowlist by environment is enforced at creation time too", async () => {
    resetNowPaymentsCreateLocksForTests();
    const { posts, base } = harness();
    const env = { ...ENV, NOWPAYMENTS_ENABLED_CURRENCIES: "trx" };
    await assert.rejects(() => createNowPaymentsTopUp({ ...base, env, userId: 9102, payCurrency: "btc" }), (e) => e.code === "currency_unavailable");
    const ok = await createNowPaymentsTopUp({ ...base, env, userId: 9102, payCurrency: "trx" });
    assert.equal(ok.payCurrency, "trx");
    assert.equal(posts.length, 1);
  });

  test("a merchant that has not enabled the code at creation time blocks it", async () => {
    resetNowPaymentsCreateLocksForTests();
    const { posts, model, base } = harness({ catalog: wideCatalog(EXTRA_CODES, ["ltc"]) });
    await assert.rejects(() => createNowPaymentsTopUp({ ...base, userId: 9103, payCurrency: "ltc" }), (e) => e.code === "currency_unavailable");
    assert.equal(posts.length, 0);
    assert.equal([...model.docs.values()][0].status, "creation_failed");
  });
});
