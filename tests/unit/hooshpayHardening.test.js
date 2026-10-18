import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHooshInvoice } from "../../services/hooshpay/createHooshInvoice.js";
import { fulfillHooshOrder } from "../../services/hooshpay/fulfillHooshOrder.js";
import { validateHooshPaidDetails } from "../../services/hooshpay/paymentValidation.js";
import { verifyHooshPayment } from "../../services/hooshpay/verifyHooshPayment.js";

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((part) => matches(doc, part));
    const value = doc[key];
    if (condition == null) return value == null;
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if (condition.$in) return condition.$in.includes(value);
      if (Object.hasOwn(condition, "$ne")) return value !== condition.$ne;
      if (condition.$lt) return new Date(value) < new Date(condition.$lt);
    }
    return value === condition;
  });
}

function applyUpdate(doc, update) {
  Object.assign(doc, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) delete doc[key];
}

function hooshModel(seed = []) {
  const docs = seed.map((item, index) => ({ _id: `hoosh-${index}`, ...item }));
  return {
    docs,
    async create(fields) {
      if (docs.some((doc) => doc.openCreateKey && doc.openCreateKey === fields.openCreateKey)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      const doc = { _id: `hoosh-${docs.length}`, ...fields };
      docs.push(doc);
      return doc;
    },
    async updateOne(filter, update) {
      const doc = docs.find((item) => matches(item, filter));
      if (!doc) return { modifiedCount: 0 };
      applyUpdate(doc, update);
      return { modifiedCount: 1 };
    },
    async findOne(filter) { return docs.find((item) => matches(item, filter)) || null; },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find((item) => matches(item, filter));
      if (!doc) return null;
      applyUpdate(doc, update);
      return doc;
    },
    findById(id) {
      const doc = docs.find((item) => item._id === id) || null;
      return { async lean() { return doc; } };
    },
  };
}

function invoice(overrides = {}) {
  return {
    _id: "hoosh-0",
    uid: "hp_123",
    orderId: "HP-order-123",
    userId: 9001,
    amount: 25_000,
    currency: "TOMAN",
    feeMode: "buyer",
    status: "pending",
    creationStatus: "created",
    fulfilled: false,
    balanceCredited: false,
    creditLedgerVersion: 2,
    notificationPending: false,
    ...overrides,
  };
}

function trustedPaid(overrides = {}) {
  return {
    success: true,
    paid: true,
    data: {
      uid: "hp_123",
      order_id: "HP-order-123",
      status: "paid",
      amount: 25_000,
      currency: "TOMAN",
      fee_mode: "buyer",
      tracking_code: "track-1",
      ...overrides,
    },
  };
}

describe("HooshPay trusted payment validation", () => {
  test("binds paid confirmation to UID, order, Toman amount, currency, and fee fields", () => {
    const local = invoice({ payableAmount: 25_250, feeAmount: 250, merchantCredit: 25_000 });
    const valid = trustedPaid({ payable_amount: 25_250, fee_amount: 250, merchant_credit: 25_000 });
    assert.equal(validateHooshPaidDetails(local, valid, { requireUid: true, requireOrderId: true, requireCurrency: true }), null);
    assert.equal(validateHooshPaidDetails(local, trustedPaid({ uid: "other" }), { requireUid: true }), "invoice_uid_mismatch");
    assert.equal(validateHooshPaidDetails(local, trustedPaid({ order_id: "other" }), { requireOrderId: true }), "order_id_mismatch");
    assert.equal(validateHooshPaidDetails(local, trustedPaid({ amount: 25_001 })), "amount_mismatch");
    assert.equal(validateHooshPaidDetails(local, trustedPaid({ currency: "USD" }), { requireCurrency: true }), "currency_mismatch");
    assert.equal(validateHooshPaidDetails(local, trustedPaid({ fee_amount: 999 })), "fee_amount_mismatch");
  });

  test("manual verification never fulfills mismatched or terminal provider results", async () => {
    const model = hooshModel([invoice()]);
    let fulfilled = 0;
    const dependencies = {
      invoiceModel: model,
      acquireLock: async () => ({ acquired: true, key: "test" }),
      releaseLock: async () => {},
      fulfill: async () => { fulfilled += 1; return { credited: true }; },
    };
    const mismatch = await verifyHooshPayment("hp_123", null, 9001, {
      ...dependencies,
      verifyInvoice: async () => trustedPaid({ amount: 99 }),
    });
    assert.equal(mismatch.success, false);
    assert.equal(fulfilled, 0);

    const failed = await verifyHooshPayment("hp_123", null, 9001, {
      ...dependencies,
      verifyInvoice: async () => ({ success: true, paid: false, data: { status: "failed" } }),
    });
    assert.equal(failed.failed, true);
    assert.equal(model.docs[0].status, "failed");
    assert.equal(fulfilled, 0);
  });

  test("terminal local invoices cannot be revived or credited", async () => {
    for (const status of ["failed", "cancelled", "expired", "reversed"]) {
      const local = invoice({ status });
      let modelCalls = 0;
      const result = await fulfillHooshOrder({
        invoice: local,
        bot: null,
        chatId: local.userId,
        invoiceModel: { findOneAndUpdate: async () => { modelCalls += 1; } },
        creditWallet: async () => { throw new Error("must not credit"); },
      });
      assert.equal(result.credited, false, status);
      assert.equal(modelCalls, 0, status);
    }
  });
});

describe("HooshPay creation ambiguity and settlement races", () => {
  test("an ambiguous create is durable and blocks a duplicate provider request", async () => {
    const previous = process.env.WEBHOOK_BASE_URL;
    process.env.WEBHOOK_BASE_URL = "https://pay.example.test";
    const model = hooshModel();
    let requests = 0;
    const ambiguous = Object.assign(new Error("timeout"), { ambiguous: true });
    try {
      await assert.rejects(() => createHooshInvoice({
        userId: 9002,
        amount: 30_000,
        invoiceModel: model,
        createInvoice: async () => { requests += 1; throw ambiguous; },
      }), (error) => error === ambiguous);
      await assert.rejects(() => createHooshInvoice({
        userId: 9002,
        amount: 30_000,
        invoiceModel: model,
        createInvoice: async () => { requests += 1; return {}; },
      }), (error) => error.code === "in_flight");
      assert.equal(requests, 1);
      assert.equal(model.docs[0].creationStatus, "creation_unknown");
      assert.equal(model.docs[0].recoveryStatus, "required");
      assert.equal(model.docs[0].balanceCredited, undefined);
    } finally {
      if (previous == null) delete process.env.WEBHOOK_BASE_URL;
      else process.env.WEBHOOK_BASE_URL = previous;
    }
  });

  test("a reversal racing a claimed payment remains visible after exactly one wallet credit", async () => {
    const local = invoice();
    const model = hooshModel([local]);
    let credits = 0;
    const result = await fulfillHooshOrder({
      invoice: model.docs[0],
      bot: null,
      chatId: 9001,
      invoiceModel: model,
      creditWallet: async () => {
        credits += 1;
        Object.assign(model.docs[0], {
          status: "reversed",
          recoveryStatus: "required",
          recoveryReason: "provider_reversal_after_payment_claim",
        });
        return { user: { balance: 25_000 }, credited: true, alreadyCredited: false };
      },
    });
    assert.equal(result.credited, true);
    assert.equal(credits, 1);
    assert.equal(model.docs[0].status, "reversed");
    assert.equal(model.docs[0].balanceCredited, true);
    assert.equal(model.docs[0].notificationPending, false);
    assert.equal(model.docs[0].recoveryStatus, "required");
  });
});
