import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchUsdtTomanQuote, getUsdtTomanQuote, parseGheymatUsdtIrt, resetGheymatCacheForTests } from "../../services/pricing/gheymatClient.js";
import { quoteTronTopUp, resetTronQuoteCacheForTests } from "../../services/pricing/tronQuote.js";
import { tomanToFiatCents } from "../../services/nowpayments/money.js";

const NOW = new Date("2026-10-18T16:16:13.406Z");

function row(overrides = {}) {
  return {
    symbol: "USDT-IRT",
    price_source: { symbol: "GHEYMAT", fa: "قیمت" },
    base_currency: { symbol: "USDT" },
    quote_currency: { symbol: "IRT", en: "Toman", fa: "تومان" },
    buy_price: "262721.00000000",
    sell_price: "262037.00000000",
    is_up_to_date: true,
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

const ENV = {
  NOWPAYMENTS_API_KEY: "unit-nowpayments-api-key",
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};

describe("Gheymat USDT/IRT units", () => {
  test("keeps a toman-labeled IRT price in toman and does not divide by 10", () => {
    const quote = parseGheymatUsdtIrt({ data: [row()] }, { now: NOW });
    assert.equal(quote.unit, "toman");
    assert.equal(quote.tomanPerUsdt, 262721);
    assert.notEqual(quote.tomanPerUsdt, 26272.1);
    assert.equal(tomanToFiatCents(50_000, quote.tomanPerUsdt), 19);
  });

  test("converts a rial-labeled quote with 1 toman = 10 rials", () => {
    const quote = parseGheymatUsdtIrt({
      data: [row({
        quote_currency: { symbol: "IRT", en: "Rial", fa: "ریال" },
        buy_price: "2627210.00000000",
        sell_price: "2620370.00000000",
      })],
    }, { now: NOW });
    assert.equal(quote.unit, "rial");
    assert.equal(quote.tomanPerUsdt, 262721);
  });

  test("rejects stale, unlabeled, inconsistent, and malformed quotes", () => {
    assert.throws(() => parseGheymatUsdtIrt({ data: [row({ is_up_to_date: false })] }, { now: NOW }), (error) => error.code === "stale");
    assert.throws(() => parseGheymatUsdtIrt({ data: [row({ created_at: "2026-10-18T15:00:00.000Z" })] }, { now: NOW, maxAgeMs: 60_000 }), (error) => error.code === "stale");
    assert.throws(() => parseGheymatUsdtIrt({ data: [] }, { now: NOW }), (error) => error.code === "stale");
    assert.throws(() => parseGheymatUsdtIrt({ data: [row({ quote_currency: { symbol: "IRT", en: "Unknown", fa: "" } })] }, { now: NOW }), (error) => error.code === "unit_mismatch");
    assert.throws(() => parseGheymatUsdtIrt({ data: [row({ buy_price: "100000", sell_price: "200000" })] }, { now: NOW }), (error) => error.code === "inconsistent");
    assert.throws(() => parseGheymatUsdtIrt({ data: [row({ buy_price: "nope" })] }, { now: NOW }), (error) => error.code === "malformed");
  });

  test("caches a successful quote and retries one server error without logging the token", async () => {
    resetGheymatCacheForTests();
    const token = "gheymat-plan-token-not-for-logs";
    const calls = [];
    const transport = async (options) => {
      calls.push(options);
      if (calls.length === 1) return { status: 500, data: { token } };
      return { status: 200, data: { data: [row()] } };
    };
    const quote = await getUsdtTomanQuote({ transport, env: { GHEYMAT_API_TOKEN: token }, now: NOW });
    assert.equal(quote.tomanPerUsdt, 262721);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.includes("base_currency=USDT"), true);
    assert.equal(calls[0].url.includes("TRX"), false);
    assert.equal(calls[0].url.includes(token), false);
    assert.equal(calls[0].headers["x-api-token"], token);
    const cached = await getUsdtTomanQuote({ transport: async () => { throw new Error("should use cache"); }, env: {}, now: new Date() });
    assert.equal(cached.tomanPerUsdt, 262721);
  });

  test("does not retry a client error or invent a price", async () => {
    resetGheymatCacheForTests();
    let calls = 0;
    await assert.rejects(() => fetchUsdtTomanQuote({
      now: NOW,
      transport: async () => { calls += 1; return { status: 422, data: { message: "invalid" } }; },
    }), (error) => error.code === "unavailable");
    assert.equal(calls, 1);
  });
});

describe("TRON quote composition", () => {
  test("combines the toman USDT quote with the NOWPayments TRX estimate", async () => {
    resetTronQuoteCacheForTests();
    const calls = [];
    const quote = await quoteTronTopUp({
      enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
      amountToman: 50_000,
      env: ENV,
      now: NOW,
      usdtQuote: async () => ({ tomanPerUsdt: 250_000, createdAt: NOW.toISOString(), source: "gheymat" }),
      request: async (options) => {
        calls.push(options);
        assert.match(options.path, /currency_from=usd/);
        assert.match(options.path, /currency_to=trx/);
        assert.match(options.path, /amount=0\.2/);
        return { status: 200, data: { currency_from: "usd", amount_from: 0.2, currency_to: "trx", estimated_amount: 0.6 } };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(quote.priceAmountCents, 20);
    assert.equal(quote.estimatedTrx, 0.6);
    assert.equal(Math.round(quote.tomanPerTrx), 83333);
    assert.notEqual(quote.tomanPerUsdt, 25_000);
  });

  test("a failed or malformed estimate does not invent a TRX price", async () => {
    resetTronQuoteCacheForTests();
    await assert.rejects(() => quoteTronTopUp({
      enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
      amountToman: 50_000,
      env: ENV,
      now: NOW,
      usdtQuote: async () => { throw new Error("timeout"); },
      request: async () => { throw new Error("should not estimate"); },
    }), (error) => error.code === "rate_unavailable");
    const mismatched = await quoteTronTopUp({
      enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
      amountToman: 50_000,
      env: ENV,
      now: NOW,
      usdtQuote: async () => ({ tomanPerUsdt: 250_000, createdAt: NOW.toISOString() }),
      request: async () => ({ status: 200, data: { currency_from: "usd", amount_from: 0.2, currency_to: "btc", estimated_amount: 1 } }),
    });
    assert.equal(mismatched.estimatedTrx, null);
    assert.equal(mismatched.amountToman, 50_000);
    assert.equal(mismatched.priceAmountCents, 20);
  });

  test("estimate HTTP failures stay optional and do not invent a TRX amount", async () => {
    const failures = [
      { status: 401, data: { code: "UNAUTHORIZED", message: "Invalid api key" } },
      { status: 403, data: { code: "INVALID_API_KEY", message: "Invalid api key" } },
      { status: 429, data: { code: "TOO_MANY_REQUESTS", message: "slow down" } },
      { status: 500, data: { code: "INTERNAL", message: "temporary" } },
      { throw: Object.assign(new Error("timeout"), { code: "ECONNABORTED" }) },
      { throw: Object.assign(new Error("connection_failed"), { code: "ECONNREFUSED" }) },
    ];
    for (const failure of failures) {
      resetTronQuoteCacheForTests();
      const quote = await quoteTronTopUp({
        enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
        amountToman: 50_000,
        env: ENV,
        now: NOW,
        usdtQuote: async () => ({ tomanPerUsdt: 250_000, createdAt: NOW.toISOString() }),
        request: async () => {
          if (failure.throw) throw failure.throw;
          return { status: failure.status, data: failure.data, providerCode: failure.data.code, providerMessage: failure.data.message };
        },
      });
      assert.equal(quote.estimatedTrx, null);
      assert.equal(quote.tomanPerUsdt, 250_000);
      assert.notEqual(quote.estimatedTrx, 0);
    }
  });

  test("missing configuration does not call the estimate endpoint", async () => {
    resetTronQuoteCacheForTests();
    let calls = 0;
    await assert.rejects(() => quoteTronTopUp({
      enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
      amountToman: 50_000,
      env: {},
      now: NOW,
      usdtQuote: async () => { throw new Error("should not quote"); },
      request: async () => { calls += 1; return { status: 200, data: {} }; },
    }), (error) => error.code === "not_configured");
    assert.equal(calls, 0);
  });

  test("estimate diagnostics record status and provider code without secrets", async () => {
    resetTronQuoteCacheForTests();
    const lines = [];
    const original = console.warn;
    console.warn = (line) => lines.push(String(line));
    try {
      await quoteTronTopUp({
        enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
        amountToman: 50_000,
        env: ENV,
        now: NOW,
        usdtQuote: async () => ({ tomanPerUsdt: 250_000, createdAt: NOW.toISOString() }),
        request: async () => ({
          status: 403,
          data: { status: false, statusCode: 403, code: "INVALID_API_KEY", message: "Invalid api key" },
          providerCode: "INVALID_API_KEY",
          providerMessage: "Invalid api key",
        }),
      });
    } finally {
      console.warn = original;
    }
    const joined = lines.join("\n");
    assert.match(joined, /"stage":"nowpayments_estimate"/);
    assert.match(joined, /"status":403/);
    assert.match(joined, /INVALID_API_KEY/);
    assert.equal(joined.includes(ENV.NOWPAYMENTS_API_KEY), false);
    assert.equal(joined.includes(ENV.NOWPAYMENTS_IPN_SECRET), false);
  });

  test("accepts a documented string estimated_amount and does not require a guessed field", async () => {
    resetTronQuoteCacheForTests();
    const quote = await quoteTronTopUp({
      enforceMinAmount: false, // isolates the optional estimate; the minimum is covered in nowpaymentsMinAmount.test.js
      amountToman: 50_000,
      env: ENV,
      now: NOW,
      usdtQuote: async () => ({ tomanPerUsdt: 250_000, createdAt: NOW.toISOString() }),
      request: async () => ({
        status: 200,
        data: { currency_from: "USD", amount_from: "0.20", currency_to: "TRX", estimated_amount: "0.600000" },
      }),
    });
    assert.equal(quote.estimatedTrx, 0.6);
  });
});
