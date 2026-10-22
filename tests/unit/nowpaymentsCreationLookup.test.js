import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { lookupCreationUnknown, recoverCreationUnknownOrders } from "../../services/nowpayments/creationLookup.js";
import { recoverNowPaymentsInvoices } from "../../services/nowpayments/recovery.js";
import { applyNowPaymentsUpdate } from "../../services/nowpayments/applyStatus.js";
import { createNowPaymentsClient, resetNowPaymentsAuthCacheForTests } from "../../services/nowpayments/nowpaymentsClient.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../../services/nowpayments/createInvoice.js";
import { buildCatalogFromProviderData } from "../../services/nowpayments/catalog.js";
import { makeFakeInvoiceModel } from "../helpers/fakeNowPaymentsInvoiceModel.js";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

const ORDER = "NP-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_ORDER = "NP-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 60 * 60_000);
const ENV = {
  NOWPAYMENTS_API_KEY: "k".repeat(24),
  NOWPAYMENTS_IPN_SECRET: "s".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};
const SECRET_EMAIL = "owner@example.test";
const SECRET_PASSWORD = "unit-test-password-0001";

const parked = (overrides = {}) => ({
  orderId: ORDER, userId: 9700, amountToman: 50_000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "trx",
  ticker: "TRX", network: "TRX", invoiceId: "6300", paymentId: null, payAmount: null, status: "creation_unknown",
  openCreateKey: "user:9700", recoveryStatus: "required", recoveryReason: "provider_creation_outcome_unknown",
  nextRetryAt: PAST, balanceCredited: false, createdAt: PAST, updatedAt: PAST, ...overrides,
});
/** A payment as GET /v1/payment/ documents it: numeric ids, one entry per payment. */
const payment = (overrides = {}) => ({
  payment_id: 7300, invoice_id: 6300, order_id: ORDER, payment_status: "finished", price_amount: 1, price_currency: "usd",
  pay_amount: 30, actually_paid: 30, pay_currency: "trx", created_at: "2026-10-23T11:00:00.000Z", ...overrides,
});

function provider({ payments = [], auth = 200, list = 200, throws = false, malformed = false } = {}) {
  const calls = [];
  const request = async (options) => {
    calls.push({ method: options.method, path: options.path, bearer: Boolean(options.bearerToken), apiKey: options.includeApiKey !== false });
    if (options.path === "/auth") return auth === 200 ? { status: 200, data: { token: "jwt-for-tests" } } : { status: auth, data: {} };
    if (options.path.startsWith("/payment/")) {
      if (throws) throw Object.assign(new Error("timeout"), { code: "transport", status: undefined, ambiguous: true });
      if (list !== 200) return { status: list, data: {} };
      if (malformed) return { status: 200, data: { unexpected: true } };
      const query = new URL(`https://x${options.path}`).searchParams;
      const limit = Number(query.get("limit"));
      const page = Number(query.get("page"));
      const rows = query.get("invoiceId") ? payments.filter((p) => String(p.invoice_id) === query.get("invoiceId")) : payments;
      return { status: 200, data: { data: rows.slice(page * limit, (page + 1) * limit) } };
    }
    return { status: 404, data: {} };
  };
  return { request, calls };
}
const clientFor = (p) => createNowPaymentsClient({ apiKey: ENV.NOWPAYMENTS_API_KEY, email: SECRET_EMAIL, password: SECRET_PASSWORD, request: p.request, now: () => NOW.getTime(), readRetries: 0 });
const world = (rowOverrides = {}, payments = [], providerOptions = {}) => {
  const model = makeFakeInvoiceModel([parked(rowOverrides)]);
  const users = makeFakeWalletModels([{ telegramId: "9700", balance: 10 }]);
  const p = provider({ payments, ...providerOptions });
  const notified = [];
  const run = (extra = {}) => recoverCreationUnknownOrders({
    invoiceModel: model, client: clientFor(p), now: NOW, notify: async (orderId) => { notified.push(orderId); return true; },
    apply: (args) => applyNowPaymentsUpdate({ ...args, userModel: users.userModel }), ...extra,
  });
  return { model, users, p, run, notified, row: () => model.docs.get(ORDER), balance: () => users.users.get("9700").balance };
};
beforeEach(() => resetNowPaymentsAuthCacheForTests());

describe("a provider payment found for a parked order is settled through the normal verifier", () => {
  test("one finished payment credits exactly once, releases the lock key and notifies", async () => {
    const w = world({}, [payment()]);
    const summary = await w.run();
    assert.equal(summary.credited, 1);
    assert.equal(w.balance(), 50_010);
    assert.equal(w.row().status, "finished");
    assert.equal(w.row().balanceCredited, true);
    assert.equal(w.row().paymentId, "7300");
    assert.equal(w.row().openCreateKey, undefined);
    assert.deepEqual(w.notified, [ORDER]);
    const again = await w.run();
    assert.equal(again.checked, 0);
    assert.equal(w.balance(), 50_010);
  });

  test("the lookup is authenticated and filtered by the known invoice id", async () => {
    const w = world({}, [payment({ payment_status: "waiting", actually_paid: 0 })]);
    await w.run();
    const auth = w.p.calls.find((c) => c.path === "/auth");
    const list = w.p.calls.find((c) => c.path.startsWith("/payment/"));
    assert.equal(auth.method, "POST");
    assert.equal(list.method, "GET");
    assert.equal(list.bearer, true);
    assert.equal(list.apiKey, true);
    assert.equal(new URL(`https://x${list.path}`).searchParams.get("invoiceId"), "6300");
  });

  test("an unpaid (waiting) payment binds the ids and frees the create-lock without crediting", async () => {
    const w = world({}, [payment({ payment_status: "waiting", actually_paid: 0 })]);
    await w.run();
    assert.equal(w.row().status, "waiting");
    assert.equal(w.row().paymentId, "7300");
    assert.equal(w.row().openCreateKey, undefined);
    assert.equal(w.balance(), 10);
    // the one-open-create-per-user guard no longer sees this user as blocked
    const found = await w.model.findOne({ userId: 9700, status: { $in: ["creating", "creation_unknown"] } }).lean();
    assert.equal(found, null);
  });

  test("an order with no recorded invoice id is found by order_id in a dated window", async () => {
    const w = world({ invoiceId: undefined }, [payment({ invoice_id: 6999 }), payment({ payment_id: 1, order_id: OTHER_ORDER, invoice_id: 1 })]);
    const summary = await w.run();
    const list = w.p.calls.find((c) => c.path.startsWith("/payment/"));
    const query = new URL(`https://x${list.path}`).searchParams;
    assert.equal(query.has("invoiceId"), false);
    assert.ok(query.get("dateFrom") && query.get("dateTo"));
    assert.equal(summary.credited, 1);
    assert.equal(w.row().invoiceId, "6999");
    assert.equal(w.balance(), 50_010);
  });

  test("concurrent cycles and a duplicate IPN still credit once", async () => {
    const w = world({}, [payment()]);
    await Promise.all([w.run(), w.run(), w.run()]);
    const ipn = { ...payment(), payment_id: "7300", invoice_id: "6300" };
    await Promise.all([1, 2, 3].map(() => applyNowPaymentsUpdate({ payload: ipn, invoiceModel: w.model, userModel: w.users.userModel })));
    assert.equal(w.balance(), 50_010);
    assert.deepEqual(w.users.users.get("9700").appliedPaymentKeys, [`nowpayments:${ORDER}`]);
  });
});

describe("inconclusive or hostile provider data never settles or releases anything", () => {
  const untouched = (w) => {
    assert.equal(w.row().status, "creation_unknown");
    assert.equal(w.row().balanceCredited, false);
    assert.equal(w.row().openCreateKey, "user:9700");
    assert.equal(w.balance(), 10);
  };

  test("provider unavailable (auth, HTTP error, timeout, malformed body) keeps everything locked and backs off", async () => {
    for (const options of [{ auth: 401 }, { list: 500 }, { list: 403 }, { throws: true }, { malformed: true }]) {
      resetNowPaymentsAuthCacheForTests();
      const w = world({}, [payment()], options);
      const summary = await w.run();
      assert.equal(summary.unavailable, 1, JSON.stringify(options));
      untouched(w);
      assert.equal(w.row().retryCount, 1);
      assert.ok(new Date(w.row().nextRetryAt) > NOW, "backs off");
      assert.ok(w.row().lastErrorCode);
      assert.equal((await w.run()).checked, 0, "not asked again before the back-off");
    }
  });

  test("no payment found is reported but does not release the lock", async () => {
    const w = world({}, []);
    const summary = await w.run();
    assert.equal(summary.notFound, 1);
    untouched(w);
    assert.equal(w.row().lastErrorCode, "no_payment_found");
  });

  test("a payment for this invoice under another order id, or this order under another invoice, is a mismatch for a human", async () => {
    for (const item of [payment({ order_id: OTHER_ORDER }), payment({ invoice_id: 6301 })]) {
      resetNowPaymentsAuthCacheForTests();
      const w = world({}, [item], {});
      // the second case is invisible to the invoiceId filter, so serve it unfiltered
      const direct = await lookupCreationUnknown({ invoice: w.row(), client: clientFor({ request: async (o) => (o.path === "/auth" ? { status: 200, data: { token: "t" } } : { status: 200, data: { data: [item] } }) }), invoiceModel: w.model, now: NOW });
      assert.equal(direct.outcome, "lookup_mismatch");
      assert.equal(direct.credited, false);
      untouched(w);
    }
  });

  test("a payment whose amount or currency disagrees is refused by the verifier and flagged", async () => {
    const cases = [
      [payment({ price_amount: 5 }), "amount_mismatch"],
      [payment({ price_currency: "eur" }), "currency_mismatch"],
      [payment({ pay_currency: "btc" }), "pay_currency_mismatch"],
      [payment({ actually_paid: 1 }), "crypto_amount_mismatch"],
    ];
    for (const [item, reason] of cases) {
      resetNowPaymentsAuthCacheForTests();
      const w = world({}, [item]);
      await w.run();
      assert.equal(w.balance(), 10, reason);
      assert.equal(w.row().balanceCredited, false, reason);
      assert.equal(w.row().status, "creation_unknown", reason);
      assert.equal(w.row().openCreateKey, "user:9700", reason);
      assert.equal(w.row().recoveryStatus, "required", reason);
      assert.equal(w.row().recoveryReason, reason);
    }
  });

  test("more than one payment, or more pages than we read, is ambiguous and applies nothing", async () => {
    const two = world({}, [payment(), payment({ payment_id: 7301 })]);
    assert.equal((await two.run()).ambiguous, 1);
    untouched(two);
    assert.match(two.row().recoveryReason, /provider_lookup_ambiguous:multiple_payments/);

  });

  test("several payments carrying this invoice id under another order id are a mismatch, even across pages", async () => {
    const w = world({}, Array.from({ length: 4 }, (_, i) => payment({ payment_id: 8000 + i, order_id: OTHER_ORDER, invoice_id: 6300 })));
    const out = await lookupCreationUnknown({ invoice: w.row(), client: clientFor(w.p), invoiceModel: w.model, now: NOW, pageSize: 2, maxPages: 2 });
    assert.equal(out.outcome, "lookup_mismatch");
    assert.equal(w.balance(), 10);
  });

  test("a full last page with nothing for this order is truncated, not 'not found'", async () => {
    const filler = Array.from({ length: 4 }, (_, i) => payment({ payment_id: 8100 + i, order_id: OTHER_ORDER, invoice_id: 5000 + i }));
    const w = world({ invoiceId: undefined }, filler);
    const out = await lookupCreationUnknown({ invoice: w.row(), client: clientFor(w.p), invoiceModel: w.model, now: NOW, pageSize: 2, maxPages: 2 });
    assert.equal(out.outcome, "lookup_ambiguous");
    assert.equal(out.code, "result_truncated");
  });

  test("a verifier crash is contained: nothing credited, order untouched, retried later", async () => {
    const w = world({}, [payment()]);
    const summary = await w.run({ apply: async () => { throw new Error("mongo down"); } });
    assert.equal(summary.unavailable, 1);
    untouched(w);
  });

  test("without the JWT credentials the step does nothing", async () => {
    const w = world({}, [payment()]);
    const out = await recoverCreationUnknownOrders({ invoiceModel: w.model, env: ENV, now: NOW });
    assert.equal(out.skipped, "lookup_not_configured");
    assert.equal(w.p.calls.length, 0);
    untouched(w);
  });

  test("only unresolved orders are examined: paid, payment-bound and not-yet-due rows are skipped", async () => {
    const model = makeFakeInvoiceModel([
      parked({ orderId: "NP-11111111-1111-4111-8111-111111111111", paymentId: "5" }),
      parked({ orderId: "NP-22222222-2222-4222-8222-222222222222", balanceCredited: true }),
      parked({ orderId: "NP-33333333-3333-4333-8333-333333333333", nextRetryAt: new Date(NOW.getTime() + 60_000) }),
      parked({ orderId: "NP-44444444-4444-4444-8444-444444444444", status: "pending" }),
    ]);
    const p = provider({ payments: [] });
    const out = await recoverCreationUnknownOrders({ invoiceModel: model, client: clientFor(p), now: NOW });
    assert.equal(out.checked, 0);
    assert.equal(p.calls.length, 0);
  });
});

describe("provider matching never trusts order_id to be returned", () => {
  const untouched = (w) => {
    assert.equal(w.row().status, "creation_unknown");
    assert.equal(w.row().balanceCredited, false);
    assert.equal(w.row().openCreateKey, "user:9700");
    assert.equal(w.balance(), 10);
  };

  test("a payment for our invoice id whose order_id is null or absent is never settled and never lets the lock go", async () => {
    for (const orderId of [null, undefined, ""]) {
      resetNowPaymentsAuthCacheForTests();
      const item = payment({ order_id: orderId });
      if (orderId === undefined) delete item.order_id;
      const w = world({}, [item]);
      const summary = await w.run();
      assert.equal(summary.unconfirmed, 1, String(orderId));
      assert.equal(summary.credited, 0);
      untouched(w);
      assert.equal(w.row().recoveryStatus, "required");
      assert.match(w.row().recoveryReason, /^provider_lookup_unconfirmed:order_id_not_returned:pay=7300$/);
      assert.equal(w.row().paymentId, null, "nothing was bound");
    }
  });

  test("only an explicit order_id equal to ours, together with our invoice id, is accepted for settlement", async () => {
    const w = world({}, [payment({ order_id: ORDER })]);
    assert.equal((await w.run()).credited, 1);
  });

  test("with no recorded invoice id, a payment without an invoice_id cannot be bound and is held", async () => {
    const w = world({ invoiceId: undefined }, [payment({ invoice_id: null })]);
    const summary = await w.run();
    assert.equal(summary.unconfirmed, 1);
    untouched(w);
  });

  test("with no recorded invoice id, an empty result is NOT conclusive: absence cannot be established from order_id", async () => {
    const w = world({ invoiceId: undefined }, []);
    const out = await lookupCreationUnknown({ invoice: w.row(), client: clientFor(w.p), invoiceModel: w.model, now: NOW });
    assert.equal(out.outcome, "no_payment_found");
    assert.equal(out.conclusive, false);
    await w.run();
    assert.equal(w.row().lastErrorCode, "no_payment_found_unverifiable");
    untouched(w);
  });

  test("with a recorded invoice id, an empty result is conclusive for that invoice only", async () => {
    const w = world({}, []);
    const out = await lookupCreationUnknown({ invoice: w.row(), client: clientFor(w.p), invoiceModel: w.model, now: NOW });
    assert.deepEqual([out.outcome, out.conclusive], ["no_payment_found", true]);
  });

  test("a provider that ignores the page parameter is ambiguous, never 'complete'", async () => {
    const same = Array.from({ length: 2 }, (_, i) => payment({ payment_id: 9000 + i, order_id: OTHER_ORDER, invoice_id: 5000 + i }));
    const request = async (o) => {
      if (o.path === "/auth") return { status: 200, data: { token: "t" } };
      return { status: 200, data: { data: same } }; // every page is the same two rows
    };
    const w = world({ invoiceId: undefined }, []);
    const out = await lookupCreationUnknown({ invoice: w.row(), client: clientFor({ request }), invoiceModel: w.model, now: NOW, pageSize: 2, maxPages: 3 });
    assert.equal(out.outcome, "lookup_ambiguous");
    assert.equal(out.code, "pagination_not_advancing");
  });

  test("no outcome other than an explicit human release can free the lock: none of these ever changes status or lock", async () => {
    const scenarios = [
      [{}, []],
      [{ invoiceId: undefined }, []],
      [{}, [payment({ order_id: null })]],
      [{}, [payment(), payment({ payment_id: 7301 })]],
      [{}, [payment({ order_id: OTHER_ORDER })]],
    ];
    for (const [row, items] of scenarios) {
      resetNowPaymentsAuthCacheForTests();
      const w = world(row, items);
      await w.run();
      await w.run({ now: new Date(NOW.getTime() + 11 * 60_000) });
      untouched(w);
    }
    for (const options of [{ auth: 401 }, { list: 500 }, { throws: true }, { malformed: true }]) {
      resetNowPaymentsAuthCacheForTests();
      const w = world({}, [payment()], options);
      await w.run();
      untouched(w);
    }
  });
});

describe("the recovery cycle runs the lookup only when it is configured", () => {
  test("recoverNowPaymentsInvoices includes the creation lookup when JWT credentials exist", async () => {
    const w = world({}, [payment()]);
    const env = { ...ENV, NOWPAYMENTS_EMAIL: SECRET_EMAIL, NOWPAYMENTS_PASSWORD: SECRET_PASSWORD };
    const out = await recoverNowPaymentsInvoices({
      invoiceModel: w.model, env, now: NOW, request: w.p.request, notify: async () => true,
      apply: (args) => applyNowPaymentsUpdate({ ...args, userModel: w.users.userModel }),
    });
    assert.equal(out.creationLookup.credited, 1);
    assert.equal(w.balance(), 50_010);
    const logged = JSON.stringify(out);
    assert.equal(logged.includes(SECRET_PASSWORD) || logged.includes(SECRET_EMAIL), false);
  });

  test("without credentials the cycle result has no lookup section and the order stays locked", async () => {
    const w = world({}, [payment()]);
    const out = await recoverNowPaymentsInvoices({ invoiceModel: w.model, env: ENV, now: NOW, request: async () => ({ status: 404, data: {} }), notify: async () => true });
    assert.equal(out.creationLookup, undefined);
    assert.equal(w.row().status, "creation_unknown");
  });
});

describe("while the outcome is unknown a second invoice can never be created", () => {
  const catalog = buildCatalogFromProviderData({ currencies: ["trx"], merchantCoins: ["trx"] });
  const transport = async (o) => {
    if (o.url.includes("/min-amount")) return { status: 200, data: { min_amount: 0.1, fiat_equivalent: 0.01 } };
    if (o.url.endsWith("/currencies")) return { status: 200, data: { currencies: ["trx"] } };
    return { status: 500, data: {} };
  };
  test("creation_unknown blocks creation (in_flight) and no provider invoice request is made", async () => {
    resetNowPaymentsCreateLocksForTests();
    const w = world({}, []);
    let posts = 0;
    const request = async (o) => { if (o.path === "/invoice") posts += 1; return transport({ url: `https://api.nowpayments.io/v1${o.path}`, data: o.data }); };
    await assert.rejects(() => createNowPaymentsTopUp({ userId: 9700, amountToman: 50_000, env: ENV, invoiceModel: w.model, catalog, payCurrency: "trx", request, resolveRate: async () => ({ tomanPerFiat: 250_000, source: "t" }) }), (e) => e.code === "in_flight");
    assert.equal(posts, 0);
  });
});
