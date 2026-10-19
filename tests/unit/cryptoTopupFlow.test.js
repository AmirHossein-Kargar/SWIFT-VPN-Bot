import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WELCOME_MESSAGE } from "../../messages/staticMessages.js";
import showPaymentMethods, { HOOSH_PAY_BUTTON, NOWPAYMENTS_BUTTON } from "../../handlers/message/showPaymentMethods.js";
import { buildCatalogFromProviderData } from "../../services/nowpayments/catalog.js";
import { currencyGroupLabel, paginateGroups } from "../../services/nowpayments/labels.js";
import { parseTopUpAmount, resolveTopUpLimits } from "../../utils/validationAmount.js";
import {
  confirmNowPaymentsTopUp,
  handleNowPaymentsAmount,
  handleNowPaymentsBackToAmount,
  handleNowPaymentsCancel,
  handleNowPaymentsSelectAsset,
  handleNowPaymentsSelectNetwork,
  handleNowPaymentsStatus,
  nowPaymentsConfirmMessage,
  nowPaymentsStatusMessage,
  payNowPayments,
  resetNowPaymentsConfirmLocksForTests,
} from "../../paymentHandlers/payNowPayments.js";

function coin(code, ticker, network, extra = {}) {
  return { id: code, code, name: ticker, ticker, network, enable: true, network_precision: 8, ...extra };
}

function makeCatalog(extra = []) {
  return buildCatalogFromProviderData({
    currencies: ["btc", "ltc", "usdttrc20", "usdterc20", ...extra.map((e) => e.code)],
    fullCurrencies: [
      coin("btc", "BTC", "BTC"),
      coin("ltc", "LTC", "LTC"),
      coin("usdttrc20", "USDT", "TRC20"),
      coin("usdterc20", "USDT", "ERC20"),
      coin("shadow", "SHD", "SHD", { enable: false }),
      ...extra,
    ],
  });
}

function botStub() {
  const edits = [];
  const answers = [];
  return {
    edits,
    answers,
    async editMessageText(text, options) { edits.push({ text, options }); },
    async sendMessage(chatId, text, options) { edits.push({ text, options }); return { message_id: 41 }; },
    async deleteMessage() {},
    async answerCallbackQuery(id, options) { answers.push({ id, options }); },
  };
}

// Sessions live in Redis in production and are a no-op in unit tests, so every
// handler receives its session explicitly.
const sess = (extra = {}) => ({ messageId: 5, ownerId: 900, paymentType: "nowpayments", step: "waiting_for_nowpayments_currency", ...extra });
const flat = (bot) => bot.edits.at(-1).options.reply_markup.inline_keyboard.flat();
const query = (id, userId = 900, messageId = 5) => ({ id, from: { id: userId }, message: { chat: { id: userId }, message_id: messageId } });

describe("welcome message and payment method menu", () => {
  test("/start welcome text matches the approved Persian copy", () => {
    assert.equal(
      WELCOME_MESSAGE,
      [
        "🤖 به ربات سویفت خوش آمدید!",
        "",
        "🚀 سویفت، شتاب‌دهنده اینترنت شما با لوکیشن‌های مختلف.",
        "",
        "📱 قابل استفاده در اندروید، ویندوز، آیفون و سایر دستگاه‌ها.",
        "",
        "🌐 قابل استفاده روی اینترنت‌های مختلف.",
        "",
        "🔻 از منوی زیر یک گزینه را انتخاب کنید.",
      ].join("\n"),
    );
  });

  test("top-up menu shows the two renamed methods and no provider brand", async () => {
    const bot = botStub();
    await showPaymentMethods(bot, 901);
    const { text, options } = bot.edits[0];
    assert.match(text, /💰 افزایش موجودی کیف پول/);
    assert.match(text, /لطفاً روش پرداخت را انتخاب کنید/);
    const buttons = options.reply_markup.inline_keyboard.flat();
    assert.equal(HOOSH_PAY_BUTTON, "💳 پرداخت آنلاین کارت به کارت");
    assert.equal(NOWPAYMENTS_BUTTON, "🪙 پرداخت با کریپتو");
    assert.deepEqual(buttons.map((b) => b.callback_data), ["pay_hoosh", "pay_nowpayments", "back_to_home"]);
    assert.equal(/hooshpay|nowpayments/i.test(buttons.map((b) => b.text).join(" ") + text), false);
  });
});

describe("top-up amount parsing and limits", () => {
  const ok = (text) => parseTopUpAmount(text, 10_000, 50_000_000);

  test("accepts Persian, Arabic-Indic and Western digits with separators and whitespace", () => {
    for (const text of ["50000", "۵۰۰۰۰", "٥٠٠٠٠", "50,000", "۵۰٬۰۰۰", "۵۰،۰۰۰", "  50,000  ", "‏50000‏"]) {
      assert.deepEqual(ok(text), { valid: true, amount: 50_000 }, text);
    }
  });

  test("rejects malformed, fractional, signed, out-of-range and unsafe values", () => {
    for (const text of ["", "   ", "abc", "0", "-50000", "+50000", "50000.5", "۵۰۰۰۰٫۵", "1e5", "50,00", "9,999", "50000001", "9007199254740993", "99999999999999999999", "0500000"]) {
      assert.equal(ok(text).valid, false, text);
    }
    assert.equal(parseTopUpAmount(undefined).valid, false);
    assert.equal(parseTopUpAmount(50000).valid, false);
    assert.deepEqual(ok("10000"), { valid: true, amount: 10_000 });
    assert.deepEqual(ok("50000000"), { valid: true, amount: 50_000_000 });
  });

  test("limits are configurable from the environment and fall back safely", () => {
    assert.deepEqual(resolveTopUpLimits({}), { min: 10_000, max: 50_000_000 });
    assert.deepEqual(resolveTopUpLimits({ TOPUP_MIN_TOMAN: "20000", TOPUP_MAX_TOMAN: "1000000" }), { min: 20_000, max: 1_000_000 });
    assert.deepEqual(resolveTopUpLimits({ TOPUP_MIN_TOMAN: "abc", TOPUP_MAX_TOMAN: "-5" }), { min: 10_000, max: 50_000_000 });
    assert.deepEqual(resolveTopUpLimits({ TOPUP_MIN_TOMAN: "900", TOPUP_MAX_TOMAN: "100" }), { min: 10_000, max: 50_000_000 });
  });
});

describe("crypto currency selection comes before the amount", () => {
  beforeEach(() => resetNowPaymentsConfirmLocksForTests());

  test("pay_nowpayments opens the currency list, never the amount prompt", async () => {
    const bot = botStub();
    const catalog = makeCatalog();
    await payNowPayments(bot, query("c1"), { messageId: 5 }, { catalog });
    const buttons = flat(bot);
    const callbacks = buttons.map((b) => b.callback_data);
    assert.ok(callbacks.includes("np_asset:BTC"));
    assert.ok(callbacks.includes("np_asset:USDT"));
    assert.ok(callbacks.includes("np_cancel"));
    assert.ok(callbacks.includes("back_to_topup"));
    assert.equal(callbacks.includes("np_asset:SHD"), false, "disabled provider currency must not be offered");
    assert.doesNotMatch(bot.edits.at(-1).text, /مبلغ شارژ را وارد کنید/);
    const usdt = buttons.find((b) => b.callback_data === "np_asset:USDT");
    assert.match(usdt.text, /تتر · USDT \(2 شبکه\)/);
  });

  test("labels use real tickers and fall back to the ticker without inventing names", () => {
    const catalog = makeCatalog([coin("zzz", "ZZZ", "ZZZ")]);
    const labels = Object.fromEntries(catalog.groups.map((g) => [g.ticker, currencyGroupLabel(g)]));
    assert.equal(labels.BTC, "🪙 بیت‌کوین · BTC");
    assert.equal(labels.ZZZ, "🪙 ZZZ");
  });

  test("a long currency list is paginated and the page index is clamped", () => {
    const groups = Array.from({ length: 19 }, (_, i) => ({ ticker: `C${i}` }));
    const first = paginateGroups(groups, 0);
    assert.equal(first.items.length, 8);
    assert.equal(first.pages, 3);
    assert.equal(paginateGroups(groups, 99).page, 2);
    assert.equal(paginateGroups(groups, -4).page, 0);
    assert.equal(paginateGroups(groups, "x").page, 0);
  });

  test("single-network coin goes straight to the amount prompt with its ticker", async () => {
    const bot = botStub();
    const catalog = makeCatalog();
    await handleNowPaymentsSelectAsset(bot, query("c2"), "BTC", sess(), { catalog });
    assert.match(bot.edits.at(-1).text, /مبلغ شارژ را وارد کنید/);
    assert.match(bot.edits.at(-1).text, /BTC/);
  });

  test("multi-network coin asks for the network and rejects a network of another coin", async () => {
    const bot = botStub();
    const catalog = makeCatalog();
    await handleNowPaymentsSelectAsset(bot, query("c3"), "USDT", sess(), { catalog });
    const networkSession = sess({ step: "waiting_for_nowpayments_network", nowpaymentsPendingTicker: "USDT" });
    const callbacks = flat(bot).map((b) => b.callback_data);
    assert.ok(callbacks.includes("np_net:usdttrc20"));
    assert.ok(callbacks.includes("np_net:usdterc20"));
    assert.match(bot.edits.at(-1).text, /شبکه/);

    // Forged callback: a BTC code while USDT networks are on screen.
    await handleNowPaymentsSelectNetwork(bot, query("c4"), "btc", networkSession, { catalog });
    assert.match(bot.edits.at(-1).text, /شبکه انتخاب‌شده/);

    await handleNowPaymentsSelectNetwork(bot, query("c5"), "usdterc20", networkSession, { catalog });
    assert.match(bot.edits.at(-1).text, /مبلغ شارژ را وارد کنید/);
    assert.match(bot.edits.at(-1).text, /ERC20/);
  });

  test("unknown or disabled currencies are rejected server-side", async () => {
    const bot = botStub();
    const catalog = makeCatalog();
    await handleNowPaymentsSelectAsset(bot, query("c6"), "SHD", sess(), { catalog });
    assert.match(bot.edits.at(-1).text, /در دسترس نیست/);
  });

  test("stale keyboards and foreign users cannot drive the flow", async () => {
    const catalog = makeCatalog();
    const stale = botStub();
    await handleNowPaymentsSelectAsset(stale, query("c7", 902), "BTC", {}, { catalog });
    assert.match(stale.edits.at(-1).text, /منقضی شده/);
    const wrongStep = botStub();
    await handleNowPaymentsSelectAsset(wrongStep, query("c7b", 902), "BTC", sess({ ownerId: 902, step: "waiting_for_nowpayments_payment" }), { catalog });
    assert.match(wrongStep.edits.at(-1).text, /منقضی شده/);

    const foreign = botStub();
    await handleNowPaymentsSelectAsset(foreign, query("c8", 999), "BTC", sess({ ownerId: 903 }), { catalog });
    assert.equal(foreign.edits.length, 0);
  });

  test("an amount typed before any currency is chosen asks for the currency first", async () => {
    const bot = botStub();
    let quotes = 0;
    await handleNowPaymentsAmount(bot, { chat: { id: 904 }, message_id: 1, text: "50000" }, { messageId: 5, paymentType: "nowpayments", step: "waiting_for_nowpayments_amount" }, {
      quoteTronTopUp: async () => { quotes += 1; },
    });
    assert.equal(quotes, 0);
    assert.match(bot.edits.at(-1).text, /ابتدا رمزارز/);
  });
});

describe("amount, quote, confirmation, back and cancel", () => {
  beforeEach(() => resetNowPaymentsConfirmLocksForTests());
  const asset = { payCurrency: "ltc", ticker: "LTC", network: "LTC", currencyPrecision: 8, minAmount: null };
  const fakeQuote = (input) => ({
    amountToman: input.amountToman,
    payCurrency: input.payCurrency,
    ticker: input.ticker,
    network: input.network,
    currencyPrecision: 8,
    estimatedAmount: 0.5,
    tomanPerCrypto: 4_000_000,
    quoteAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  });

  test("a valid amount is quoted for the selected coin, then confirmed via the labelled buttons", async () => {
    const bot = botStub();
    const inputs = [];
    await handleNowPaymentsAmount(
      bot,
      { chat: { id: 905 }, message_id: 1, text: "۲۰۰٬۰۰۰" },
      { messageId: 5, ownerId: 905, paymentType: "nowpayments", step: "waiting_for_nowpayments_amount", nowpaymentsAsset: asset },
      { quoteTronTopUp: async (input) => { inputs.push(input); return fakeQuote(input); } },
    );
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].payCurrency, "ltc");
    assert.equal(inputs[0].amountToman, 200_000);
    const text = bot.edits.at(-1).text;
    assert.match(text, /تأیید افزایش موجودی/);
    assert.match(text, /<code>200,000<\/code> تومان/);
    assert.match(text, /قیمت هر LTC/);
    assert.match(text, /<code>0\.5<\/code> LTC/);
    assert.match(text, /قیمت آنلاین · <code>/);
    assert.match(text, /تقریبی است/);
    const buttons = flat(bot);
    assert.deepEqual(buttons.map((b) => b.text), ["✅ تأیید و ایجاد فاکتور پرداخت", "🔙 بازگشت", "❌ لغو عملیات"]);
  });

  test("an invalid amount is rejected without quoting or leaving the step", async () => {
    const bot = botStub();
    let quotes = 0;
    await handleNowPaymentsAmount(bot, { chat: { id: 906 }, message_id: 1, text: "12.5" }, sess({ ownerId: 906, step: "waiting_for_nowpayments_amount", nowpaymentsAsset: asset }), {
      quoteTronTopUp: async () => { quotes += 1; },
    });
    assert.equal(quotes, 0);
    assert.match(bot.edits.at(-1).text, /❌/);
  });

  test("missing price data is explained and no estimate is invented", () => {
    const text = nowPaymentsConfirmMessage({ amountToman: 80_000, ticker: "BTC", network: "BTC", estimatedAmount: null, tomanPerCrypto: null });
    assert.match(text, /برآورد لحظه‌ای مبلغ رمزارز در دسترس نیست/);
    assert.match(text, /<code>80,000<\/code>/);
    assert.doesNotMatch(text, /قیمت هر/);
  });

  test("back returns to the amount prompt and cancel clears state without an invoice", async () => {
    const bot = botStub();
    const confirmSession = sess({ ownerId: 907, step: "nowpayments_confirm", nowpaymentsAsset: asset, nowpaymentsAmount: 50_000, nowpaymentsQuote: {} });
    await handleNowPaymentsBackToAmount(bot, query("c9", 907), confirmSession);
    assert.match(bot.edits.at(-1).text, /مبلغ شارژ را وارد کنید/);
    assert.match(bot.edits.at(-1).text, /LTC/);

    await handleNowPaymentsCancel(bot, query("c10", 907), confirmSession);
    assert.match(bot.edits.at(-1).text, /لغو شد/);
    assert.match(bot.edits.at(-1).text, /مبلغی از شما کسر نشده/);
    assert.ok(bot.answers.length >= 2, "every callback is answered");
  });

  test("a stale or foreign confirm press creates nothing", async () => {
    const bot = botStub();
    let created = 0;
    const create = async () => { created += 1; return {}; };
    const quote = fakeQuote({ amountToman: 50_000, ...asset });
    await confirmNowPaymentsTopUp(bot, query("c11", 999, 5), { step: "nowpayments_confirm", ownerId: 908, messageId: 5, nowpaymentsAsset: asset, nowpaymentsAmount: 50_000, nowpaymentsQuote: quote }, { createNowPaymentsTopUp: create });
    await confirmNowPaymentsTopUp(bot, query("c12", 908, 5), { step: "waiting_for_nowpayments_amount", ownerId: 908, messageId: 5, nowpaymentsAsset: asset, nowpaymentsAmount: 50_000, nowpaymentsQuote: quote }, { createNowPaymentsTopUp: create });
    assert.equal(created, 0);
  });
});

describe("customer status check", () => {
  const ORDER = "NP-11111111-1111-4111-8111-111111111111";
  const invoice = { orderId: ORDER, userId: 910, amountToman: 50_000, status: "waiting", balanceCredited: false, invoiceUrl: "https://nowpayments.io/payment/?iid=1" };
  const model = (doc) => ({
    findOne(filter) {
      const match = doc && filter.orderId === doc.orderId && filter.userId === doc.userId ? doc : null;
      return { lean: async () => match };
    },
  });

  test("owner sees the status and the pay link without creating anything", async () => {
    const bot = botStub();
    await handleNowPaymentsStatus(bot, query("s1", 910), ORDER, { invoiceModel: model(invoice) });
    assert.match(bot.edits.at(-1).text, /منتظر پرداخت/);
    const urls = flat(bot).filter((b) => b.url);
    assert.equal(urls.length, 1);
  });

  test("another user cannot read the invoice", async () => {
    const bot = botStub();
    await handleNowPaymentsStatus(bot, query("s2", 911), ORDER, { invoiceModel: model(invoice) });
    assert.equal(bot.edits.length, 0);
    assert.match(bot.answers.at(-1).options.text, /یافت نشد/);
  });

  test("malformed order ids never reach the database", async () => {
    const bot = botStub();
    let queried = false;
    await handleNowPaymentsStatus(bot, query("s3", 910), "x' || 1", { invoiceModel: { findOne() { queried = true; } } });
    assert.equal(queried, false);
  });

  test("success is only reported once the wallet credit is recorded", () => {
    assert.match(nowPaymentsStatusMessage({ ...invoice, status: "finished", balanceCredited: false }), /در حال نهایی/);
    assert.match(nowPaymentsStatusMessage({ ...invoice, status: "finished", balanceCredited: true }), /کیف پول شما شارژ شد/);
    assert.match(nowPaymentsStatusMessage({ ...invoice, status: "partially_paid" }), /کمتر از مبلغ/);
    assert.match(nowPaymentsStatusMessage({ ...invoice, status: "expired" }), /منقضی/);
    assert.doesNotMatch(nowPaymentsStatusMessage({ ...invoice, status: "confirming" }), /شارژ شد/);
  });
});
