import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeMemoryModel } from "../helpers/memoryModel.js";
import { applyTerminalStatusStamp } from "../../models/terminalStamp.js";
import {
  RETENTION_MS,
  findTombstone,
  recordLateEvent,
  runInvoiceCleanup,
  runInvoiceCleanupBatches,
} from "../../services/payments/invoiceCleanup.js";
import { handleNowPaymentsIpn } from "../../services/nowpayments/ipnHandler.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;

function setup({ hoosh = [], nowpayments = [] } = {}) {
  const hooshModel = makeMemoryModel(hoosh);
  const npModel = makeMemoryModel(nowpayments);
  const tombstones = makeMemoryModel([]);
  const rules = [
    {
      provider: "hooshpay",
      model: hooshModel,
      statuses: ["cancelled", "failed"],
      extraFilter: { fulfilled: { $ne: true }, balanceCredited: { $ne: true }, recoveryStatus: { $ne: "required" } },
      tombstoneFields: (d) => ({ uid: d.uid || null, amountToman: d.amount }),
    },
    {
      provider: "nowpayments",
      model: npModel,
      statuses: ["failed"],
      extraFilter: { balanceCredited: { $ne: true }, recoveryStatus: { $ne: "required" }, actuallyPaid: { $in: [null, 0] } },
      tombstoneFields: (d) => ({ invoiceId: d.invoiceId || null, paymentId: d.paymentId || null, amountToman: d.amountToman }),
    },
  ];
  return { hooshModel, npModel, tombstones, rules, run: (o = {}) => runInvoiceCleanupBatches({ now: NOW, rules, tombstoneModel: tombstones, ...o }) };
}

const hoosh = (over) => ({ orderId: `H-${Math.random()}`, uid: "u", userId: 1, amount: 50_000, status: "failed", terminalStatusAt: ago(25 * HOUR), createdAt: ago(40 * HOUR), ...over });
const np = (over) => ({ orderId: `NP-${Math.random()}`, userId: 1, amountToman: 50_000, status: "failed", terminalStatusAt: ago(25 * HOUR), createdAt: ago(40 * HOUR), balanceCredited: false, ...over });

describe("which invoices are removed", () => {
  test("failed and cancelled invoices older than 24h are removed and leave a tombstone", async () => {
    const t = setup({ hoosh: [hoosh({ orderId: "H1", status: "failed" }), hoosh({ orderId: "H2", status: "cancelled" })], nowpayments: [np({ orderId: "NP-1", invoiceId: "i1", paymentId: "p1" })] });
    const summary = await t.run();
    assert.equal(summary.deleted, 3);
    assert.equal(t.hooshModel.docs.length, 0);
    assert.equal(t.npModel.docs.length, 0);
    assert.equal(t.tombstones.docs.length, 3);
    const tomb = t.tombstones.docs.find((d) => d.orderId === "NP-1");
    assert.deepEqual([tomb.invoiceId, tomb.paymentId, tomb.finalStatus, tomb.amountToman, tomb.userId], ["i1", "p1", "failed", 50_000, 1]);
    assert.equal(tomb.deletedAt.getTime(), NOW.getTime());
  });

  test("the 24h clock starts at the terminal timestamp, not at creation", async () => {
    const t = setup({
      hoosh: [
        hoosh({ orderId: "old-create-new-fail", createdAt: ago(300 * HOUR), terminalStatusAt: ago(2 * HOUR) }),
        hoosh({ orderId: "exactly-24h", terminalStatusAt: ago(RETENTION_MS) }),
        hoosh({ orderId: "just-under", terminalStatusAt: ago(RETENTION_MS - 1000) }),
      ],
    });
    await t.run();
    assert.deepEqual(t.hooshModel.docs.map((d) => d.orderId).sort(), ["just-under", "old-create-new-fail"]);
  });

  test("pending, paid, partially paid, refunded, reversed, expired and creation states are never touched", async () => {
    const keep = [
      hoosh({ orderId: "k1", status: "pending" }),
      hoosh({ orderId: "k2", status: "paid" }),
      hoosh({ orderId: "k3", status: "reversed" }),
      hoosh({ orderId: "k4", status: "expired" }),
    ];
    const keepNp = ["creating", "pending", "waiting", "confirming", "partially_paid", "finished", "refunded", "expired", "creation_failed", "creation_unknown"]
      .map((status) => np({ orderId: `NP-${status}`, status }));
    const t = setup({ hoosh: keep, nowpayments: keepNp });
    const summary = await t.run();
    assert.equal(summary.deleted, 0);
    assert.equal(t.hooshModel.docs.length, 4);
    assert.equal(t.npModel.docs.length, keepNp.length);
  });

  test("credited, fulfilled, manual-review or funded failed invoices are kept", async () => {
    const t = setup({
      hoosh: [
        hoosh({ orderId: "credited", balanceCredited: true }),
        hoosh({ orderId: "fulfilled", fulfilled: true }),
        hoosh({ orderId: "review", recoveryStatus: "required" }),
      ],
      nowpayments: [
        np({ orderId: "NP-credited", balanceCredited: true }),
        np({ orderId: "NP-review", recoveryStatus: "required" }),
        np({ orderId: "NP-funded", actuallyPaid: 12.5 }),
        np({ orderId: "NP-zero", actuallyPaid: 0 }),
      ],
    });
    await t.run();
    assert.deepEqual(t.hooshModel.docs.map((d) => d.orderId).sort(), ["credited", "fulfilled", "review"]);
    assert.deepEqual(t.npModel.docs.map((d) => d.orderId).sort(), ["NP-credited", "NP-funded", "NP-review"]);
  });

  test("missing or malformed terminal timestamps start a fresh 24h clock instead of deleting", async () => {
    const t = setup({
      hoosh: [
        hoosh({ orderId: "missing", terminalStatusAt: undefined }),
        hoosh({ orderId: "null", terminalStatusAt: null }),
        hoosh({ orderId: "string", terminalStatusAt: "yesterday" }),
      ],
    });
    const first = await t.run();
    assert.equal(first.deleted, 0);
    assert.equal(first.stamped, 3);
    assert.ok(t.hooshModel.docs.every((d) => d.terminalStatusAt.getTime() === NOW.getTime()));
    // A valid stamp is never reset by later runs.
    const later = await t.run({ now: new Date(NOW.getTime() + 2 * HOUR) });
    assert.equal(later.stamped, 0);
    assert.ok(t.hooshModel.docs.every((d) => d.terminalStatusAt.getTime() === NOW.getTime()));
    const day = await t.run({ now: new Date(NOW.getTime() + RETENTION_MS) });
    assert.equal(day.deleted, 3);
  });

  test("dry run reports but changes nothing", async () => {
    const t = setup({ hoosh: [hoosh({ orderId: "H1" })], nowpayments: [np({ orderId: "NP-1" })] });
    const summary = await t.run({ dryRun: true });
    assert.equal(summary.eligible, 2);
    assert.equal(summary.deleted, 0);
    assert.equal(t.hooshModel.docs.length + t.npModel.docs.length, 2);
    assert.equal(t.tombstones.docs.length, 0);
  });

  test("large backlogs are processed in bounded batches", async () => {
    const t = setup({ hoosh: Array.from({ length: 25 }, (_, i) => hoosh({ orderId: `B${i}` })) });
    const partial = await t.run({ batchSize: 10, maxBatches: 2 });
    assert.equal(partial.deleted, 20);
    assert.equal(t.hooshModel.docs.length, 5);
    const rest = await t.run({ batchSize: 10, maxBatches: 2 });
    assert.equal(rest.deleted, 5);
  });
});

describe("restarts, concurrency and the lease", () => {
  test("running twice is idempotent", async () => {
    const t = setup({ hoosh: [hoosh({ orderId: "H1" })] });
    await t.run();
    const second = await t.run();
    assert.equal(second.deleted, 0);
    assert.equal(t.tombstones.docs.length, 1);
  });

  test("two workers racing over the same rows delete each invoice once and write one tombstone", async () => {
    const t = setup({ hoosh: Array.from({ length: 12 }, (_, i) => hoosh({ orderId: `R${i}` })) });
    const results = await Promise.all([t.run({ batchSize: 5 }), t.run({ batchSize: 5 }), t.run({ batchSize: 5 })]);
    assert.equal(results.reduce((sum, r) => sum + r.deleted, 0), 12);
    assert.equal(t.hooshModel.docs.length, 0);
    assert.equal(t.tombstones.docs.length, 12);
    assert.equal(new Set(t.tombstones.docs.map((d) => d.orderId)).size, 12);
  });

  test("a row credited between selection and deletion survives", async () => {
    const t = setup({ hoosh: [hoosh({ orderId: "H1" })] });
    const original = t.hooshModel.deleteOne.bind(t.hooshModel);
    t.hooshModel.deleteOne = async (filter) => {
      t.hooshModel.docs[0].balanceCredited = true; // credited by another path just now
      return original(filter);
    };
    const summary = await t.run();
    assert.equal(summary.deleted, 0);
    assert.equal(t.hooshModel.docs.length, 1);
    assert.ok(!t.tombstones.docs[0].deletedAt, "an unfinished delete stays visible in the tombstone");
  });

  test("only the instance holding the lease runs; the lease is released afterwards", async () => {
    const t = setup({ hoosh: [hoosh({ orderId: "H1" })] });
    const events = [];
    const denied = await runInvoiceCleanup({ now: NOW, rules: t.rules, tombstoneModel: t.tombstones, acquireLease: async () => null, releaseLease: async () => events.push("release") });
    assert.deepEqual(denied, { skipped: true, reason: "lease_unavailable" });
    assert.equal(t.hooshModel.docs.length, 1);

    const lease = { key: "k", token: "t" };
    const ok = await runInvoiceCleanup({ now: NOW, rules: t.rules, tombstoneModel: t.tombstones, acquireLease: async () => lease, releaseLease: async (l) => events.push(l === lease ? "release" : "wrong") });
    assert.equal(ok.deleted, 1);
    assert.deepEqual(events, ["release"]);
  });
});

describe("terminal timestamp stamping", () => {
  function fakeSchema() {
    const hooks = {};
    return { hooks, add() {}, index() {}, pre(name, fn) { hooks[name] = fn; } };
  }
  const T0 = new Date("2026-01-01T00:00:00Z");

  test("update paths add $min only for cancelled/failed so repeats cannot reset the clock", () => {
    const schema = fakeSchema();
    applyTerminalStatusStamp(schema, ["cancelled", "failed"], { now: () => T0 });
    const run = (update) => {
      let applied = update;
      schema.hooks.findOneAndUpdate.call({ getUpdate: () => update, setUpdate: (u) => { applied = u; } }, () => {});
      return applied;
    };
    assert.deepEqual(run({ $set: { status: "failed" } }).$min, { terminalStatusAt: T0 });
    assert.deepEqual(run({ $set: { status: "cancelled", x: 1 }, $min: { other: 1 } }).$min, { other: 1, terminalStatusAt: T0 });
    assert.equal(run({ $set: { status: "paid" } }).$min, undefined);
    assert.equal(run({ $set: { status: "pending" } }).$min, undefined);
    assert.equal(run({ $inc: { n: 1 } }).$min, undefined);
    assert.deepEqual(run({ status: "failed" }).$min, { terminalStatusAt: T0 });
  });

  test("save stamps once and never overwrites an existing stamp", () => {
    const schema = fakeSchema();
    applyTerminalStatusStamp(schema, ["cancelled", "failed"], { now: () => T0 });
    const earlier = new Date("2025-12-31T00:00:00Z");
    const fresh = { status: "failed", terminalStatusAt: undefined };
    schema.hooks.save.call(fresh, () => {});
    assert.equal(fresh.terminalStatusAt, T0);
    const again = { status: "failed", terminalStatusAt: earlier };
    schema.hooks.save.call(again, () => {});
    assert.equal(again.terminalStatusAt, earlier);
    const pending = { status: "pending" };
    schema.hooks.save.call(pending, () => {});
    assert.equal(pending.terminalStatusAt, undefined);
  });
});

describe("late notifications after cleanup", () => {
  const tombstone = { _id: "t1", provider: "nowpayments", orderId: "NP-late" };
  function fakeRes() {
    return { statusCode: null, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
  }
  async function deliver({ lookup, outcome = "unknown_order" }) {
    const payload = { order_id: "NP-late", payment_id: 11, payment_status: "finished" };
    const { signNowPaymentsIpn } = await import("../../services/nowpayments/signature.js");
    const secret = "s".repeat(40);
    const req = { rawBody: Buffer.from(JSON.stringify(payload)), headers: { "x-nowpayments-sig": signNowPaymentsIpn(payload, secret) }, get(name) { return this.headers[name.toLowerCase()]; } };
    const res = fakeRes();
    let credited = 0;
    const late = [];
    await handleNowPaymentsIpn(req, res, {
      secret,
      apply: async () => ({ outcome, credited: false }),
      notify: async () => { credited += 1; },
      lookupTombstone: lookup,
      recordLate: async (arg) => { late.push(arg); },
      bot: {},
    });
    return { res, credited, late };
  }

  test("a signed IPN for a removed invoice is acknowledged, recorded and never credited", async () => {
    const { res, credited, late } = await deliver({ lookup: async () => tombstone });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, "invoice_removed");
    assert.equal(credited, 0);
    assert.equal(late.length, 1);
    assert.equal(late[0].status, "finished");
  });

  test("an unknown order without a tombstone is still rejected", async () => {
    const { res } = await deliver({ lookup: async () => null });
    assert.equal(res.statusCode, 404);
  });

  test("a tombstone lookup failure asks the provider to retry instead of dropping the event", async () => {
    const { res } = await deliver({ lookup: async () => { throw new Error("db down"); } });
    assert.equal(res.statusCode, 503);
  });

  test("late events are appended to the tombstone with a bounded history", async () => {
    const model = makeMemoryModel([{ _id: "t1", lateEventCount: 0, lateEvents: [] }]);
    for (let i = 0; i < 12; i += 1) await recordLateEvent({ tombstone: { _id: "t1" }, status: "paid", tombstoneModel: model, now: NOW });
    assert.equal(model.docs[0].lateEventCount, 12);
    assert.equal(model.docs[0].lateEvents.length, 10);
    const found = await findTombstone({ provider: "hooshpay", orderId: null, uid: null, tombstoneModel: model });
    assert.equal(found, null, "no identifiers means no lookup");
  });
});
