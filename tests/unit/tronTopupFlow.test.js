import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import showPaymentMethods, { NOWPAYMENTS_BUTTON } from "../../handlers/message/showPaymentMethods.js";
import handleCallbackQuery from "../../handlers/handleCallbackQuery.js";
import handleTrxAmount from "../../paymentHandlers/handleTrxAmount.js";
import payTrx from "../../paymentHandlers/payTrx.js";
import { confirmNowPaymentsTopUp, handleNowPaymentsAmount, resetNowPaymentsConfirmLocksForTests } from "../../paymentHandlers/payNowPayments.js";
import { quoteTronTopUp, resetTronQuoteCacheForTests } from "../../services/pricing/tronQuote.js";

const LEGACY_ERROR = "در حال حاضر دریافت نرخ لحظه‌ای TRX ممکن نیست";
const ENV = {
  NOWPAYMENTS_API_KEY: "unit-nowpayments-api-key",
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};
const TRX_ASSET = { payCurrency: "trx", ticker: "TRX", network: "TRX", currencyPrecision: 6, minAmount: null };
const NOW = new Date("2026-10-18T16:16:13.406Z");

function botStub() {
  const edits = [];
  const sent = [];
  return {
    edits,
    sent,
    async editMessageText(text, options) { edits.push({ text, options }); },
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: 41 };
    },
    async deleteMessage() {},
    async answerCallbackQuery() {},
  };
}

describe("customer TRON top-up routing", () => {
  test("the menu and pay_nowpayments callback reach the NOWPayments handler", async () => {
    const menu = botStub();
    await showPaymentMethods(menu, 77);
    const button = menu.sent[0].options.reply_markup.inline_keyboard[1][0];
    assert.equal(button.text, NOWPAYMENTS_BUTTON);
    assert.equal(button.callback_data, "pay_nowpayments");

    const bot = botStub();
    await handleCallbackQuery(bot, {
      id: "cb-np",
      data: "pay_nowpayments",
      from: { id: 77 },
      message: { chat: { id: 77 }, message_id: 9 },
    });
    // Currency selection comes first: never the Toman amount prompt.
    assert.match(bot.edits.at(-1).text, /در دسترس نیست|انتخاب کنید/);
    assert.doesNotMatch(bot.edits.at(-1).text, /مبلغ شارژ را وارد کنید/);
    assert.doesNotMatch(bot.edits.at(-1).text, new RegExp(LEGACY_ERROR));
    assert.equal(JSON.stringify(bot.edits).includes("USDPrice"), false);
  });

  test("an old pay_trx callback restarts in NOWPayments and does not price TRX", async () => {
    const bot = botStub();
    await payTrx(bot, {
      id: "cb-old",
      from: { id: 78 },
      message: { chat: { id: 78 }, message_id: 4 },
    }, { messageId: 4, step: "waiting_for_trx_amount" });
    assert.doesNotMatch(bot.edits.at(-1).text, /مبلغ شارژ را وارد کنید/);
    assert.doesNotMatch(bot.edits.at(-1).text, new RegExp(LEGACY_ERROR));
    const customerSources = [
      "paymentHandlers/handleTrxAmount.js",
      "paymentHandlers/payTrx.js",
      "paymentHandlers/payNowPayments.js",
      "handlers/onMessage.js",
      "handlers/message/showPaymentMethods.js",
    ].map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).join("\n");
    assert.equal(customerSources.includes("USDPrice"), false);
    assert.equal(customerSources.includes("TRXPrice"), false);
    assert.equal(customerSources.includes(LEGACY_ERROR), false);
  });

  test("a stale waiting_for_trx_amount session does not continue the old quote", async () => {
    const bot = botStub();
    await handleTrxAmount(bot, { chat: { id: 79 }, message_id: 3, text: "50,000" }, {
      step: "waiting_for_trx_amount",
      messageId: 8,
      paymentType: "trx",
    });
    const text = bot.edits.at(-1).text;
    assert.match(text, /دوباره انتخاب کنید/);
    assert.match(text, /ثبت نشده است/);
    assert.doesNotMatch(text, new RegExp(LEGACY_ERROR));
    assert.equal(bot.edits.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data, "back_to_topup");
  });
});

describe("TRON quote and invoice guards", () => {
  test("a failed estimate still allows one hosted invoice and does not invent TRX", async () => {
    resetTronQuoteCacheForTests();
    resetNowPaymentsConfirmLocksForTests();
    const quote = await quoteTronTopUp({
      amountToman: 50_000,
      env: ENV,
      now: new Date(),
      usdtQuote: async () => ({ tomanPerUsdt: 250_000, createdAt: new Date().toISOString(), source: "gheymat" }),
      request: async () => ({ status: 403, data: { code: "INVALID_API_KEY", message: "Invalid api key" }, providerCode: "INVALID_API_KEY" }),
    });
    assert.equal(quote.estimatedTrx, null);
    assert.equal(quote.amountToman, 50_000);
    const bot = botStub();
    const created = [];
    await confirmNowPaymentsTopUp(bot, { id: "np1", from: { id: 80 }, message: { chat: { id: 80 }, message_id: 8 } }, {
      step: "nowpayments_confirm",
      messageId: 8,
      ownerId: 80,
      nowpaymentsAmount: 50_000,
      nowpaymentsQuote: quote,
    }, {
      createNowPaymentsTopUp: async (input) => {
        created.push(input);
        return {
          orderId: "NP-11111111-1111-4111-8111-111111111111",
          invoiceUrl: "https://nowpayments.io/payment/?iid=4522625843",
          amountToman: input.amountToman,
          payAmount: null,
        };
      },
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].amountToman, 50_000);
    assert.match(bot.edits.at(-1).text, /صفحه پرداخت/);
    assert.doesNotMatch(bot.edits.at(-1).text, new RegExp(LEGACY_ERROR));
    await confirmNowPaymentsTopUp(bot, { id: "np2", from: { id: 80 }, message: { chat: { id: 80 }, message_id: 8 } }, {
      step: "nowpayments_confirm",
      messageId: 8,
      ownerId: 80,
      nowpaymentsAmount: 50_000,
      nowpaymentsQuote: quote,
    }, {
      createNowPaymentsTopUp: async () => { created.push("duplicate"); return {}; },
    });
    assert.equal(created.length, 1);
  });

  test("Gheymat failure and missing credentials do not create an invoice", async () => {
    resetTronQuoteCacheForTests();
    let requests = 0;
    await assert.rejects(() => quoteTronTopUp({
      amountToman: 50_000,
      env: ENV,
      now: NOW,
      usdtQuote: async () => {
        const error = new Error("timeout");
        error.status = 503;
        throw error;
      },
      request: async () => { requests += 1; },
    }), (error) => error.code === "rate_unavailable");
    assert.equal(requests, 0);

    const bot = botStub();
    let created = 0;
    await handleNowPaymentsAmount(bot, { chat: { id: 81 }, message_id: 2, text: "50000" }, { messageId: 8, ownerId: 81, paymentType: "nowpayments", nowpaymentsAsset: TRX_ASSET }, {
      quoteTronTopUp: async () => {
        const error = new Error("unavailable");
        error.code = "rate_unavailable";
        throw error;
      },
      createNowPaymentsTopUp: async () => { created += 1; },
    });
    assert.equal(created, 0);
    assert.match(bot.edits.at(-1).text, /فاکتور ساخته نشد/);
    assert.doesNotMatch(bot.edits.at(-1).text, new RegExp(LEGACY_ERROR));

    const missing = botStub();
    await handleNowPaymentsAmount(missing, { chat: { id: 82 }, message_id: 2, text: "50000" }, { messageId: 8, ownerId: 82, paymentType: "nowpayments", nowpaymentsAsset: TRX_ASSET }, {
      quoteTronTopUp: async () => {
        const error = new Error("not_configured");
        error.code = "not_configured";
        throw error;
      },
      createNowPaymentsTopUp: async () => { created += 1; },
    });
    assert.equal(created, 0);
    assert.match(missing.edits.at(-1).text, /موقتاً در دسترس نیست/);
    assert.equal(JSON.stringify(missing.edits).includes("unit-nowpayments-api-key"), false);
  });
});
