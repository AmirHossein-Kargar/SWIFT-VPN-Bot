/**
 * Custody local-invoice reads against a REAL MongoDB.
 *
 * The admin custody lists used to load the whole NOWPayments invoice collection
 * (hydrated, with every IPN log) and filter/sort/count in memory. They now count
 * and page in the database. These tests pin the behavior: the database-backed
 * result must equal the in-memory result for every filter, and no read may pull
 * the unbounded `ipnLog` array. Skips when no test database is reachable.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = "424242";
const REPO_ENV = { NOWPAYMENTS_API_KEY: "np-test-key-0001", NOWPAYMENTS_IPN_SECRET: "i".repeat(40) };

let NowPaymentsInvoice, custody;
if (dbAvailable) {
  ({ default: NowPaymentsInvoice } = await import("../../models/NowPaymentsInvoice.js"));
  custody = await import("../../services/admin/custody.js");
}

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);
const STATUSES = ["finished", "waiting", "expired", "partially_paid", "creation_unknown", "confirming", "failed", "creating"];
const CURRENCIES = ["trx", "usdttrc20", "btc", "trx"];

function seedRows() {
  return Array.from({ length: 41 }, (_, i) => {
    const createdAt = new Date(BASE + i * DAY); // distinct timestamps: ordering is unambiguous
    const status = STATUSES[i % STATUSES.length];
    return {
      orderId: `NP-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      userId: 5000 + i,
      amountToman: 100_000 + i * 1000,
      priceAmountCents: 500,
      priceCurrency: "usd",
      payCurrency: CURRENCIES[i % CURRENCIES.length],
      tomanPerFiat: 100_000,
      rateSource: "test",
      status,
      balanceCredited: status === "finished" && i % 2 === 0,
      recoveryStatus: i % 7 === 0 ? "required" : "none",
      underpaidAmount: i % 5 === 0 ? 0.5 : null,
      overpaidAmount: i % 9 === 0 ? 1.25 : null,
      quoteSnapshot: { quoteAt: createdAt.toISOString(), note: "q".repeat(40) },
      ipnLog: Array.from({ length: 4 }, () => ({ paymentStatus: status, payAmount: 1 })),
      createdAt,
      updatedAt: new Date(createdAt.getTime() + (i % 3) * 3_600_000),
    };
  });
}

/** The old read path: every invoice, in memory, with no query support (no countDocuments/aggregate). */
const inMemoryModel = () => ({ find: async () => NowPaymentsInvoice.find({}).lean() });

/** Real model that records every query so the projection can be inspected. */
function recordingModel(queries) {
  return new Proxy(NowPaymentsInvoice, {
    get(target, prop) {
      if (prop !== "find") {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args) => {
        const query = target.find(...args);
        queries.push(query);
        return query;
      };
    },
  });
}

describe("custody local invoices", () => {
  before(async () => {
    if (!dbAvailable) return;
    await NowPaymentsInvoice.collection.insertMany(seedRows());
  });
  after(async () => { if (dbAvailable) await disconnectTestDB(); });

  skip("transactions: database paging equals the in-memory result for every filter", async () => {
    let compared = 0;
    for (const status of ["all", "recovery-required", "underpaid", "overpaid", "waiting", "finished", "expired", "nonexistent"]) {
      for (const currency of ["", "trx", "usdttrc20", "btc", "doge"]) {
        for (const [page, pageSize] of [[1, 5], [2, 5], [3, 7], [99, 5], [1, 100]]) {
          const query = { status, currency, page, pageSize };
          const fromDatabase = await custody.getCustodyTransactions({ actorId: ADMIN, query, invoiceModel: NowPaymentsInvoice });
          const inMemory = await custody.getCustodyTransactions({ actorId: ADMIN, query, invoiceModel: inMemoryModel() });
          assert.deepEqual(fromDatabase, inMemory, JSON.stringify(query));
          compared += 1;
        }
      }
    }
    assert.equal(compared, 8 * 5 * 5);
  });

  skip("transactions: an invoice without a stored currency is listed and filtered as TRX", async () => {
    await NowPaymentsInvoice.collection.insertOne({ ...seedRows()[0], orderId: "NP-00000000-0000-4000-8000-999999999999", payCurrency: null, createdAt: new Date(BASE + 500 * DAY) });
    try {
      for (const currency of ["trx", "btc"]) {
        const query = { currency, pageSize: 100 };
        const fromDatabase = await custody.getCustodyTransactions({ actorId: ADMIN, query, invoiceModel: NowPaymentsInvoice });
        const inMemory = await custody.getCustodyTransactions({ actorId: ADMIN, query, invoiceModel: inMemoryModel() });
        assert.deepEqual(fromDatabase, inMemory, currency);
      }
      const trx = await custody.getCustodyTransactions({ actorId: ADMIN, query: { currency: "trx", pageSize: 100 }, invoiceModel: NowPaymentsInvoice });
      assert.ok(trx.items.some((item) => item.orderId.endsWith("999999999999") && item.payCurrency === "trx"));
    } finally {
      await NowPaymentsInvoice.deleteOne({ orderId: "NP-00000000-0000-4000-8000-999999999999" });
    }
  });

  skip("transactions: a search term still matches the full collection", async () => {
    const query = { search: "usdttrc20", pageSize: 100 };
    const fromDatabase = await custody.getCustodyTransactions({ actorId: ADMIN, query, invoiceModel: NowPaymentsInvoice });
    const inMemory = await custody.getCustodyTransactions({ actorId: ADMIN, query, invoiceModel: inMemoryModel() });
    assert.deepEqual(fromDatabase, inMemory);
    assert.ok(fromDatabase.total > 0);
  });

  skip("transactions: one page reads at most one page of rows and never the IPN log", async () => {
    const queries = [];
    const result = await custody.getCustodyTransactions({ actorId: ADMIN, query: { pageSize: 5 }, invoiceModel: recordingModel(queries) });
    assert.equal(result.items.length, 5);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].projection(), { ipnLog: 0 });
    assert.equal(queries[0].getOptions().limit, 5);
    assert.equal(queries[0].getOptions().lean ?? queries[0]._mongooseOptions.lean, true);
  });

  skip("overview: aggregated summary, recent deposits and warnings equal the in-memory result", async () => {
    const fromDatabase = await custody.getCustodyOverview({ actorId: ADMIN, env: {}, invoiceModel: NowPaymentsInvoice });
    const inMemory = await custody.getCustodyOverview({ actorId: ADMIN, env: {}, invoiceModel: inMemoryModel() });
    assert.deepEqual(fromDatabase.localSummary, inMemory.localSummary);
    assert.deepEqual(fromDatabase.recentDeposits, inMemory.recentDeposits);
    assert.deepEqual(fromDatabase.reconciliationWarnings, inMemory.reconciliationWarnings);
    assert.equal(fromDatabase.recentDeposits.length, 8);
    assert.equal(fromDatabase.reconciliationWarnings.length, 10);
    assert.ok(fromDatabase.localSummary.finishedCount > 0 && fromDatabase.localSummary.finishedToman > 0);
    assert.ok(fromDatabase.localSummary.pendingCount > 0 && fromDatabase.localSummary.underpaidCount > 0);
  });

  skip("overview: reads at most the newest deposits and warnings, never the IPN log", async () => {
    const queries = [];
    await custody.getCustodyOverview({ actorId: ADMIN, env: {}, invoiceModel: recordingModel(queries) });
    assert.equal(queries.length, 2);
    assert.deepEqual(queries.map((query) => query.getOptions().limit).sort((a, b) => a - b), [8, 10]);
    for (const query of queries) assert.deepEqual(query.projection(), { ipnLog: 0 });
  });

  skip("reconcile: inspects only the requested number of most recently updated invoices", async () => {
    const inspected = [];
    const client = { getPaymentStatus: async (paymentId) => { inspected.push(paymentId); return { data: { payment_status: "waiting", actually_paid: 0 } }; } };
    const newest = await NowPaymentsInvoice.find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(4).lean();
    for (const [index, doc] of newest.entries()) await NowPaymentsInvoice.updateOne({ _id: doc._id }, { $set: { paymentId: `PAY-${index}` } });

    const queries = [];
    await custody.reconcileNowPaymentsRecords({ actorId: ADMIN, env: REPO_ENV, client, limit: 4, invoiceModel: recordingModel(queries) });
    assert.equal(queries.length, 1);
    assert.equal(queries[0].getOptions().limit, 4);
    assert.deepEqual(queries[0].projection(), { ipnLog: 0 });
    assert.deepEqual(inspected.sort(), ["PAY-0", "PAY-1", "PAY-2", "PAY-3"]);
  });

  skip("reconcile: ranks by updatedAt, so an old invoice that was updated last is inspected first", async () => {
    const orderId = "NP-00000000-0000-4000-8000-555555555555";
    const inspected = [];
    const client = { getPaymentStatus: async (paymentId) => { inspected.push(paymentId); return { data: { payment_status: "waiting", actually_paid: 0 } }; } };
    // Created long before every seeded row, but touched after all of them.
    await NowPaymentsInvoice.collection.insertOne({
      ...seedRows()[0], orderId, paymentId: "PAY-OLD-BUT-UPDATED", status: "waiting",
      createdAt: new Date(BASE - 400 * DAY), updatedAt: new Date(BASE + 900 * DAY),
    });
    // The seeded row with the newest createdAt gets a payment id too, so ranking by createdAt would pick it instead.
    const newestCreated = await NowPaymentsInvoice.findOne({ orderId: { $ne: orderId } }).sort({ createdAt: -1 }).lean();
    await NowPaymentsInvoice.updateOne({ _id: newestCreated._id }, { $set: { paymentId: "PAY-NEWEST-CREATED" } });
    try {
      await custody.reconcileNowPaymentsRecords({ actorId: ADMIN, env: REPO_ENV, client, limit: 1, invoiceModel: NowPaymentsInvoice });
      assert.deepEqual(inspected, ["PAY-OLD-BUT-UPDATED"]);
    } finally {
      await NowPaymentsInvoice.deleteOne({ orderId });
      await NowPaymentsInvoice.updateOne({ _id: newestCreated._id }, { $unset: { paymentId: "" } });
    }
  });

  skip("underpaidAmount of exactly 0 is not underpaid (overview and filter, both read paths)", async () => {
    const orderId = "NP-00000000-0000-4000-8000-777777777777";
    const overview = (invoiceModel) => custody.getCustodyOverview({ actorId: ADMIN, env: {}, invoiceModel });
    const underpaid = (invoiceModel) => custody.getCustodyTransactions({ actorId: ADMIN, query: { status: "underpaid", pageSize: 100 }, invoiceModel });
    const beforeCount = (await overview(NowPaymentsInvoice)).localSummary.underpaidCount;
    const beforeList = await underpaid(NowPaymentsInvoice);
    await NowPaymentsInvoice.collection.insertOne({ ...seedRows()[0], orderId, status: "waiting", underpaidAmount: 0, balanceCredited: false, recoveryStatus: "none", createdAt: new Date(BASE + 600 * DAY) });
    try {
      for (const invoiceModel of [NowPaymentsInvoice, inMemoryModel()]) {
        assert.equal((await overview(invoiceModel)).localSummary.underpaidCount, beforeCount);
        const list = await underpaid(invoiceModel);
        assert.equal(list.total, beforeList.total);
        assert.ok(!list.items.some((item) => item.orderId === orderId));
      }
      const waiting = await custody.getCustodyTransactions({ actorId: ADMIN, query: { status: "waiting", pageSize: 100 }, invoiceModel: NowPaymentsInvoice });
      const row = waiting.items.find((item) => item.orderId === orderId);
      assert.ok(row, "still listed as a waiting invoice");
      assert.equal(row.underpaidAmount, 0);
    } finally {
      await NowPaymentsInvoice.deleteOne({ orderId });
    }
  });

  // Rows written before a field existed (or edited by hand) lack it. The app only creates invoices through
  // Mongoose `create`, so this does not happen for normal data; the intended behavior is documented on
  // findInvoiceDocs in services/admin/custody.js.
  skip("legacy-shaped rows: missing fields stay unknown, are never filled with defaults and never count as credited", async () => {
    const ids = {
      noTicker: "NP-00000000-0000-4000-8000-100000000001",
      noDates: "NP-00000000-0000-4000-8000-100000000002",
      noCredited: "NP-00000000-0000-4000-8000-100000000003",
      nonBooleanCredited: "NP-00000000-0000-4000-8000-100000000004",
    };
    const omit = (doc, ...fields) => Object.fromEntries(Object.entries(doc).filter(([key]) => !fields.includes(key)));
    const template = seedRows()[0];
    const overview = (invoiceModel) => custody.getCustodyOverview({ actorId: ADMIN, env: {}, invoiceModel });
    const listAll = (invoiceModel) => custody.getCustodyTransactions({ actorId: ADMIN, query: { pageSize: 100 }, invoiceModel });
    const before = (await overview(NowPaymentsInvoice)).localSummary;

    await NowPaymentsInvoice.collection.insertMany([
      { ...omit(template, "ticker", "network"), orderId: ids.noTicker, payCurrency: "btc", status: "waiting", createdAt: new Date(BASE - 10 * DAY) },
      { ...omit(template, "createdAt", "updatedAt"), orderId: ids.noDates, status: "waiting", paymentId: "PAY-LEGACY-NO-DATES" },
      { ...omit(template, "balanceCredited"), orderId: ids.noCredited, status: "finished", amountToman: 500_000, createdAt: new Date(BASE - 11 * DAY) },
      { ...template, orderId: ids.nonBooleanCredited, status: "finished", amountToman: 700_000, balanceCredited: 1, createdAt: new Date(BASE - 12 * DAY) },
    ]);
    try {
      const fromDatabase = await listAll(NowPaymentsInvoice);
      const inMemory = await listAll(inMemoryModel());
      assert.deepEqual(fromDatabase, inMemory);

      const byId = (orderId) => fromDatabase.items.find((item) => item.orderId === orderId);
      assert.equal(byId(ids.noTicker).ticker, "BTC", "derived from payCurrency, not the schema default TRX");
      assert.equal(byId(ids.noTicker).network, "BTC");
      assert.equal(byId(ids.noDates).createdAt, null, "unknown, not the time of the read");
      assert.equal(byId(ids.noDates).updatedAt, null);
      assert.equal(fromDatabase.items.at(-1).orderId, ids.noDates, "a row without a date sorts last");
      assert.equal(byId(ids.noCredited).balanceCredited, false);

      for (const invoiceModel of [NowPaymentsInvoice, inMemoryModel()]) {
        const summary = (await overview(invoiceModel)).localSummary;
        assert.equal(summary.finishedCount, before.finishedCount, "neither a missing nor a non-boolean balanceCredited counts as credited");
        assert.equal(summary.finishedToman, before.finishedToman);
      }
      assert.ok(!(await overview(NowPaymentsInvoice)).recentDeposits.some((item) => item.orderId === ids.noDates));

      const inspected = [];
      const client = { getPaymentStatus: async (paymentId) => { inspected.push(paymentId); return { data: { payment_status: "waiting", actually_paid: 0 } }; } };
      await custody.reconcileNowPaymentsRecords({ actorId: ADMIN, env: REPO_ENV, client, limit: 1, invoiceModel: NowPaymentsInvoice });
      assert.ok(!inspected.includes("PAY-LEGACY-NO-DATES"), "a row without updatedAt is not promoted to the newest");
    } finally {
      await NowPaymentsInvoice.deleteMany({ orderId: { $in: Object.values(ids) } });
    }
  });
});
