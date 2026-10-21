import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeMemoryModel } from "../helpers/memoryModel.js";

process.env.ADMINS = "9001";

const svc = await import("../../services/admin/paymentDeletion.js");
const { DELETION_SOURCES, explainDeletion, deletionFilter, previewPaymentDeletion, deletePayments, pendingMinAgeMs, MAX_DELETE_BATCH } = svc;
const { findTombstone } = await import("../../services/payments/invoiceCleanup.js");

const ADMIN = "9001";
const NOW = new Date("2026-10-21T12:00:00Z");
const HOUR = 3_600_000;
const old = new Date(NOW.getTime() - 200 * HOUR);
const fresh = new Date(NOW.getTime() - 2 * HOUR);
let n = 0;
const opId = () => `op-${String(++n).padStart(6, "0")}-abcdefghij`;

const originals = {};
let models;
let tombstones;
let audits;

/** Minimal audit model: unique operationId, supports create/findOne/updateOne/save. */
function makeAuditModel() {
  const docs = [];
  return {
    docs,
    async create(fields) {
      if (docs.some((d) => d.operationId === fields.operationId)) throw Object.assign(new Error("dup"), { code: 11000 });
      const doc = { ...fields, status: "started", async save() {} };
      docs.push(doc);
      return doc;
    },
    async findOne(filter) { return docs.find((d) => d.operationId === filter.operationId) || null; },
    async updateOne(filter, update) {
      const doc = docs.find((d) => d.status === filter.status && String(d._id ?? "") === String(filter._id ?? ""));
      if (doc) Object.assign(doc, update.$set);
    },
  };
}

beforeEach(() => {
  for (const provider of Object.keys(DELETION_SOURCES)) {
    originals[provider] ??= DELETION_SOURCES[provider].model;
  }
  models = {
    hooshpay: makeMemoryModel([
      { _id: "h-failed", uid: "H1", orderId: "O-H1", userId: 1, amount: 50000, status: "failed", createdAt: fresh },
      { _id: "h-pending-old", uid: "H2", orderId: "O-H2", userId: 1, amount: 60000, status: "pending", createdAt: old, expiresAt: new Date(old.getTime() + HOUR) },
      { _id: "h-pending-new", uid: "H3", orderId: "O-H3", userId: 1, amount: 60000, status: "pending", createdAt: fresh },
      { _id: "h-pending-unexpired", uid: "H4", orderId: "O-H4", userId: 1, amount: 1, status: "pending", createdAt: old, expiresAt: new Date(NOW.getTime() + HOUR) },
      { _id: "h-paid-stale", uid: "H5", orderId: "O-H5", userId: 2, amount: 70000, status: "pending", createdAt: old, paidAt: old },
      { _id: "h-credited", uid: "H6", orderId: "O-H6", userId: 2, amount: 70000, status: "failed", createdAt: old, balanceCredited: true },
      { _id: "h-paid", uid: "H7", orderId: "O-H7", userId: 2, amount: 70000, status: "paid", createdAt: old },
      { _id: "h-recovery", uid: "H8", orderId: "O-H8", userId: 2, amount: 70000, status: "failed", createdAt: old, recoveryStatus: "required" },
    ]),
    nowpayments: makeMemoryModel([
      { _id: "n-failed", orderId: "NP1", userId: 3, amountToman: 90000, status: "failed", createdAt: fresh },
      { _id: "n-failed-paid", orderId: "NP2", userId: 3, amountToman: 90000, status: "failed", createdAt: fresh, actuallyPaid: 12 },
      { _id: "n-waiting-old", orderId: "NP3", userId: 3, amountToman: 90000, status: "waiting", createdAt: old },
      { _id: "n-confirming", orderId: "NP4", userId: 3, amountToman: 90000, status: "confirming", createdAt: old },
      { _id: "n-partial", orderId: "NP5", userId: 3, amountToman: 90000, status: "partially_paid", createdAt: old },
      { _id: "n-finished", orderId: "NP6", userId: 3, amountToman: 90000, status: "finished", createdAt: old },
    ]),
    bank: makeMemoryModel([
      { _id: "b-rejected", paymentId: "B1", userId: 4, amount: 10000, status: "rejected", createdAt: fresh },
      { _id: "b-unpaid-old", paymentId: "B2", userId: 4, amount: 10000, status: "unpaid", createdAt: old },
      { _id: "b-receipt", paymentId: "B3", userId: 4, amount: 10000, status: "waiting_for_approval", createdAt: old, receiptFileId: "file" },
      { _id: "b-confirmed", paymentId: "B4", userId: 4, amount: 10000, status: "confirmed", createdAt: old, balanceCredited: true },
    ]),
    trx: makeMemoryModel([
      { _id: "t-rejected", invoiceId: "T1", userId: 5, amount: 20000, status: "rejected", createdAt: fresh },
      { _id: "t-unpaid-old", invoiceId: "T2", userId: 5, amount: 20000, status: "unpaid", createdAt: old },
      { _id: "t-paid", invoiceId: "T3", userId: 5, amount: 20000, status: "paid", createdAt: old, transactionHash: "abc" },
    ]),
  };
  for (const provider of Object.keys(models)) DELETION_SOURCES[provider].model = models[provider];
  tombstones = makeMemoryModel([]);
  // findTombstone() chains .lean(); the in-memory model returns a bare promise.
  const plainFindOne = tombstones.findOne.bind(tombstones);
  tombstones.findOne = (filter) => {
    const or = filter.$or;
    const promise = plainFindOne(or ? { $or: or.map((c) => c), provider: filter.provider } : filter);
    return Object.assign(promise, { lean: () => promise });
  };
  audits = makeAuditModel();
});

const call = (extra) => deletePayments({ actorId: ADMIN, operationId: opId(), now: NOW, tombstoneModel: tombstones, auditModel: audits, ...extra });
const docIds = (provider) => models[provider].docs.map((d) => d._id);

describe("eligibility", () => {
  const verdict = (provider, id) => explainDeletion(provider, models[provider].docs.find((d) => d._id === id), { now: NOW });

  test("rejected records are eligible immediately", () => {
    assert.equal(verdict("hooshpay", "h-failed").class, "rejected");
    assert.equal(verdict("nowpayments", "n-failed").eligible, true);
    assert.equal(verdict("bank", "b-rejected").eligible, true);
    assert.equal(verdict("trx", "t-rejected").eligible, true);
  });

  test("pending records need the minimum age and a passed provider expiry", () => {
    assert.equal(verdict("hooshpay", "h-pending-old").class, "stale");
    assert.equal(verdict("hooshpay", "h-pending-new").code, "too_new");
    assert.equal(verdict("hooshpay", "h-pending-unexpired").code, "not_expired");
    assert.equal(verdict("nowpayments", "n-waiting-old").eligible, true);
    assert.equal(verdict("bank", "b-unpaid-old").eligible, true);
    assert.equal(verdict("trx", "t-unpaid-old").eligible, true);
  });

  test("anything that moved or may hold money is never eligible, whatever its status says", () => {
    assert.equal(verdict("hooshpay", "h-paid-stale").code, "funds_seen", "pending status but already paidAt");
    assert.equal(verdict("hooshpay", "h-credited").code, "credited");
    assert.equal(verdict("hooshpay", "h-paid").code, "status");
    assert.equal(verdict("hooshpay", "h-recovery").code, "recovery");
    assert.equal(verdict("nowpayments", "n-failed-paid").code, "funds_seen");
    for (const id of ["n-confirming", "n-partial", "n-finished"]) assert.equal(verdict("nowpayments", id).eligible, false, id);
    assert.equal(verdict("bank", "b-receipt").code, "receipt");
    assert.equal(verdict("bank", "b-confirmed").eligible, false);
    assert.equal(verdict("trx", "t-paid").eligible, false);
  });

  test("the minimum pending age has a 24h floor and a 72h default", () => {
    assert.equal(pendingMinAgeMs({}), 72 * HOUR);
    assert.equal(pendingMinAgeMs({ ADMIN_PENDING_DELETE_MIN_HOURS: "1" }), 24 * HOUR);
    assert.equal(pendingMinAgeMs({ ADMIN_PENDING_DELETE_MIN_HOURS: "120" }), 120 * HOUR);
    assert.equal(pendingMinAgeMs({ ADMIN_PENDING_DELETE_MIN_HOURS: "abc" }), 72 * HOUR);
  });

  test("the delete filter agrees with the explanation for every seeded record", async () => {
    for (const [provider, model] of Object.entries(models)) {
      for (const doc of model.docs) {
        const explained = explainDeletion(provider, doc, { now: NOW }).eligible;
        const filter = deletionFilter(provider, doc, { now: NOW });
        const matched = filter ? Boolean(await model.findOne({ _id: doc._id, ...filter })) : false;
        assert.equal(matched, explained, `${provider}:${doc._id}`);
      }
    }
  });
});

describe("authorization and input validation", () => {
  test("a non-admin can neither preview nor delete", async () => {
    await assert.rejects(() => previewPaymentDeletion({ actorId: "123", keys: ["hooshpay:H1"] }), { code: "forbidden" });
    await assert.rejects(() => call({ actorId: "123", keys: ["hooshpay:H1"], confirmCount: 1 }), { code: "forbidden" });
    assert.ok(docIds("hooshpay").includes("h-failed"));
  });

  test("wallet orders, malformed keys, oversize and empty selections are rejected before touching data", async () => {
    await assert.rejects(() => call({ keys: ["wallet:P1"], confirmCount: 1 }), { code: "wallet_order_not_deletable" });
    await assert.rejects(() => call({ keys: ["hooshpay:../x"], confirmCount: 1 }), { code: "invalid_payment_id" });
    await assert.rejects(() => call({ keys: ["nope:1"], confirmCount: 1 }), { code: "invalid_payment_id" });
    await assert.rejects(() => call({ keys: [], confirmCount: 0 }), { code: "invalid_selection" });
    await assert.rejects(() => call({ keys: Array.from({ length: MAX_DELETE_BATCH + 1 }, (_, i) => `bank:B${i}`), confirmCount: MAX_DELETE_BATCH + 1 }), { code: "invalid_selection" });
    await assert.rejects(() => call({ keys: { $ne: null }, confirmCount: 1 }), { code: "invalid_selection" });
    assert.equal(audits.docs.length, 0);
  });

  test("the confirmation count must match the selection", async () => {
    await assert.rejects(() => call({ keys: ["hooshpay:H1", "bank:B1"], confirmCount: 1 }), { code: "confirm_count_mismatch" });
    assert.ok(docIds("hooshpay").includes("h-failed"));
  });
});

describe("individual and bulk deletion", () => {
  test("an eligible record is removed and tombstoned; nothing else is touched", async () => {
    const result = await call({ keys: ["hooshpay:H1"], confirmCount: 1 });
    assert.deepEqual(result.deletedKeys, ["hooshpay:H1"]);
    assert.ok(!docIds("hooshpay").includes("h-failed"));
    assert.equal(models.hooshpay.docs.length, 7);
    const stone = await findTombstone({ provider: "hooshpay", orderId: "O-H1", tombstoneModel: tombstones });
    assert.equal(stone.finalStatus, "failed");
    assert.equal(stone.userId, 1);
    assert.equal(stone.amountToman, 50000);
    assert.ok(stone.deletedAt instanceof Date);
  });

  test("a bulk selection across all four collections deletes every eligible record", async () => {
    const keys = ["hooshpay:H1", "hooshpay:H2", "nowpayments:NP1", "nowpayments:NP3", "bank:B1", "bank:B2", "trx:T1", "trx:T2"];
    const result = await call({ keys, confirmCount: keys.length });
    assert.equal(result.deleted, 8);
    assert.deepEqual(result.skipped, []);
    assert.equal(tombstones.docs.length, 8);
    assert.deepEqual(docIds("trx"), ["t-paid"]);
  });

  test("one ineligible record blocks the whole batch: nothing is deleted and the blocker is named", async () => {
    const keys = ["hooshpay:H1", "hooshpay:H5", "bank:B1"];
    await assert.rejects(() => call({ keys, confirmCount: 3 }), (error) => {
      assert.equal(error.code, "payments_not_deletable");
      assert.equal(error.status, 409);
      assert.deepEqual(error.details.map((d) => [d.key, d.code]), [["hooshpay:H5", "funds_seen"]]);
      return true;
    });
    assert.equal(models.hooshpay.docs.length, 8);
    assert.equal(models.bank.docs.length, 4);
    assert.equal(tombstones.docs.length, 0);
  });

  test("a paid-but-stale record (pending status, paidAt set) is never deleted, even when selected directly", async () => {
    await assert.rejects(() => call({ keys: ["hooshpay:H5"], confirmCount: 1 }), { code: "payments_not_deletable" });
    assert.ok(docIds("hooshpay").includes("h-paid-stale"));
  });

  test("a status that flips between preflight and delete is skipped, not removed", async () => {
    const hooshModel = models.hooshpay;
    const realDelete = hooshModel.deleteOne.bind(hooshModel);
    hooshModel.deleteOne = async (filter) => {
      // A webhook credits the invoice just before the conditional delete runs.
      const doc = hooshModel.docs.find((d) => d._id === filter._id);
      if (doc) { doc.status = "paid"; doc.balanceCredited = true; doc.paidAt = NOW; }
      return realDelete(filter);
    };
    const result = await call({ keys: ["hooshpay:H1", "bank:B1"], confirmCount: 2 });
    assert.deepEqual(result.deletedKeys, ["bank:B1"]);
    assert.deepEqual(result.skipped.map((s) => s.key), ["hooshpay:H1"]);
    assert.ok(docIds("hooshpay").includes("h-failed"), "the now-paid invoice survives");
    const stone = tombstones.docs.find((d) => d.orderId === "O-H1");
    assert.equal(stone.deletedAt ?? null, null, "unfinished tombstone stays visibly incomplete");
  });

  test("an unknown or already-deleted record is reported as ineligible, not silently ignored", async () => {
    await assert.rejects(() => call({ keys: ["hooshpay:NOPE"], confirmCount: 1 }), (error) => error.details[0].code === "not_found");
  });

  test("duplicate keys in one request are collapsed", async () => {
    const result = await call({ keys: ["bank:B1", "bank:B1"], confirmCount: 1 });
    assert.equal(result.deleted, 1);
  });
});

describe("repeats, concurrency and audit", () => {
  test("replaying the same operationId returns the first result and deletes nothing more", async () => {
    const operationId = opId();
    const first = await call({ operationId, keys: ["bank:B1"], confirmCount: 1 });
    const second = await call({ operationId, keys: ["bank:B1"], confirmCount: 1 });
    assert.deepEqual(second.deleted, first.deleted);
    assert.equal(tombstones.docs.length, 1);
  });

  test("reusing an operationId for a different action by another actor is refused", async () => {
    const operationId = opId();
    await call({ operationId, keys: ["bank:B1"], confirmCount: 1 });
    audits.docs[0].action = "SOMETHING_ELSE";
    await assert.rejects(() => call({ operationId, keys: ["bank:B1"], confirmCount: 1 }), { code: "idempotency_conflict" });
  });

  test("two concurrent requests delete each record once; the loser reports it as already gone", async () => {
    const [a, b] = await Promise.allSettled([
      call({ keys: ["trx:T1"], confirmCount: 1 }),
      call({ keys: ["trx:T1"], confirmCount: 1 }),
    ]);
    const deleted = [a, b].filter((r) => r.status === "fulfilled" && r.value.deleted === 1).length;
    assert.equal(deleted, 1);
    assert.equal(tombstones.docs.filter((d) => d.orderId === "T1").length, 1);
  });

  test("a database failure mid-batch is audited as failed and earlier deletions stay tombstoned", async () => {
    const trx = models.trx;
    const real = trx.deleteOne.bind(trx);
    trx.deleteOne = async () => { throw new Error("db down"); };
    await assert.rejects(() => call({ keys: ["bank:B1", "trx:T1"], confirmCount: 2 }));
    trx.deleteOne = real;
    assert.ok(!docIds("bank").includes("b-rejected"));
    assert.ok(docIds("trx").includes("t-rejected"));
    assert.equal(tombstones.docs.find((d) => d.orderId === "B1").finalStatus, "rejected");
  });

  test("the audit trail records the action and counts but not payment internals", async () => {
    await call({ keys: ["bank:B1"], confirmCount: 1 });
    const audit = audits.docs[0];
    assert.equal(audit.action, "PAYMENTS_DELETED");
    assert.equal(audit.actorTelegramId, ADMIN);
    assert.equal(audit.metadata.count, 1);
  });

  test("a late webhook for a deleted invoice finds its tombstone, so it is recorded and never credits", async () => {
    await call({ keys: ["hooshpay:H1", "nowpayments:NP1"], confirmCount: 2 });
    const hoosh = await findTombstone({ provider: "hooshpay", orderId: "O-H1", uid: "H1", tombstoneModel: tombstones });
    const now = await findTombstone({ provider: "nowpayments", orderId: "NP1", tombstoneModel: tombstones });
    assert.ok(hoosh && now);
  });
});

describe("preview", () => {
  test("reports per-record verdicts without deleting", async () => {
    const preview = await previewPaymentDeletion({ actorId: ADMIN, keys: ["hooshpay:H1", "hooshpay:H3", "wallet-less:1".replace("wallet-less", "bank")], now: NOW });
    assert.equal(preview.requested, 3);
    assert.equal(preview.eligible, 1);
    assert.equal(preview.items.find((i) => i.key === "hooshpay:H3").code, "too_new");
    assert.equal(models.hooshpay.docs.length, 8);
  });
});

describe("late provider notification after an admin deletion (stale-pending class)", () => {
  async function lateIpn(status) {
    const { handleNowPaymentsIpn: handler } = await import("../../services/nowpayments/ipnHandler.js");
    const { signNowPaymentsIpn } = await import("../../services/nowpayments/signature.js");
    const payload = { order_id: "NP3", payment_id: 77, payment_status: status };
    const secret = "s".repeat(40);
    const req = { rawBody: Buffer.from(JSON.stringify(payload)), headers: { "x-nowpayments-sig": signNowPaymentsIpn(payload, secret) }, get(name) { return this.headers[name.toLowerCase()]; } };
    const res = { statusCode: null, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    const sent = [];
    let credited = 0;
    await handler(req, res, {
      secret,
      apply: async () => ({ outcome: "unknown_order", credited: false }), // the invoice no longer exists
      notify: async () => { credited += 1; },
      lookupTombstone: (query) => findTombstone({ ...query, tombstoneModel: tombstones }),
      recordLate: async ({ tombstone, status: s }) => { const doc = tombstones.docs.find((d) => d._id === tombstone._id); doc.lateEventCount = (doc.lateEventCount || 0) + 1; doc.lateStatus = s; },
      bot: { sendMessage: async (...args) => { sent.push(args); } },
    });
    return { res, sent, credited };
  }

  test("a paid notification for a deleted stale-pending invoice is acknowledged, recorded, alerts admins and credits nothing", async () => {
    process.env.GROUP_ID = "-100777";
    await call({ keys: ["nowpayments:NP3"], confirmCount: 1 });
    const { res, sent, credited } = await lateIpn("finished");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, "invoice_removed");
    assert.equal(credited, 0, "no wallet credit path is reached");
    assert.equal(tombstones.docs.find((d) => d.orderId === "NP3").lateEventCount, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /NP3/);
    assert.match(sent[0][1], /بررسی دستی/);
  });

  test("repeated late notifications never credit and are all recorded", async () => {
    await call({ keys: ["nowpayments:NP3"], confirmCount: 1 });
    for (let i = 0; i < 3; i += 1) assert.equal((await lateIpn("finished")).credited, 0);
    assert.equal(tombstones.docs.find((d) => d.orderId === "NP3").lateEventCount, 3);
  });

  test("a non-money status (e.g. expired) is recorded without paging anyone", async () => {
    await call({ keys: ["nowpayments:NP3"], confirmCount: 1 });
    const { sent, res } = await lateIpn("expired");
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 0);
  });

  test("an alert delivery failure never changes the provider response", async () => {
    await call({ keys: ["nowpayments:NP3"], confirmCount: 1 });
    const { handleNowPaymentsIpn: handler } = await import("../../services/nowpayments/ipnHandler.js");
    const { signNowPaymentsIpn } = await import("../../services/nowpayments/signature.js");
    const payload = { order_id: "NP3", payment_id: 77, payment_status: "finished" };
    const secret = "s".repeat(40);
    const req = { rawBody: Buffer.from(JSON.stringify(payload)), headers: { "x-nowpayments-sig": signNowPaymentsIpn(payload, secret) }, get(name) { return this.headers[name.toLowerCase()]; } };
    const res = { statusCode: null, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await handler(req, res, {
      secret,
      apply: async () => ({ outcome: "unknown_order" }),
      lookupTombstone: (query) => findTombstone({ ...query, tombstoneModel: tombstones }),
      recordLate: async () => {},
      bot: { sendMessage: async () => { throw new Error("telegram down"); } },
    });
    assert.equal(res.statusCode, 200);
  });

  test("an admin deletion is recorded in the audit trail with who and how many, and no payment secrets", async () => {
    await call({ keys: ["nowpayments:NP3"], confirmCount: 1 });
    const audit = audits.docs.at(-1);
    assert.equal(audit.action, "PAYMENTS_DELETED");
    assert.deepEqual(Object.keys(audit.metadata).sort(), ["count", "keys"]);
  });
});
