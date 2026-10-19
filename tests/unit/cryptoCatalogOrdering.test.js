import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PREFERRED_TICKERS,
  buildCatalogFromProviderData,
  fetchNowPaymentsCatalog,
  resetNowPaymentsCatalogCacheForTests,
  validateCatalogSelection,
} from "../../services/nowpayments/catalog.js";
import { createNowPaymentsRequest } from "../../services/nowpayments/nowpaymentsClient.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../../services/nowpayments/createInvoice.js";
import { currencyGroupLabel } from "../../services/nowpayments/labels.js";
import {
  handleNowPaymentsBackToNetwork,
  handleNowPaymentsSelectAsset,
  handleNowPaymentsSelectNetwork,
  payNowPayments,
} from "../../paymentHandlers/payNowPayments.js";

const API_KEY = "unit-catalog-api-key-0001";
const ENV = {
  NOWPAYMENTS_API_KEY: API_KEY,
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};

function full(code, ticker, network, extra = {}) {
  return { id: code, code, name: code, ticker, network, enable: true, ...extra };
}

// Shaped like the provider's /full-currencies: the `network` field of
// USDT-TRC20 is "trx", which is not what customers call it.
const FULL = [
  full("ltc", "ltc", "ltc"),
  full("usdterc20", "usdt", "eth"),
  full("eth", "eth", "eth"),
  full("doge", "doge", "doge"),
  full("btc", "btc", "btc"),
  full("usdttrc20", "usdt", "trx"),
  full("usdtton", "usdt", "ton"),
  full("ton", "ton", "ton"),
  full("trx", "trx", "trx"),
  full("usdtbsc", "usdt", "bsc"),
  full("usdtbep20", "usdt", "bsc"),
  full("usdcsol", "usdc", "sol", { enable: false }),
];

const MERCHANT = ["ltc", "USDTERC20", "eth", "doge", "btc", "usdttrc20", "usdtton", "ton", "trx", "usdtbsc", "usdtbep20"];

describe("crypto menu ordering and deduplication", () => {
  const catalog = buildCatalogFromProviderData({
    currencies: MERCHANT,
    fullCurrencies: FULL,
    merchantCoins: MERCHANT,
  });

  test("preferred assets come first in the fixed order, others follow", () => {
    assert.deepEqual(PREFERRED_TICKERS, ["USDT", "TON", "TRX", "BTC", "LTC", "ETH"]);
    assert.deepEqual(catalog.groups.map((g) => g.ticker), ["USDT", "TON", "TRX", "BTC", "LTC", "ETH", "DOGE"]);
  });

  test("USDT appears exactly once; TON and USDT-on-TON are different options", () => {
    const tickers = catalog.groups.map((g) => g.ticker);
    assert.equal(tickers.filter((t) => t === "USDT").length, 1);
    assert.equal(tickers.filter((t) => t === "TON").length, 1);
    const usdt = catalog.groups.find((g) => g.ticker === "USDT");
    const ton = catalog.groups.find((g) => g.ticker === "TON");
    assert.ok(usdt.networks.some((n) => n.payCurrency === "usdtton" && n.network === "TON"));
    assert.deepEqual(ton.networks.map((n) => n.payCurrency), ["ton"]);
  });

  test("networks are labelled from the code (TRC20), not the provider's chain field", () => {
    const usdt = catalog.groups.find((g) => g.ticker === "USDT");
    const byCode = Object.fromEntries(usdt.networks.map((n) => [n.payCurrency, n.network]));
    assert.equal(byCode.usdttrc20, "TRC20");
    assert.equal(byCode.usdterc20, "ERC20");
    assert.equal(byCode.usdtton, "TON");
  });

  test("no ticker/network pair is duplicated, even when two codes alias the same one", () => {
    const pairs = catalog.assets.map((a) => `${a.ticker}:${a.network}`);
    assert.equal(new Set(pairs).size, pairs.length);
    const usdt = catalog.groups.find((g) => g.ticker === "USDT");
    assert.deepEqual(usdt.networks.filter((n) => n.payCurrency.startsWith("usdtb")).map((n) => n.network).sort(), ["BEP20", "BSC"]);
    const codes = usdt.networks.map((n) => n.payCurrency);
    assert.equal(new Set(codes).size, codes.length);

    const aliased = buildCatalogFromProviderData({
      currencies: ["usdttrc20", "USDTTRC20"],
      fullCurrencies: [full("usdttrc20", "usdt", "trx"), full("USDTTRC20", "USDT", "TRX")],
    });
    assert.equal(aliased.assets.length, 1);
  });

  test("assets the merchant has not enabled or the provider disabled are never shown", () => {
    const partial = buildCatalogFromProviderData({
      currencies: MERCHANT,
      fullCurrencies: FULL,
      merchantCoins: ["usdttrc20", "btc", "usdcsol"],
    });
    assert.deepEqual(partial.groups.map((g) => g.ticker), ["USDT", "BTC"]);
    assert.deepEqual(partial.groups[0].networks.map((n) => n.network), ["TRC20"]);
    assert.throws(() => validateCatalogSelection(partial, { payCurrency: "usdtton" }), (e) => e.code === "currency_unavailable");
    assert.throws(() => validateCatalogSelection(partial, { payCurrency: "usdcsol" }), (e) => e.code === "currency_unavailable");
  });

  test("a missing preferred asset is skipped, not fabricated", () => {
    const noTon = buildCatalogFromProviderData({
      currencies: ["btc", "usdttrc20", "ltc"],
      fullCurrencies: FULL.filter((c) => ["btc", "usdttrc20", "ltc"].includes(c.code)),
      merchantCoins: ["btc", "usdttrc20", "ltc"],
    });
    assert.deepEqual(noTon.groups.map((g) => g.ticker), ["USDT", "BTC", "LTC"]);
  });

  test("button labels: preferred emoji, neutral icon for the rest, no network in the first menu", () => {
    const labels = catalog.groups.map(currencyGroupLabel);
    assert.deepEqual(labels.slice(0, 6), ["🟢 USDT", "💎 TON", "🔴 TRX", "🟡 BTC", "🟣 LTC", "🔷 ETH"]);
    assert.equal(labels[6], "🪙 DOGE");
  });
});

describe("merchant availability is mandatory", () => {
  beforeEach(() => resetNowPaymentsCatalogCacheForTests());

  function requestWith(handler) {
    return createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport: async (o) => handler(o.url) });
  }
  const ok = (data) => ({ status: 200, data });
  const routes = (url, merchant) => {
    if (url.includes("fixed_rate")) return ok({ currencies: ["btc"] });
    if (url.endsWith("/currencies")) return ok({ currencies: ["btc", "usdttrc20"] });
    if (url.endsWith("/full-currencies")) return ok({ currencies: FULL });
    if (url.endsWith("/merchant/coins")) return merchant;
    return { status: 404, data: {} };
  };

  test("the catalog is built from /merchant/coins", async () => {
    const request = requestWith((url) => routes(url, ok({ selectedCurrencies: ["BTC", "USDTTRC20"] })));
    const catalog = await fetchNowPaymentsCatalog({ env: ENV, request, forceRefresh: true });
    assert.deepEqual(catalog.groups.map((g) => g.ticker), ["USDT", "BTC"]);
  });

  test("a failing, empty or rate-limited merchant list yields a retryable error, never the global list", async () => {
    for (const merchant of [
      { status: 500, data: {} },
      { status: 429, data: {} },
      { status: 401, data: { message: "bad key" } },
      ok({ selectedCurrencies: [] }),
      ok({ unexpected: true }),
    ]) {
      resetNowPaymentsCatalogCacheForTests();
      const request = requestWith((url) => routes(url, merchant));
      await assert.rejects(
        () => fetchNowPaymentsCatalog({ env: ENV, request, forceRefresh: true }),
        (error) => error.code === "currency_unavailable",
      );
    }
  });
});

describe("two-step selection and invoice payload", () => {
  beforeEach(() => resetNowPaymentsCreateLocksForTests());
  const catalog = buildCatalogFromProviderData({ currencies: MERCHANT, fullCurrencies: FULL, merchantCoins: MERCHANT });
  const sess = (extra = {}) => ({ messageId: 5, ownerId: 700, paymentType: "nowpayments", step: "waiting_for_nowpayments_currency", ...extra });
  const q = (id) => ({ id, from: { id: 700 }, message: { chat: { id: 700 }, message_id: 5 } });
  function botStub() {
    const edits = [];
    return {
      edits,
      async editMessageText(text, options) { edits.push({ text, options }); },
      async deleteMessage() {},
      async answerCallbackQuery() {},
    };
  }
  const buttons = (bot) => bot.edits.at(-1).options.reply_markup.inline_keyboard.flat();

  test("menu 1 lists each asset once, menu 2 lists every network of the chosen asset", async () => {
    const bot = botStub();
    await payNowPayments(bot, q("a"), { messageId: 5 }, { catalog });
    const first = buttons(bot).map((b) => b.callback_data).filter((c) => c.startsWith("np_asset:"));
    assert.deepEqual(first, ["np_asset:USDT", "np_asset:TON", "np_asset:TRX", "np_asset:BTC", "np_asset:LTC", "np_asset:ETH", "np_asset:DOGE"]);
    assert.match(bot.edits.at(-1).text, /ارز دیجیتال موردنظر را انتخاب کنید/);

    await handleNowPaymentsSelectAsset(bot, q("b"), "USDT", sess(), { catalog });
    assert.match(bot.edits.at(-1).text, /شبکه انتقال USDT را انتخاب کنید/);
    const nets = buttons(bot).filter((b) => b.callback_data.startsWith("np_net:"));
    assert.deepEqual(nets.map((b) => b.callback_data).sort(), ["np_net:usdtbep20", "np_net:usdtbsc", "np_net:usdterc20", "np_net:usdtton", "np_net:usdttrc20"]);
    assert.equal(new Set(nets.map((b) => b.text)).size, nets.length, "no duplicate labels");
    assert.ok(buttons(bot).some((b) => b.callback_data === "np_select_currency"), "back to menu 1");
  });

  test("TON shows only its own network list, not USDT's", async () => {
    const bot = botStub();
    await handleNowPaymentsSelectAsset(bot, q("c"), "TON", sess(), { catalog });
    assert.deepEqual(buttons(bot).filter((b) => b.callback_data.startsWith("np_net:")).map((b) => b.callback_data), ["np_net:ton"]);
  });

  test("USDT-TRC20 and USDT-TON map to their own pay_currency; cross-ticker network codes are refused", async () => {
    const bot = botStub();
    const quoted = [];
    const quoteTronTopUp = async (input) => { quoted.push(input); return { amountToman: input.amountToman, ticker: input.ticker, network: input.network, payCurrency: input.payCurrency }; };
    const networkSession = sess({ step: "waiting_for_nowpayments_network", nowpaymentsPendingTicker: "USDT", nowpaymentsAmount: 100_000 });
    await handleNowPaymentsSelectNetwork(bot, q("d"), "usdtton", networkSession, { catalog, quoteTronTopUp });
    await handleNowPaymentsSelectNetwork(bot, q("e"), "usdttrc20", networkSession, { catalog, quoteTronTopUp });
    assert.deepEqual(quoted.map((x) => [x.payCurrency, x.ticker, x.network]), [["usdtton", "USDT", "TON"], ["usdttrc20", "USDT", "TRC20"]]);

    await handleNowPaymentsSelectNetwork(bot, q("f"), "ton", networkSession, { catalog, quoteTronTopUp });
    assert.equal(quoted.length, 2, "native TON must not be accepted from the USDT network menu");
  });

  test("back from the amount prompt returns to the network menu of the same asset", async () => {
    const bot = botStub();
    const asset = { payCurrency: "usdtton", ticker: "USDT", network: "TON" };
    await handleNowPaymentsBackToNetwork(bot, q("g"), sess({ step: "waiting_for_nowpayments_amount", nowpaymentsAsset: asset }), { catalog });
    assert.match(bot.edits.at(-1).text, /شبکه انتقال USDT/);
    assert.ok(buttons(bot).some((b) => b.callback_data === "np_net:usdtton"));
  });

  test("the invoice request carries exactly the selected pay_currency and refuses a mismatched network", async () => {
    const posts = [];
    const store = new Map();
    const model = {
      async create(doc) { store.set(doc.orderId, { ...doc }); return doc; },
      findOne() { return { lean: async () => null }; },
      async updateOne(filter, update) {
        const doc = store.get(filter.orderId);
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: doc ? 1 : 0 };
      },
    };
    const transport = async (options) => {
      if (options.url.endsWith("/currencies")) return { status: 200, data: { currencies: MERCHANT.map((c) => c.toLowerCase()) } };
      if (options.url.endsWith("/invoice")) {
        posts.push(options.data);
        return { status: 200, data: { id: "INV-1", order_id: options.data.order_id, price_amount: options.data.price_amount, price_currency: options.data.price_currency, pay_currency: options.data.pay_currency, invoice_url: "https://nowpayments.io/payment/?iid=INV-1" } };
      }
      return { status: 404, data: {} };
    };
    const request = createNowPaymentsRequest({ apiKey: API_KEY, baseURL: "https://api.nowpayments.io/v1", transport });
    const base = { userId: 700, amountToman: 100_000, env: ENV, invoiceModel: model, request, catalog, resolveRate: async () => ({ tomanPerFiat: 100_000, source: "test" }) };

    const created = await createNowPaymentsTopUp({ ...base, payCurrency: "usdtton", ticker: "USDT", network: "TON" });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].pay_currency, "usdtton");
    assert.equal(created.payCurrency, "usdtton");
    assert.equal(created.network, "TON");
    assert.equal(created.invoiceUrl, "https://nowpayments.io/payment/?iid=INV-1");
    assert.equal([...store.values()][0].network, "TON");

    // Same code but the session claims another network: never silently switched.
    await assert.rejects(
      () => createNowPaymentsTopUp({ ...base, payCurrency: "usdtton", ticker: "USDT", network: "TRC20" }),
      (error) => error.code === "invalid_network_selection",
    );
    // Code outside the merchant's enabled list.
    const narrow = buildCatalogFromProviderData({ currencies: ["btc"], merchantCoins: ["btc"] });
    await assert.rejects(
      () => createNowPaymentsTopUp({ ...base, catalog: narrow, payCurrency: "usdtton", ticker: "USDT", network: "TON" }),
      (error) => error.code === "currency_unavailable",
    );
    assert.equal(posts.length, 1, "no invoice was requested for the refused selections");
  });
});

describe("card-to-card copy", () => {
  test("the 20% gateway-fee notice is gone from the customer prompt", () => {
    const source = readFileSync(new URL("../../paymentHandlers/payHoosh.js", import.meta.url), "utf8");
    assert.equal(source.includes("۲۰٪ (روی مبلغ پرداختی شما اعمال می"), false);
    assert.equal(source.includes("ℹ️"), false);
  });
});
