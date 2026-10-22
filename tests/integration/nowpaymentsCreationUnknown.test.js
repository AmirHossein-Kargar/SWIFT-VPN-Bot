/**
 * NOWPayments `creation_unknown` recovery and the audited lock release, on a REAL MongoDB (compare-and-set,
 * unique sparse index and $or/$lte semantics are what is being proven). The provider is a mock; nothing here calls
 * NOWPayments, Telegram or any other network. Needs the guarded test database (tests/helpers/db.js); skips otherwise.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";
const ADMIN = "424242";
const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let User, Now, AuditLog, release, payments, lookup, apply, createInvoice, catalogModule, clientModule;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: Now } = await import("../../models/NowPaymentsInvoice.js"));
  ({ default: AuditLog } = await import("../../models/AdminAuditLog.js"));
  release = await import("../../services/admin/creationUnknown.js");
  payments = await import("../../services/admin/payments.js");
  lookup = await import("../../services/nowpayments/creationLookup.js");
  apply = await import("../../services/nowpayments/applyStatus.js");
  createInvoice = await import("../../services/nowpayments/createInvoice.js");
  catalogModule = await import("../../services/nowpayments/catalog.js");
  clientModule = await import("../../services/nowpayments/nowpaymentsClient.js");
  await Promise.all([User, Now, AuditLog].map((model) => model.init()));
}
after(async () => { await disconnectTestDB(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await Promise.all([User, Now, AuditLog].map((model) => model.deleteMany({})));
  clientModule.resetNowPaymentsAuthCacheForTests();
});

const ORDER = "NP-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - 60 * 60_000);
const KEY = `nowpayments:${ORDER}`;
let n = 0;
const op = () => `creation-unknown-op-${String(++n).padStart(6, "0")}`;
const ENV = { NOWPAYMENTS_API_KEY: "k".repeat(24), NOWPAYMENTS_IPN_SECRET: "s".repeat(40), NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn" };

const parkedFields = (extra = {}) => ({
  orderId: ORDER, userId: 9800, amountToman: 50_000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "trx", tomanPerFiat: 50_000,
  rateSource: "test", invoiceId: "6400", status: "creation_unknown", openCreateKey: "user:9800", recoveryStatus: "required",
  recoveryReason: "provider_creation_outcome_unknown", createdAt: OLD, updatedAt: OLD, ...extra,
});
const payment = (extra = {}) => ({
  payment_id: 7400, invoice_id: 6400, order_id: ORDER, payment_status: "finished", price_amount: 1, price_currency: "usd",
  pay_amount: 30, actually_paid: 30, pay_currency: "trx", ...extra,
});
function client(items = [], { fail = false } = {}) {
  const request = async (o) => {
    if (o.path === "/auth") return { status: 200, data: { token: "jwt-for-tests" } };
    if (fail) return { status: 503, data: {} };
    const q = new URL(`https://x${o.path}`).searchParams;
    const rows = q.get("invoiceId") ? items.filter((p) => String(p.invoice_id) === q.get("invoiceId")) : items;
    return { status: 200, data: { data: rows } };
  };
  return clientModule.createNowPaymentsClient({ apiKey: ENV.NOWPAYMENTS_API_KEY, email: "owner@example.test", password: "unit-test-password-0001", request, readRetries: 0 });
}
const balance = async () => (await User.findOne({ telegramId: "9800" }).lean()).balance;
const doRelease = (extra = {}) => release.releaseCreationUnknownLock({ actorId: ADMIN, operationId: op(), key: KEY, reason: "customer never received the link; verified in dashboard", now: () => NOW, ...extra });
const seed = async (fields = {}) => {
  await User.create({ telegramId: "9800", balance: 10 });
  await Now.create(parkedFields(fields));
};

describe("lock release workflow (audited, never a generic resolve)", () => {
  skip("releases a verified-empty order: creation_failed, both lock mechanisms cleared, audited, no money moved", async () => {
    await seed();
    const out = await doRelease({ client: client([]) });
    assert.deepEqual([out.released, out.verifiedWithProvider, out.financialMutation], [true, true, false]);
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.status, "creation_failed");
    assert.equal(row.openCreateKey, undefined);
    assert.equal(row.recoveryStatus, "resolved");
    assert.equal(row.recoveryResolvedBy, ADMIN);
    assert.equal(row.balanceCredited, false);
    assert.equal(await balance(), 10);
    const audit = await AuditLog.findOne({ action: "NOWPAYMENTS_CREATION_LOCK_RELEASED" }).lean();
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.actorTelegramId, ADMIN);
    assert.equal(audit.metadata.orderRef, ORDER.slice(-12));
    assert.equal(audit.metadata.acceptUnverified, false);
    assert.match(audit.metadata.reason, /verified in dashboard/);
  });

  skip("after the release the same user can open a new invoice, and before it the DB index itself blocks them", async () => {
    await seed();
    const dup = { ...parkedFields({ orderId: "NP-ffffffff-ffff-4fff-8fff-ffffffffffff", invoiceId: undefined, status: "creating" }) };
    await assert.rejects(() => Now.create(dup), (e) => e.code === 11000);
    await doRelease({ client: client([]) });
    await Now.create(dup);
    assert.equal(await Now.countDocuments({ userId: 9800 }), 2);

    // and the application-level guard agrees
    createInvoice.resetNowPaymentsCreateLocksForTests();
    await Now.deleteOne({ orderId: dup.orderId });
    const catalog = catalogModule.buildCatalogFromProviderData({ currencies: ["trx"], merchantCoins: ["trx"] });
    const posts = [];
    const request = async (o) => {
      if (o.path.startsWith("/min-amount")) return { status: 200, data: { min_amount: 0.1, fiat_equivalent: 0.01 } };
      if (o.path === "/currencies") return { status: 200, data: { currencies: ["trx"] } };
      posts.push(o.data);
      return { status: 201, data: { id: "6401", order_id: o.data.order_id, price_amount: String(o.data.price_amount), price_currency: "usd", pay_currency: "trx", invoice_url: "https://nowpayments.io/payment/?iid=6401" } };
    };
    const created = await createInvoice.createNowPaymentsTopUp({ userId: 9800, amountToman: 50_000, env: ENV, invoiceModel: Now, catalog, payCurrency: "trx", request, resolveRate: async () => ({ tomanPerFiat: 50_000, source: "t" }) });
    assert.equal(posts.length, 1);
    assert.equal(created.invoiceId, "6401");
  });

  skip("a payment found at release time is settled by the normal verifier and the lock is NOT released", async () => {
    await seed();
    // the real verifier credits through the real User model
    const out = await doRelease({ client: client([payment()]) });
    assert.equal(out.released, false);
    assert.equal(out.reason, "payment_found");
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.status, "finished");
    assert.equal(row.balanceCredited, true);
    assert.equal(await balance(), 50_010);
    // replaying the same lookup or an IPN credits nothing more
    await lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: client([payment()]), now: NOW });
    await apply.applyNowPaymentsUpdate({ payload: { ...payment(), payment_id: "7400", invoice_id: "6400" } });
    assert.equal(await balance(), 50_010);
  });

  skip("refusals leave the order exactly as it was", async () => {
    const cases = [
      ["too recent", { updatedAt: new Date(NOW.getTime() - 60_000), createdAt: new Date(NOW.getTime() - 60_000) }, {}, "too_recent"],
      ["payment bound", { paymentId: "7400" }, {}, "payment_bound"],
      ["not creation_unknown", { status: "pending", openCreateKey: undefined }, {}, "not_creation_unknown"],
      ["already credited", { balanceCredited: true }, {}, "already_credited"],
      ["provider data ambiguous", {}, { client: client([payment(), payment({ payment_id: 7401 })]) }, "provider_lookup_inconclusive"],
      ["provider data mismatched", {}, { client: client([payment({ order_id: "NP-99999999-9999-4999-8999-999999999999" })]) }, "provider_lookup_inconclusive"],
      ["lookup unavailable, no attestation", {}, { client: client([], { fail: true }) }, "provider_lookup_required"],
      ["lookup not configured, no attestation", {}, { client: null }, "provider_lookup_required"],
    ];
    for (const [name, fields, extra, code] of cases) {
      await Promise.all([User.deleteMany({}), Now.deleteMany({}), AuditLog.deleteMany({})]);
      clientModule.resetNowPaymentsAuthCacheForTests();
      await seed(fields);
      const before = await Now.findOne({ orderId: ORDER }).lean();
      await assert.rejects(() => doRelease(extra), (e) => e.status === 409 && e.code === code, name);
      const after = await Now.findOne({ orderId: ORDER }).lean();
      assert.deepEqual(after, before, `${name}: the order is untouched`);
      assert.equal(await balance(), 10, name);
      assert.equal((await AuditLog.findOne({ action: "NOWPAYMENTS_CREATION_LOCK_RELEASED" }).lean()).status, "failed", `${name}: the refused attempt is audited`);
    }
  });

  skip("with the lookup unavailable, an explicit attestation releases and is recorded as unverified", async () => {
    await seed();
    const out = await doRelease({ client: client([], { fail: true }), acceptUnverified: true });
    assert.equal(out.released, true);
    assert.equal(out.verifiedWithProvider, false);
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_failed");
    assert.equal((await AuditLog.findOne({ action: "NOWPAYMENTS_CREATION_LOCK_RELEASED" }).lean()).metadata.acceptUnverified, true);
  });

  skip("input and authorization are validated before anything is read or written", async () => {
    await seed();
    await assert.rejects(() => release.releaseCreationUnknownLock({ actorId: "111", operationId: op(), key: KEY, reason: "long enough reason", client: client([]) }), (e) => e.status === 403 || e.status === 401);
    await assert.rejects(() => doRelease({ key: "nowpayments:not-an-order" }), (e) => e.code === "invalid_payment_id");
    await assert.rejects(() => doRelease({ key: "hooshpay:abc" }), (e) => e.code === "invalid_payment_id");
    await assert.rejects(() => doRelease({ reason: "short", client: client([]) }), (e) => e.code === "invalid_reason");
    await assert.rejects(() => doRelease({ operationId: "x", client: client([]) }), (e) => e.code === "invalid_idempotency_key");
    await assert.rejects(() => doRelease({ key: "nowpayments:NP-00000000-0000-4000-8000-000000000000", client: client([]) }), (e) => e.code === "payment_not_found");
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_unknown");
  });

  skip("the generic resolve cannot silently release or hide the lock", async () => {
    await seed();
    await assert.rejects(
      () => payments.resolvePaymentRecovery({ actorId: ADMIN, operationId: op(), key: KEY, reason: "looked fine to me, closing it out" }),
      (e) => e.status === 409 && e.code === "use_creation_lock_release",
    );
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.status, "creation_unknown");
    assert.equal(row.recoveryStatus, "required");
    assert.equal(row.openCreateKey, "user:9800");
  });
});

describe("release rules for provider matching limits", () => {
  skip("a payment tied to our invoice but without an order_id blocks the release (held for a human), even with the attestation", async () => {
    await seed();
    const before = await Now.findOne({ orderId: ORDER }).lean();
    for (const attest of [false, true]) {
      await assert.rejects(
        () => doRelease({ client: client([payment({ order_id: null })]), acceptUnverified: attest }),
        (e) => e.status === 409 && e.code === "provider_lookup_inconclusive",
        `attested=${attest}`,
      );
    }
    assert.deepEqual(await Now.findOne({ orderId: ORDER }).lean(), before);
    assert.equal(await balance(), 10);
  });

  skip("with no recorded invoice id an empty lookup is not verification: the attestation is required", async () => {
    await seed({ invoiceId: undefined });
    await assert.rejects(() => doRelease({ client: client([]) }), (e) => e.status === 409 && e.code === "provider_lookup_required");
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_unknown");
    const out = await doRelease({ client: client([]), acceptUnverified: true });
    assert.deepEqual([out.released, out.verifiedWithProvider], [true, false]);
  });

  skip("a verified-empty lookup still needs the administrator's explicit request: the cron never releases", async () => {
    await seed({ nextRetryAt: null });
    for (let i = 0; i < 3; i += 1) {
      await lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: client([]), now: new Date(NOW.getTime() + i * 11 * 60_000) });
    }
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.status, "creation_unknown");
    assert.equal(row.openCreateKey, "user:9800");
    assert.equal(row.recoveryStatus, "required");
  });
});

describe("what the admin panel is offered", () => {
  skip("a creation_unknown order exposes the read-only check and the release, but not the generic resolve or a plain retry", async () => {
    await seed();
    const detail = await payments.getPaymentDetail({ actorId: ADMIN, key: KEY });
    assert.equal(detail.actions.checkProvider, true);
    assert.equal(detail.actions.releaseCreationLock, true);
    assert.equal(detail.actions.manualResolve, false, "the generic resolve is refused for these orders, so it is not offered");
    assert.equal(detail.actions.retryFulfillment, false);
    assert.equal(detail.actions.retryVerification, false);
    assert.equal(detail.actions.providerLookupConfigured, false);
    assert.equal(new Date(detail.actions.releaseAvailableAt).getTime(), OLD.getTime() + release.MIN_RELEASE_AGE_MS);
    assert.ok(detail.timeline.some((e) => e.name === "Invoice creation result unknown" && e.status === "warning"));
    const raw = JSON.stringify(detail);
    assert.equal(raw.includes("jwt"), false);
  });

  skip("settled, bound or terminal orders offer neither action", async () => {
    for (const fields of [{ paymentId: "7400" }, { balanceCredited: true }, { status: "waiting", openCreateKey: undefined }, { status: "creation_failed", openCreateKey: undefined }]) {
      await Promise.all([User.deleteMany({}), Now.deleteMany({})]);
      await seed(fields);
      const detail = await payments.getPaymentDetail({ actorId: ADMIN, key: KEY });
      assert.ok(!detail.actions.releaseCreationLock, JSON.stringify(fields));
      assert.ok(!detail.actions.checkProvider, JSON.stringify(fields));
    }
  });

  skip("the other providers' recovery orders still offer the generic resolve", async () => {
    await seed({ status: "waiting", openCreateKey: undefined, paymentId: "7400", recoveryStatus: "required" });
    const detail = await payments.getPaymentDetail({ actorId: ADMIN, key: KEY });
    assert.equal(detail.actions.manualResolve, true);
    assert.ok(!detail.actions.releaseCreationLock);
    assert.equal("releaseCreationLock" in detail.actions, false, "other states keep the exact original payload shape");
  });
});

describe("races", () => {
  skip("the release write is compare-and-set: any change between the read and the write defeats it", async () => {
    const interleavings = [
      ["an IPN bound a payment id", { $set: { paymentId: "7400" } }],
      ["the order was credited", { $set: { balanceCredited: true } }],
      ["the order moved on", { $set: { status: "waiting" }, $unset: { openCreateKey: 1 } }],
    ];
    for (const [name, change] of interleavings) {
      await Promise.all([User.deleteMany({}), Now.deleteMany({}), AuditLog.deleteMany({})]);
      await seed();
      const racing = {
        findOne: (...args) => Now.findOne(...args),
        updateOne: async (filter, update) => {
          await Now.updateOne({ orderId: ORDER }, change); // lands after the admin's read, before the admin's write
          return Now.updateOne(filter, update);
        },
      };
      await assert.rejects(() => doRelease({ client: client([]), invoiceModel: racing }), (e) => e.status === 409 && e.code === "state_changed", name);
      const row = await Now.findOne({ orderId: ORDER }).lean();
      assert.notEqual(row.status, "creation_failed", name);
      assert.notEqual(row.recoveryStatus, "resolved", name);
    }
  });

  skip("two admins releasing at once: exactly one wins, the other is refused, one money-neutral transition", async () => {
    await seed();
    const settled = await Promise.allSettled([doRelease({ client: client([]), operationId: op() }), doRelease({ client: client([]), operationId: op() }), doRelease({ client: client([]), operationId: op() })]);
    assert.equal(settled.filter((r) => r.status === "fulfilled" && r.value.released && !r.value.replayed).length, 1);
    for (const r of settled.filter((x) => x.status === "rejected")) assert.ok(["not_creation_unknown", "state_changed"].includes(r.reason.code), r.reason.code);
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_failed");
    assert.equal(await balance(), 10);
  });

  skip("a crash after the release write but before the audit finalised is resumed, not repeated; a NEW operation is refused", async () => {
    await seed({ status: "creation_failed", openCreateKey: undefined, recoveryStatus: "resolved", recoveryResolvedBy: ADMIN });
    const id = op();
    await AuditLog.create({ operationId: id, actorTelegramId: ADMIN, action: "NOWPAYMENTS_CREATION_LOCK_RELEASED", targetType: "payment", targetId: "x", metadata: {} });
    const resumed = await doRelease({ client: client([]), operationId: id });
    assert.deepEqual([resumed.released, resumed.replayed], [true, true]);
    assert.equal((await AuditLog.findOne({ operationId: id }).lean()).status, "succeeded");
    await assert.rejects(() => doRelease({ client: client([]), operationId: op() }), (e) => e.status === 409 && e.code === "not_creation_unknown");
  });

  skip("the same operation id replays instead of repeating", async () => {
    await seed();
    const id = op();
    const first = await doRelease({ client: client([]), operationId: id });
    const second = await doRelease({ client: client([]), operationId: id });
    assert.equal(first.released, true);
    assert.equal(second.released, true);
    assert.equal(await AuditLog.countDocuments({ operationId: id }), 1);
  });

  skip("release racing a verified IPN never both releases and credits: either the money lands or the lock is released", async () => {
    let released = 0;
    let credited = 0;
    for (let round = 0; round < 25; round += 1) {
      await Promise.all([User.deleteMany({}), Now.deleteMany({}), AuditLog.deleteMany({})]);
      await seed();
      const ipn = { ...payment(), payment_id: "7400", invoice_id: "6400" };
      const [rel, ipnResult] = await Promise.allSettled([doRelease({ client: client([]) }), apply.applyNowPaymentsUpdate({ payload: ipn })]);
      const row = await Now.findOne({ orderId: ORDER }).lean();
      const bal = await balance();
      // never money AND a "failed creation" at the same time, never a double credit
      assert.ok(!(row.status === "creation_failed" && row.balanceCredited), "released and credited");
      assert.ok(bal === 10 || bal === 50_010, `balance ${bal}`);
      assert.equal(bal === 50_010, row.balanceCredited === true, "balance and flag agree");
      if (row.status === "creation_failed") {
        released += 1;
        // the IPN lost: it must have been refused/flagged, never credited
        assert.equal(row.balanceCredited, false);
        assert.equal(row.recoveryStatus, "required");
        assert.equal(row.recoveryReason, "ipn_after_rejected_create");
      } else {
        credited += 1;
        assert.equal(row.status, "finished");
        assert.equal(rel.status, "rejected");
      }
      assert.equal(ipnResult.status, "fulfilled");
    }
    assert.equal(released + credited, 25);
  });

  skip("concurrent lookups and duplicate IPNs credit a parked order once", async () => {
    await seed();
    const c = client([payment()]);
    const ipn = { ...payment(), payment_id: "7400", invoice_id: "6400" };
    await Promise.all([
      lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: c, now: NOW }),
      lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: c, now: NOW }),
      apply.applyNowPaymentsUpdate({ payload: ipn }),
      apply.applyNowPaymentsUpdate({ payload: ipn }),
    ]);
    assert.equal(await balance(), 50_010);
    const user = await User.findOne({ telegramId: "9800" }).lean();
    assert.deepEqual(user.appliedPaymentKeys, [`nowpayments:${ORDER}`]);
    assert.equal(user.successfulPayments, 1);
  });
});

describe("after a release, a late signed payment is held for a human", () => {
  skip("an IPN for a released order is never credited and is flagged", async () => {
    await seed();
    await doRelease({ client: client([]) });
    const out = await apply.applyNowPaymentsUpdate({ payload: { ...payment(), payment_id: "7400", invoice_id: "6400" } });
    assert.equal(out.credited, false);
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.balanceCredited, false);
    assert.equal(row.recoveryStatus, "required");
    assert.equal(await balance(), 10);
  });
});

describe("lookup bookkeeping on a real database", () => {
  skip("due rows are checked, stamped with a back-off, and not re-checked early", async () => {
    await seed({ nextRetryAt: null });
    const first = await lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: client([]), now: NOW });
    assert.equal(first.checked, 1);
    assert.equal(first.notFound, 1);
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.retryCount, 1);
    assert.equal(row.lastErrorCode, "no_payment_found");
    assert.ok(row.nextRetryAt > NOW);
    assert.equal(row.status, "creation_unknown");
    assert.equal(row.openCreateKey, "user:9800");
    const second = await lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: client([]), now: NOW });
    assert.equal(second.checked, 0);
    const later = await lookup.recoverCreationUnknownOrders({ invoiceModel: Now, client: client([]), now: new Date(NOW.getTime() + 11 * 60_000) });
    assert.equal(later.checked, 1);
  });

  skip("the admin retry action runs the read-only lookup for creation_unknown and never releases the lock", async () => {
    await seed();
    const plan = payments.retryPlan("nowpayments", await Now.findOne({ orderId: ORDER }).lean());
    assert.deepEqual(plan, { kind: "attempt", action: "lookup" });
    assert.equal(payments.retryPlan("nowpayments", { status: "waiting", paymentId: null }).kind, "refuse");
  });
});
