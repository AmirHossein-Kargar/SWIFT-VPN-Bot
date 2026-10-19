import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  NOWPAYMENTS_CAPABILITY_MATRIX,
  KNOWN_PAYMENT_STATUSES,
  KNOWN_PAYOUT_STATUSES,
  KNOWN_CONVERSION_STATUSES,
} from "../../services/nowpayments/constants.js";
import {
  authenticateNowPayments,
  createNowPaymentsClient,
  createNowPaymentsRequest,
  resetNowPaymentsAuthCacheForTests,
} from "../../services/nowpayments/nowpaymentsClient.js";
import {
  buildCatalogFromProviderData,
  fetchNowPaymentsCatalog,
  resetNowPaymentsCatalogCacheForTests,
  validateCatalogSelection,
} from "../../services/nowpayments/catalog.js";
import {
  createNowPaymentsDirectPayment,
  createNowPaymentsTopUp,
  refreshNowPaymentsMerchantEstimate,
  resetNowPaymentsCreateLocksForTests,
} from "../../services/nowpayments/createInvoice.js";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { quoteCryptoPayment, resetTronQuoteCacheForTests } from "../../services/pricing/tronQuote.js";
import {
  confirmNowPaymentsTopUp,
  handleNowPaymentsAmount,
  handleNowPaymentsCurrencyMenu,
  handleNowPaymentsSelectAsset,
  handleNowPaymentsSelectNetwork,
  resetNowPaymentsConfirmLocksForTests,
} from "../../paymentHandlers/payNowPayments.js";
import {
  createCustodyPayout,
  estimateCustodyPayoutFee,
  executeCustodyConversion,
  getCustodyAssets,
  getCustodyConversions,
  getCustodyOverview,
  getCustodyPayouts,
  getCustodyTransactions,
  previewCustodyConversion,
  reconcileNowPaymentsRecords,
  setCustodyDepsForTests,
  validateCustodyPayoutAddress,
  verifyCustodyPayout,
} from "../../services/admin/custody.js";
import { resetAdminRegistryForTests } from "../../services/admin/adminRegistry.js";
import adminRouter from "../../web/adminRouter.js";

const API_KEY = "np-secret-api-key-99999";
const IPN_SECRET = "i".repeat(40);
const CUSTODY_PASSWORD = "custody-super-secret-password";
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.custodytoken";

const TEST_ENV = {
  NOWPAYMENTS_API_KEY: API_KEY,
  NOWPAYMENTS_IPN_SECRET: IPN_SECRET,
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
  NOWPAYMENTS_EMAIL: "custody@example.test",
  NOWPAYMENTS_PASSWORD: CUSTODY_PASSWORD,
  NOWPAYMENTS_CATALOG_TTL_SECONDS: "300",
};

const SAMPLE_FULL_CURRENCIES = [
  {
    id: 1,
    code: "trx",
    name: "TRON",
    enable: true,
    ticker: "trx",
    network: "trx",
    network_precision: 6,
    extra_id_exists: false,
    wallet_regex: "^T[1-9A-HJ-NP-Za-km-z]{33}$",
    min_amount: 2,
    priority: 1,
  },
  {
    id: 2,
    code: "usdttrc20",
    name: "Tether USD (Tron)",
    enable: true,
    ticker: "usdt",
    network: "trx",
    smart_contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    network_precision: 6,
    extra_id_exists: false,
    wallet_regex: "^T[1-9A-HJ-NP-Za-km-z]{33}$",
    min_amount: 1,
    priority: 2,
  },
  {
    id: 3,
    code: "usdterc20",
    name: "Tether USD (Ethereum)",
    enable: true,
    ticker: "usdt",
    network: "eth",
    smart_contract: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    network_precision: 6,
    extra_id_exists: false,
    wallet_regex: "^0x[a-fA-F0-9]{40}$",
    min_amount: 5,
    priority: 3,
  },
  {
    id: 4,
    code: "btc",
    name: "Bitcoin",
    enable: true,
    ticker: "btc",
    network: "btc",
    network_precision: 8,
    extra_id_exists: false,
    min_amount: 0.0001,
    priority: 4,
  },
  {
    id: 5,
    code: "disabledcoin",
    name: "Disabled Coin",
    enable: false,
    ticker: "dis",
    network: "dis",
    network_precision: 8,
  },
];

function makeMockProviderTransport(calls = []) {
  return async (options) => {
    calls.push(options);
    const url = options.url;
    const method = (options.method || "GET").toUpperCase();

    if (url.endsWith("/status")) {
      return { status: 200, data: { message: "OK" } };
    }
    if (url.endsWith("/auth") && method === "POST") {
      if (options.data?.email === TEST_ENV.NOWPAYMENTS_EMAIL && options.data?.password === CUSTODY_PASSWORD) {
        return { status: 200, data: { token: JWT_TOKEN } };
      }
      return { status: 401, data: { message: `Invalid password ${CUSTODY_PASSWORD}` } };
    }
    if (url.endsWith("/currencies?fixed_rate=true")) {
      return { status: 200, data: { currencies: ["trx", "usdttrc20"] } };
    }
    if (url.endsWith("/currencies")) {
      return { status: 200, data: { currencies: ["trx", "usdttrc20", "usdterc20", "btc", "disabledcoin"] } };
    }
    if (url.endsWith("/full-currencies")) {
      return { status: 200, data: { currencies: SAMPLE_FULL_CURRENCIES } };
    }
    if (url.endsWith("/merchant/coins")) {
      return { status: 200, data: { selectedCurrencies: ["trx", "usdttrc20", "usdterc20", "btc"] } };
    }
    if (url.includes("/min-amount?")) {
      const parsed = new URL(url);
      const from = parsed.searchParams.get("currency_from");
      if (from === "usdterc20") {
        return { status: 200, data: { currency_from: "usdterc20", currency_to: "usdterc20", min_amount: 10, fiat_equivalent: 10 } };
      }
      return { status: 200, data: { currency_from: from, currency_to: from, min_amount: 0.5, fiat_equivalent: 0.5 } };
    }
    if (url.includes("/estimate?")) {
      const parsed = new URL(url);
      const amount = Number(parsed.searchParams.get("amount"));
      const from = parsed.searchParams.get("currency_from");
      const to = parsed.searchParams.get("currency_to");
      const rate = to === "usdttrc20" || to === "usdterc20" ? 1 : to === "trx" ? 4 : 0.000015;
      return {
        status: 200,
        data: {
          currency_from: from,
          amount_from: amount,
          currency_to: to,
          estimated_amount: Number((amount * rate).toFixed(6)),
        },
      };
    }
    if (url.endsWith("/invoice") && method === "POST") {
      return {
        status: 200,
        data: {
          id: "INV-9001",
          order_id: options.data.order_id,
          price_amount: options.data.price_amount,
          price_currency: options.data.price_currency,
          pay_currency: options.data.pay_currency,
          invoice_url: "https://nowpayments.io/payment/?iid=INV-9001",
        },
      };
    }
    if (url.endsWith("/payment") && method === "POST") {
      return {
        status: 200,
        data: {
          payment_id: "PAY-7001",
          payment_status: "waiting",
          pay_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
          price_amount: options.data.price_amount,
          price_currency: options.data.price_currency,
          pay_amount: 12.5,
          pay_currency: options.data.pay_currency,
          order_id: options.data.order_id,
          expiration_estimate_date: "2026-10-19T12:00:00.000Z",
        },
      };
    }
    if (url.endsWith("/invoice-payment") && method === "POST") {
      return {
        status: 200,
        data: {
          payment_id: "PAY-7002",
          payment_status: "waiting",
          pay_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
          pay_amount: 8.25,
          pay_currency: options.data.pay_currency,
        },
      };
    }
    if (url.endsWith("/update-merchant-estimate") && method === "POST") {
      return {
        status: 200,
        data: {
          id: "PAY-7001",
          pay_amount: 13.125,
          expiration_estimate_date: "2026-10-19T12:30:00.000Z",
        },
      };
    }
    if (url.endsWith("/balance") && method === "GET") {
      return {
        status: 200,
        data: {
          trx: { amount: 450.25, pendingAmount: 12.5 },
          usdttrc20: { amount: 120.75, pendingAmount: 0 },
          btc: { amount: 0, pendingAmount: 0 },
        },
      };
    }
    if (url.includes("/conversion") && method === "GET") {
      return {
        status: 200,
        data: {
          result: [
            {
              id: "CONV-101",
              status: "finished",
              from_currency: "trx",
              to_currency: "usdttrc20",
              from_amount: "100",
              to_amount: "24.85",
              created_at: "2026-10-19T06:00:00.000Z",
            },
          ],
          count: 1,
        },
      };
    }
    if (url.endsWith("/conversion") && method === "POST") {
      return {
        status: 200,
        data: {
          result: {
            id: "CONV-102",
            status: "waiting",
            from_currency: options.data.from_currency,
            to_currency: options.data.to_currency,
            from_amount: options.data.amount,
            to_amount: "25.0",
            created_at: "2026-10-19T07:00:00.000Z",
          },
        },
      };
    }
    if (url.endsWith("/payout/validate-address") && method === "POST") {
      if (String(options.data?.address || "").startsWith("T")) {
        return { status: 200, data: { message: "OK" } };
      }
      return { status: 400, data: { message: "Invalid address format" } };
    }
    if (url.includes("/payout/fee?")) {
      return { status: 200, data: { currency: "trx", fee: 1.1 } };
    }
    if (url.includes("/payout") && method === "GET") {
      return {
        status: 200,
        data: {
          withdrawals: [
            {
              id: "WD-501",
              batch_withdrawal_id: "BATCH-500",
              currency: "trx",
              address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
              amount: "50",
              fee: "1.1",
              status: "waiting",
              created_at: "2026-10-19T06:30:00.000Z",
            },
          ],
        },
      };
    }
    if (url.endsWith("/payout") && method === "POST") {
      const w = options.data.withdrawals[0];
      return {
        status: 200,
        data: {
          id: "BATCH-502",
          withdrawals: [
            {
              id: "WD-502",
              batch_withdrawal_id: "BATCH-502",
              currency: w.currency,
              address: w.address,
              amount: String(w.amount),
              status: "creating",
              unique_external_id: w.unique_external_id,
              created_at: "2026-10-19T07:15:00.000Z",
            },
          ],
        },
      };
    }
    if (url.endsWith("/payout/BATCH-502/verify") && method === "POST") {
      return { status: 200, data: { status: "OK" } };
    }
    if (url.includes("/payment/PAY-RECON-1") && method === "GET") {
      return {
        status: 200,
        data: {
          payment_id: "PAY-RECON-1",
          invoice_id: "INV-RECON-1",
          order_id: "NP-11111111-2222-4333-8444-555555555555",
          payment_status: "finished",
          pay_amount: 20,
          actually_paid: 20,
          pay_currency: "trx",
        },
      };
    }
    return { status: 404, data: { message: "Not found" } };
  };
}

function makeInMemoryInvoiceModel(seed = []) {
  const docs = new Map(seed.map((d) => [d.orderId, structuredClone(d)]));
  return {
    docs,
    async find(filter = {}) {
      return [...docs.values()].filter((doc) => {
        if (filter.orderId && doc.orderId !== filter.orderId) return false;
        return true;
      });
    },
    findOne(filter = {}) {
      const found = [...docs.values()].find((doc) => {
        if (filter.orderId && doc.orderId !== filter.orderId) return false;
        if (filter.userId != null && doc.userId !== filter.userId) return false;
        if (filter.status?.$in && !filter.status.$in.includes(doc.status)) return false;
        return true;
      }) || null;
      return {
        lean: async () => (found ? structuredClone(found) : null),
        then: (resolve, reject) => Promise.resolve(found ? structuredClone(found) : null).then(resolve, reject),
      };
    },
    async create(input) {
      const doc = structuredClone(input);
      docs.set(doc.orderId, doc);
      return doc;
    },
    async updateOne(filter, update) {
      const target = [...docs.values()].find((d) => {
        if (filter.orderId && d.orderId !== filter.orderId) return false;
        if (filter.paymentId && d.paymentId !== filter.paymentId) return false;
        if (filter.status && typeof filter.status === "string" && d.status !== filter.status) return false;
        if (filter.status?.$in && !filter.status.$in.includes(d.status)) return false;
        if (filter.balanceCredited !== undefined && Boolean(d.balanceCredited) !== filter.balanceCredited) return false;
        return true;
      });
      if (!target) return { modifiedCount: 0 };
      if (update.$set) Object.assign(target, structuredClone(update.$set));
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) delete target[k];
      }
      if (update.$push?.ipnLog) {
        target.ipnLog = target.ipnLog || [];
        target.ipnLog.push(...update.$push.ipnLog.$each);
      }
      return { modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update) {
      const res = await this.updateOne(filter, update);
      if (!res.modifiedCount) return null;
      return docs.get(filter.orderId) || null;
    },
  };
}

function makeInMemoryAuditModel() {
  const records = new Map();
  return {
    records,
    async create(fields) {
      if (records.has(fields.operationId)) {
        const err = new Error("duplicate operationId");
        err.code = 11000;
        throw err;
      }
      const doc = {
        _id: `audit-${records.size + 1}`,
        ...structuredClone(fields),
        status: "started",
        result: null,
        completedAt: null,
        async save() {
          const { save: _ignore, ...plain } = this;
          records.set(this.operationId, structuredClone(plain));
        },
      };
      const { save: _ignore, ...initialPlain } = doc;
      records.set(fields.operationId, structuredClone(initialPlain));
      return doc;
    },
    async findOne({ operationId }) {
      return records.get(operationId) || null;
    },
    async updateOne({ _id }, update) {
      for (const rec of records.values()) {
        if (rec._id === _id && update.$set) {
          Object.assign(rec, update.$set);
        }
      }
    },
  };
}

describe("NOWPayments API capability matrix & dynamic catalog", () => {
  beforeEach(() => {
    resetNowPaymentsCatalogCacheForTests();
    resetNowPaymentsAuthCacheForTests();
  });

  test("capability matrix documents all required discovery, payment, and Custody endpoints", () => {
    const endpoints = NOWPAYMENTS_CAPABILITY_MATRIX.map((item) => `${item.method} ${item.endpoint}`);
    assert.equal(endpoints.includes("GET /v1/status"), true);
    assert.equal(endpoints.includes("POST /v1/auth"), true);
    assert.equal(endpoints.includes("GET /v1/currencies"), true);
    assert.equal(endpoints.includes("GET /v1/full-currencies"), true);
    assert.equal(endpoints.includes("GET /v1/merchant/coins"), true);
    assert.equal(endpoints.includes("GET /v1/min-amount"), true);
    assert.equal(endpoints.includes("GET /v1/estimate"), true);
    assert.equal(endpoints.includes("POST /v1/invoice"), true);
    assert.equal(endpoints.includes("POST /v1/payment"), true);
    assert.equal(endpoints.includes("POST /v1/invoice-payment"), true);
    assert.equal(endpoints.includes("GET /v1/payment/:payment_id"), true);
    assert.equal(endpoints.includes("POST /v1/payment/:id/update-merchant-estimate"), true);
    assert.equal(endpoints.includes("GET /v1/balance"), true);
    assert.equal(endpoints.includes("POST /v1/conversion"), true);
    assert.equal(endpoints.includes("GET /v1/conversion"), true);
    assert.equal(endpoints.includes("POST /v1/payout/validate-address"), true);
    assert.equal(endpoints.includes("GET /v1/payout/fee"), true);
    assert.equal(endpoints.includes("POST /v1/payout"), true);
    assert.equal(endpoints.includes("POST /v1/payout/:batch_withdrawal_id/verify"), true);
    assert.equal(KNOWN_PAYMENT_STATUSES.includes("partially_paid"), true);
    assert.equal(KNOWN_PAYOUT_STATUSES.includes("finished"), true);
    assert.equal(KNOWN_CONVERSION_STATUSES.includes("finished"), true);
  });

  test("fetches dynamic catalog, filters disabled coins, groups multi-network USDT, and validates selections", async () => {
    const calls = [];
    const request = createNowPaymentsRequest({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      transport: makeMockProviderTransport(calls),
    });
    const catalog = await fetchNowPaymentsCatalog({ env: TEST_ENV, request, now: () => 1_700_000_000_000 });
    assert.equal(catalog.assets.some((a) => a.code === "disabledcoin"), false);
    assert.equal(catalog.assets.length, 4);

    const usdtGroup = catalog.groups.find((g) => g.ticker === "USDT");
    assert.ok(usdtGroup);
    assert.equal(usdtGroup.requiresNetworkSelection, true);
    assert.equal(usdtGroup.networks.length, 2);

    const trxGroup = catalog.groups.find((g) => g.ticker === "TRX");
    assert.ok(trxGroup);
    assert.equal(trxGroup.requiresNetworkSelection, false);

    // Selecting USDT without specifying network fails closed with network_selection_required
    assert.throws(
      () => validateCatalogSelection(catalog, { ticker: "USDT" }),
      (err) => err.code === "network_selection_required",
    );

    // Selecting USDT on TRX network resolves usdttrc20
    const usdtTrc20 = validateCatalogSelection(catalog, { ticker: "USDT", network: "TRX" });
    assert.equal(usdtTrc20.code, "usdttrc20");
    assert.equal(usdtTrc20.fixedRateSupported, true);

    // Selecting mismatched network for usdttrc20 fails closed
    assert.throws(
      () => validateCatalogSelection(catalog, { payCurrency: "usdttrc20", network: "ETH" }),
      (err) => err.code === "invalid_network_selection",
    );
  });
});

describe("Dynamic pricing with Gheymat Online, min-amount enforcement, and immutable quote snapshot", () => {
  beforeEach(() => {
    resetNowPaymentsCatalogCacheForTests();
    resetTronQuoteCacheForTests();
    resetNowPaymentsCreateLocksForTests();
  });

  test("quotes a customer VPN plan in USDT-TRC20 using Gheymat Toman rate and enforces min-amount", async () => {
    const calls = [];
    const request = createNowPaymentsRequest({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      transport: makeMockProviderTransport(calls),
    });

    const quote = await quoteCryptoPayment({
      planSelection: { durationDays: 90, gig: 100 }, // 164,000 Toman in catalog
      ticker: "USDT",
      network: "TRX",
      env: TEST_ENV,
      now: new Date("2026-10-19T08:00:00.000Z"),
      usdtQuote: async () => ({
        unit: "toman",
        tomanPerUsdt: 82_000,
        createdAt: "2026-10-19T07:59:00.000Z",
        source: "gheymat",
      }),
      request,
    });

    assert.equal(quote.amountToman, 164_000);
    assert.equal(quote.planId, "s90_100");
    assert.equal(quote.priceAmountCents, 200); // $2.00
    assert.equal(quote.payCurrency, "usdttrc20");
    assert.equal(quote.ticker, "USDT");
    assert.equal(quote.network, "TRX");
    assert.equal(quote.estimatedAmount, 2);
    assert.equal(quote.quoteSnapshot.gheymatQuote.unit, "toman");
    assert.equal(quote.quoteSnapshot.gheymatQuote.value, 82_000);
    assert.equal(quote.quoteSnapshot.selectedAsset.payCurrency, "usdttrc20");

    // Below minimum amount on USDTERC20 (min_amount = $10) fails closed
    await assert.rejects(
      () => quoteCryptoPayment({
        planSelection: { durationDays: 90, gig: 100 }, // $2.00 < $10.00 min
        ticker: "USDT",
        network: "ETH",
        env: TEST_ENV,
        now: new Date("2026-10-19T08:00:00.000Z"),
        usdtQuote: async () => ({
          unit: "toman",
          tomanPerUsdt: 82_000,
          createdAt: "2026-10-19T07:59:00.000Z",
          source: "gheymat",
        }),
        request,
      }),
      (err) => err.code === "below_min_amount",
    );

    // Creating the invoice persists the immutable quoteSnapshot and selected asset/network
    const invoiceModel = makeInMemoryInvoiceModel();
    const invoice = await createNowPaymentsTopUp({
      userId: 9001,
      amountToman: quote.amountToman,
      payCurrency: quote.payCurrency,
      ticker: quote.ticker,
      network: quote.network,
      currencyPrecision: quote.currencyPrecision,
      planId: quote.planId,
      quote,
      env: TEST_ENV,
      invoiceModel,
      request,
      resolveRate: async () => ({ tomanPerFiat: quote.tomanPerUsdt, source: "gheymat" }),
    });

    assert.equal(invoice.payCurrency, "usdttrc20");
    assert.equal(invoice.ticker, "USDT");
    assert.equal(invoice.network, "TRX");
    const saved = invoiceModel.docs.get(invoice.orderId);
    assert.equal(saved.payCurrency, "usdttrc20");
    assert.equal(saved.planId, "s90_100");
    assert.equal(saved.quoteSnapshot.invoiceId, "INV-9001");
    assert.equal(saved.quoteSnapshot.selectedAsset.payCurrency, "usdttrc20");
  });

  test("supports direct payment creation, invoice-payment binding, and merchant estimate refresh", async () => {
    const calls = [];
    const request = createNowPaymentsRequest({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      transport: makeMockProviderTransport(calls),
    });
    const invoiceModel = makeInMemoryInvoiceModel([
      {
        orderId: "NP-00000000-1111-4222-8333-444444444444",
        userId: 9002,
        amountToman: 100_000,
        priceAmountCents: 200,
        priceCurrency: "usd",
        payCurrency: "trx",
        status: "pending",
        balanceCredited: false,
      },
    ]);

    const direct = await createNowPaymentsDirectPayment({
      orderId: "NP-00000000-1111-4222-8333-444444444444",
      priceAmountCents: 200,
      payCurrency: "trx",
      env: TEST_ENV,
      invoiceModel,
      request,
    });
    assert.equal(direct.paymentId, "PAY-7001");
    assert.equal(direct.payAddress, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");

    const refreshed = await refreshNowPaymentsMerchantEstimate({
      paymentId: "PAY-7001",
      env: TEST_ENV,
      invoiceModel,
      request,
    });
    assert.equal(refreshed.payAmount, 13.125);
    assert.equal(invoiceModel.docs.get("NP-00000000-1111-4222-8333-444444444444").payAmount, 13.125);

    const bound = await createNowPaymentsDirectPayment({
      orderId: "NP-00000000-1111-4222-8333-444444444444",
      invoiceId: "INV-9001",
      payCurrency: "trx",
      env: TEST_ENV,
      invoiceModel,
      request,
    });
    assert.equal(bound.paymentId, "PAY-7002");
  });
});

describe("Telegram dynamic currency & network selection flow", () => {
  test("selecting a multi-network asset prompts for network and invalidates stale quotes on change", async () => {
    resetNowPaymentsCatalogCacheForTests();
    resetNowPaymentsConfirmLocksForTests();
    const request = createNowPaymentsRequest({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      transport: makeMockProviderTransport(),
    });
    const catalog = await fetchNowPaymentsCatalog({ env: TEST_ENV, request });

    const edits = [];
    const bot = {
      edits,
      async editMessageText(text, options) { edits.push({ text, options }); },
      async deleteMessage() {},
      async answerCallbackQuery() {},
    };

    await handleNowPaymentsCurrencyMenu(
      bot,
      { id: "cb1", from: { id: 501 }, message: { chat: { id: 501 }, message_id: 10 } },
      { messageId: 10, ownerId: 501, paymentType: "nowpayments", step: "waiting_for_nowpayments_currency" },
      { catalog },
    );
    const currencyButtons = edits.at(-1).options.reply_markup.inline_keyboard.flat();
    assert.equal(currencyButtons.some((b) => b.callback_data === "np_asset:USDT"), true);

    // Selecting USDT shows network picker (TRX and ETH)
    await handleNowPaymentsSelectAsset(
      bot,
      { id: "cb2", from: { id: 501 }, message: { chat: { id: 501 }, message_id: 10 } },
      "USDT",
      { messageId: 10, ownerId: 501, paymentType: "nowpayments", step: "waiting_for_nowpayments_currency" },
      { catalog },
    );
    const netButtons = edits.at(-1).options.reply_markup.inline_keyboard.flat();
    assert.equal(netButtons.some((b) => b.callback_data === "np_net:usdttrc20"), true);
    assert.equal(netButtons.some((b) => b.callback_data === "np_net:usdterc20"), true);

    // Selecting usdttrc20 when an amount is already in session recalculates the quote for USDT-TRC20
    await handleNowPaymentsSelectNetwork(
      bot,
      { id: "cb3", from: { id: 501 }, message: { chat: { id: 501 }, message_id: 10 } },
      "usdttrc20",
      {
        messageId: 10,
        ownerId: 501,
        paymentType: "nowpayments",
        step: "waiting_for_nowpayments_network",
        nowpaymentsPendingTicker: "USDT",
        nowpaymentsAmount: 100_000,
      },
      {
        catalog,
        quoteTronTopUp: async (input) => ({
          amountToman: input.amountToman,
          tomanPerUsdt: 50_000,
          payCurrency: input.payCurrency,
          ticker: input.ticker,
          network: input.network,
          estimatedAmount: 2,
          estimatedTrx: 2,
          tomanPerCrypto: 50_000,
          tomanPerTrx: 50_000,
          quoteAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        }),
      },
    );
    assert.match(edits.at(-1).text, /USDT/);
    assert.match(edits.at(-1).text, /TRX/);
  });
});

describe("Payment state machine underpayment and overpayment handling", () => {
  test("flags partially_paid underpayments for manual recovery without crediting wallet, and records overpayments", async () => {
    const orderId = "NP-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const invoiceModel = makeInMemoryInvoiceModel([
      {
        orderId,
        userId: 8080,
        amountToman: 100_000,
        priceAmountCents: 200,
        priceCurrency: "usd",
        payCurrency: "usdttrc20",
        invoiceId: "INV-1",
        status: "waiting",
        balanceCredited: false,
      },
    ]);

    let walletCredits = 0;
    const partialRes = await applyNowPaymentsUpdate({
      payload: {
        order_id: orderId,
        payment_id: "PAY-1",
        invoice_id: "INV-1",
        payment_status: "partially_paid",
        price_amount: 2,
        price_currency: "usd",
        pay_currency: "usdttrc20",
        pay_amount: 2,
        actually_paid: 1.25,
      },
      invoiceModel,
      creditWallet: async () => { walletCredits += 1; return { credited: true, user: { balance: 100_000 } }; },
    });

    assert.equal(partialRes.credited, false);
    assert.equal(walletCredits, 0);
    const afterPartial = invoiceModel.docs.get(orderId);
    assert.equal(afterPartial.status, "partially_paid");
    assert.equal(afterPartial.underpaidAmount, 0.75);
    assert.equal(afterPartial.recoveryStatus, "required");
    assert.equal(afterPartial.recoveryReason, "partially_paid_underpayment");

    // Subsequent finished IPN with slight overpayment credits wallet once and records overpaidAmount
    const finishedRes = await applyNowPaymentsUpdate({
      payload: {
        order_id: orderId,
        payment_id: "PAY-1",
        invoice_id: "INV-1",
        payment_status: "finished",
        price_amount: 2,
        price_currency: "usd",
        pay_currency: "usdttrc20",
        pay_amount: 2,
        actually_paid: 2.15,
      },
      invoiceModel,
      creditWallet: async () => { walletCredits += 1; return { credited: true, alreadyCredited: false, user: { balance: 100_000 } }; },
    });

    assert.equal(finishedRes.credited, true);
    assert.equal(walletCredits, 1);
    const afterFinished = invoiceModel.docs.get(orderId);
    assert.equal(afterFinished.balanceCredited, true);
    assert.equal(afterFinished.overpaidAmount, 0.15);
  });
});

describe("Custody service, RBAC, CSRF, idempotency, and secret redaction", () => {
  beforeEach(() => {
    process.env.ADMINS = "1001,1002";
    process.env.OWNER_TELEGRAM_ID = "1001";
    resetAdminRegistryForTests();
    resetNowPaymentsCatalogCacheForTests();
    resetNowPaymentsAuthCacheForTests();
  });

  test("redacts API keys and passwords on authentication or provider errors", async () => {
    const request = createNowPaymentsRequest({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      transport: makeMockProviderTransport(),
      extraSecrets: [CUSTODY_PASSWORD],
    });
    await assert.rejects(
      () => authenticateNowPayments({
        email: TEST_ENV.NOWPAYMENTS_EMAIL,
        password: "wrong-password",
        request,
      }),
      (err) => !err.message.includes(CUSTODY_PASSWORD) && !err.message.includes(API_KEY),
    );
  });

  test("enforces owner-only RBAC and operationId idempotency on Custody conversions and payouts", async () => {
    const calls = [];
    const client = createNowPaymentsClient({
      apiKey: API_KEY,
      baseURL: "https://api.nowpayments.io/v1",
      email: TEST_ENV.NOWPAYMENTS_EMAIL,
      password: CUSTODY_PASSWORD,
      transport: makeMockProviderTransport(calls),
    });
    const auditModel = makeInMemoryAuditModel();
    const invoiceModel = makeInMemoryInvoiceModel([
      {
        orderId: "NP-11111111-2222-4333-8444-555555555555",
        userId: 777,
        amountToman: 250_000,
        priceAmountCents: 500,
        priceCurrency: "usd",
        payCurrency: "trx",
        paymentId: "PAY-RECON-1",
        invoiceId: "INV-RECON-1",
        status: "waiting",
        balanceCredited: false,
      },
    ]);

    // Secondary admin (1002) can read overview, assets, conversions, payouts, and run read-only reconciliation
    const overview = await getCustodyOverview({ actorId: "1002", env: TEST_ENV, client, invoiceModel });
    assert.equal(overview.capabilities.isOwner, false);
    assert.equal(overview.capabilities.balanceEnabled, true);
    assert.equal(overview.balances.length, 2); // non-zero trx and usdttrc20

    const assets = await getCustodyAssets({ actorId: "1002", query: { filter: "with-balance" }, env: TEST_ENV, client });
    assert.equal(assets.items.length, 2);

    const preview = await previewCustodyConversion({
      actorId: "1002",
      fromCurrency: "trx",
      toCurrency: "usdttrc20",
      amount: 100,
      env: TEST_ENV,
      client,
    });
    assert.equal(preview.estimatedToAmount, 100);

    // Secondary admin (1002) is blocked from executing conversions or withdrawals
    await assert.rejects(
      () => executeCustodyConversion({
        actorId: "1002",
        operationId: "op-conv-non-owner-123456",
        fromCurrency: "trx",
        toCurrency: "usdttrc20",
        amount: 50,
        reason: "Attempt by non-owner",
        env: TEST_ENV,
        client,
        auditModel,
      }),
      (err) => err.code === "owner_only" && err.status === 403,
    );

    await assert.rejects(
      () => createCustodyPayout({
        actorId: "1002",
        operationId: "op-payout-non-owner-123456",
        currency: "trx",
        address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        amount: 20,
        reason: "Attempt by non-owner",
        env: TEST_ENV,
        client,
        auditModel,
      }),
      (err) => err.code === "owner_only" && err.status === 403,
    );

    // Owner (1001) can execute conversion and duplicate operationId does not call provider twice
    const convResult = await executeCustodyConversion({
      actorId: "1001",
      operationId: "op-conv-owner-00000001",
      fromCurrency: "trx",
      toCurrency: "usdttrc20",
      amount: 100,
      reason: "Rebalance TRX into USDT-TRC20",
      env: TEST_ENV,
      client,
      auditModel,
    });
    assert.equal(convResult.id, "CONV-102");
    const convPostsBefore = calls.filter((c) => c.url.endsWith("/conversion") && c.method === "POST").length;
    assert.equal(convPostsBefore, 1);

    // Replaying the same operationId returns cached audit result without a second POST
    await executeCustodyConversion({
      actorId: "1001",
      operationId: "op-conv-owner-00000001",
      fromCurrency: "trx",
      toCurrency: "usdttrc20",
      amount: 100,
      reason: "Rebalance TRX into USDT-TRC20",
      env: TEST_ENV,
      client,
      auditModel,
    });
    const convPostsAfter = calls.filter((c) => c.url.endsWith("/conversion") && c.method === "POST").length;
    assert.equal(convPostsAfter, 1);

    // Owner (1001) validates address, estimates fee, creates payout, and verifies 2FA
    const addrCheck = await validateCustodyPayoutAddress({
      actorId: "1001",
      currency: "trx",
      address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      env: TEST_ENV,
      client,
    });
    assert.equal(addrCheck.valid, true);

    const feeEst = await estimateCustodyPayoutFee({
      actorId: "1001",
      currency: "trx",
      amount: 50,
      env: TEST_ENV,
      client,
    });
    assert.equal(feeEst.fee, 1.1);

    const payout = await createCustodyPayout({
      actorId: "1001",
      operationId: "op-payout-owner-00000001",
      currency: "trx",
      address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      amount: 50,
      reason: "Treasury withdrawal to cold wallet",
      env: TEST_ENV,
      client,
      auditModel,
    });
    assert.equal(payout.id, "WD-502");
    assert.equal(payout.batchWithdrawalId, "BATCH-502");

    const verified = await verifyCustodyPayout({
      actorId: "1001",
      operationId: "op-verify-owner-00000001",
      batchWithdrawalId: "BATCH-502",
      verificationCode: "654321",
      reason: "Confirm 2FA code for BATCH-502",
      env: TEST_ENV,
      client,
      auditModel,
    });
    assert.equal(verified.verified, true);

    // Read-only reconciliation detects uncredited finished payment without mutating balanceCredited
    const recon = await reconcileNowPaymentsRecords({
      actorId: "1002",
      env: TEST_ENV,
      client,
      invoiceModel,
    });
    assert.equal(recon.discrepancyCount, 1);
    assert.equal(recon.findings[0].classification, "uncredited_finished");
    assert.equal(invoiceModel.docs.get("NP-11111111-2222-4333-8444-555555555555").balanceCredited, false);

    const txList = await getCustodyTransactions({ actorId: "1002", invoiceModel });
    assert.equal(txList.total, 1);

    const convList = await getCustodyConversions({ actorId: "1002", env: TEST_ENV, client });
    assert.equal(convList.total, 1);

    const payoutList = await getCustodyPayouts({ actorId: "1002", env: TEST_ENV, client });
    assert.equal(payoutList.total, 1);
  });

  test("admin router rejects unauthenticated requests to /api/admin/custody/*", async () => {
    setCustodyDepsForTests({});
    const app = express();
    app.use("/api/admin", adminRouter);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/custody/overview`);
      assert.equal(res.status, 401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
