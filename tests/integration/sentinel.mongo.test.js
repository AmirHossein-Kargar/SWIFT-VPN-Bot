/**
 * Money Flow Sentinel against a real, disposable MongoDB, with money moved by the REAL wallet functions. Only then do the
 * claims mean anything: that healthy flows raise nothing, that injected damage is found, that reruns are idempotent, that
 * a writer caught mid-step raises no false alert, and that no money collection changes by a single byte.
 */
import { test, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";

after(async () => { await disconnectTestDB(); });

const dbAvailable = await connectTestDB();
const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let mongoose, User, Hoosh, NowPayments, Crypto, Bank, WalletPurchase, Tombstone, Audit, Finding, Checkpoint;
let creditWalletOnce, reserveBalance, refundPurchaseReservation, commitProvisionedPurchase;
let runSentinelTick, evaluateUsers, readSentinelConfig, SENTINEL_JOB, queries, adminSentinel, loadBundles;

if (dbAvailable) {
  mongoose = (await import("mongoose")).default;
  ({ default: User } = await import("../../models/User.js"));
  ({ default: Hoosh } = await import("../../models/HooshPayInvoice.js"));
  ({ default: NowPayments } = await import("../../models/NowPaymentsInvoice.js"));
  ({ default: Crypto } = await import("../../models/CryptoInvoice.js"));
  ({ default: Bank } = await import("../../models/invoice.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: Tombstone } = await import("../../models/PaymentTombstone.js"));
  ({ default: Audit } = await import("../../models/AdminAuditLog.js"));
  ({ default: Finding } = await import("../../models/SentinelFinding.js"));
  ({ default: Checkpoint } = await import("../../models/JobCheckpoint.js"));
  ({ creditWalletOnce } = await import("../../services/walletCredit.js"));
  ({ reserveBalance, refundPurchaseReservation, commitProvisionedPurchase } = await import("../../services/buyService/purchaseLedger.js"));
  ({ runSentinelTick, evaluateUsers } = await import("../../services/sentinel/reconciler.js"));
  ({ readSentinelConfig, SENTINEL_JOB } = await import("../../services/sentinel/constants.js"));
  queries = await import("../../services/sentinel/queries.js");
  adminSentinel = await import("../../services/admin/sentinel.js");
  ({ loadBundles } = await import("../../services/sentinel/bundle.js"));
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms) => new Date(Date.now() - ms);
const config = () => readSentinelConfig({ SENTINEL_USERS_PER_TICK: "100" });
let serial = 0;
const nextUser = () => { serial += 1; return String(800_000_000 + serial); };
const operation = () => randomUUID();

async function newUser(extra = {}) {
  const telegramId = nextUser();
  await User.create({ telegramId, balance: 0, createdAt: ago(100 * HOUR), ...extra });
  return telegramId;
}

/** A top-up the way production does it: invoice first, atomic credit, then the invoice flag. */
async function topUp(telegramId, amount, { uid = `uid-${randomUUID()}`, extra = {} } = {}) {
  await Hoosh.create({ uid, orderId: `o-${uid}`, userId: Number(telegramId), amount, status: "paid", fulfilled: true, fulfilledAt: ago(3 * HOUR), paidAt: ago(3 * HOUR), creditLedgerVersion: 2, createdAt: ago(4 * HOUR), ...extra });
  await creditWalletOnce({ telegramId, amount, creditKey: `hooshpay:${uid}` });
  await Hoosh.updateOne({ uid }, { $set: { balanceCredited: true, balanceCreditedAt: ago(3 * HOUR) } });
  return uid;
}

/** An order the way production does it: row, atomic reserve, row update. */
async function buy(telegramId, amount, { status = "reserved" } = {}) {
  const purchaseId = randomUUID();
  await WalletPurchase.create({ purchaseId, telegramId, planId: "plan", planName: "Plan", gig: 10, days: 30, amount, status: "reserving", createdAt: ago(2 * HOUR) });
  const reserved = await reserveBalance(telegramId, amount, purchaseId);
  assert.equal(reserved.reserved, true);
  await WalletPurchase.updateOne({ purchaseId, status: "reserving" }, { $set: { status: "reserved", walletDebitStatus: "reserved", reservedAt: ago(2 * HOUR), walletDebitedAt: ago(2 * HOUR) } });
  if (status === "completed") {
    await WalletPurchase.updateOne({ purchaseId, status: "reserved" }, { $set: { status: "provisioning", provisioningStartedAt: ago(2 * HOUR) } });
    await WalletPurchase.updateOne({ purchaseId, status: "provisioning" }, { $set: { status: "provisioned", serviceUsername: `svc-${purchaseId.slice(0, 8)}`, provisionedAt: ago(2 * HOUR) } });
    const row = await WalletPurchase.findOne({ purchaseId });
    await commitProvisionedPurchase(row, null);
  }
  return purchaseId;
}

const run = (userIds, options = {}) => runSentinelTick({ config: config(), userIds, ...options });
const open = (telegramId) => Finding.find({ userId: telegramId, state: "open" }).lean();
const openCodes = async (telegramId) => (await open(telegramId)).map((row) => row.code).sort();

const MONEY_MODELS = () => [User, Hoosh, NowPayments, Crypto, Bank, WalletPurchase, Tombstone];
async function fingerprintMoney() {
  const hash = createHash("sha256");
  for (const model of MONEY_MODELS()) {
    const rows = await model.collection.find({}).sort({ _id: 1 }).toArray();
    hash.update(model.modelName).update(JSON.stringify(rows));
  }
  return hash.digest("hex");
}

beforeEach(async () => {
  if (!dbAvailable) return;
  queries.resetSentinelCache();
  await Finding.deleteMany({});
  await Checkpoint.deleteMany({ name: SENTINEL_JOB });
});

describe("end-to-end flows", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  dbTest("a real top-up, purchase and refund leave nothing to report and a balance that reconstructs exactly", async () => {
    const id = await newUser();
    await topUp(id, 300_000);
    await buy(id, 100_000, { status: "completed" });
    const refundable = await buy(id, 50_000);
    await refundPurchaseReservation({ purchaseId: refundable, telegramId: id, amount: 50_000 }, { reason: "TEST" });
    const summary = await run([id]);
    assert.equal(summary.error, null);
    assert.deepEqual(await openCodes(id), []);
    const bundle = (await loadBundles([id], { config: config() })).get(id);
    const { reconstructBalance } = await import("../../services/sentinel/ledger.js");
    const result = reconstructBalance(bundle);
    assert.equal(result.balance, 200_000);
    assert.equal(result.drift, 0);
    assert.equal(result.coverage, "complete");
  });

  dbTest("a duplicate callback and concurrent credits stay a single credit, and nothing is reported", async () => {
    const id = await newUser();
    const uid = await topUp(id, 100_000);
    await Promise.all(Array.from({ length: 5 }, () => creditWalletOnce({ telegramId: id, amount: 100_000, creditKey: `hooshpay:${uid}` })));
    assert.equal((await User.findOne({ telegramId: id }).lean()).balance, 100_000);
    await run([id]);
    assert.deepEqual(await openCodes(id), []);
  });
});

describe("injected damage is found", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  dbTest("a direct balance edit (a duplicated credit in effect) shows as confirmed drift of the exact amount", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 100_000 } });
    await run([id]);
    const [finding] = await open(id);
    assert.equal(finding.code, "BALANCE_DRIFT");
    assert.equal(finding.classification, "confirmed");
    assert.equal(finding.amountToman, 100_000);
    assert.equal(finding.direction, "excess_in_wallet");
  });

  dbTest("a missing credit, an unexplained ledger key and a kept debit are each reported once", async () => {
    const id = await newUser();
    await Hoosh.create({ uid: `missing-${id}`, orderId: `om-${id}`, userId: Number(id), amount: 70_000, status: "paid", fulfilled: true, paidAt: ago(3 * HOUR), creditLedgerVersion: 2, createdAt: ago(4 * HOUR) });
    await User.updateOne({ telegramId: id }, { $addToSet: { appliedPaymentKeys: "hooshpay:ghost" }, $inc: { successfulPayments: 1 } });
    const kept = randomUUID();
    await WalletPurchase.collection.insertOne({ purchaseId: kept, telegramId: id, planId: "p", planName: "P", gig: 1, days: 1, amount: 20_000, status: "failed", walletDebitStatus: "reserved", createdAt: ago(3 * HOUR), events: [] });
    await User.updateOne({ telegramId: id }, { $addToSet: { appliedPurchaseReservations: kept }, $inc: { balance: -20_000 } });
    await run([id]);
    const codes = await openCodes(id);
    assert.ok(codes.includes("CONFIRMED_NOT_CREDITED"));
    assert.ok(codes.includes("LEDGER_KEY_WITHOUT_PAYMENT"));
    assert.ok(codes.includes("FAILED_ORDER_DEBIT_KEPT"));
  });

  dbTest("a repaired problem clears itself and keeps its history; if it returns, it reopens", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 5_000 } });
    await run([id]);
    assert.equal((await open(id)).length, 1);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: -5_000 } });
    const later = await run([id]);
    assert.equal(later.cleared, 1);
    const cleared = await Finding.findOne({ userId: id }).lean();
    assert.equal(cleared.state, "cleared");
    assert.ok(cleared.expireAt instanceof Date);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 5_000 } });
    await run([id]);
    const reopened = await Finding.find({ userId: id }).lean();
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].state, "open");
    assert.equal(reopened[0].reopenCount, 1);
    assert.equal(reopened[0].expireAt, null);
  });

  dbTest("a compensating entry leaves history alone: the record stays, the dismissal names it, new drift reopens it", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: -30_000 } });
    await run([id]);
    assert.deepEqual(await openCodes(id), ["BALANCE_DRIFT"]);
    const [row] = await open(id);
    const { changeUserBalance } = await import("../../services/admin/users.js");
    const compensation = operation();
    await changeUserBalance({ actorId: "424242", operationId: compensation, telegramId: id, amount: 30_000, direction: "add", reason: "Compensating entry" });
    assert.equal((await User.findOne({ telegramId: id }).lean()).balance, 100_000);
    await run([id]);
    assert.deepEqual(await openCodes(id), ["BALANCE_DRIFT"], "the unlogged -30,000 happened; a later entry does not unwrite it");
    await adminSentinel.updateSentinelFindingReview({ actorId: "424242", operationId: operation(), id: String(row._id), review: "false_positive", reason: `Compensated by operation ${compensation.slice(0, 8)}` });
    await run([id]);
    assert.equal((await Finding.findById(row._id).lean()).review, "false_positive");
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: -1 } });
    await run([id]);
    assert.equal((await Finding.findById(row._id).lean()).review, "new", "a dismissal covers the evidence it was made on, not a new difference");
  });
});

describe("idempotence, concurrency and scale", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  dbTest("rerunning changes nothing: one row per problem, same evidence", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 1_000 } });
    await run([id]);
    const first = await open(id);
    for (let index = 0; index < 3; index += 1) await run([id]);
    const second = await open(id);
    assert.equal(second.length, 1);
    assert.equal(second[0].evidenceHash, first[0].evidenceHash);
    assert.equal(second[0].firstDetectedAt.getTime(), first[0].firstDetectedAt.getTime());
    assert.equal(second[0].detections, first[0].detections, "an unchanged finding is not rewritten");
  });

  dbTest("concurrent evaluators raise one row, never two", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 1_000 } });
    await Promise.all(Array.from({ length: 6 }, () => evaluateUsers([id], { config: config() })));
    assert.equal(await Finding.countDocuments({ userId: id }), 1);
  });

  dbTest("two ticks cannot run at once: the second loses the lease", async () => {
    const id = await newUser();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = { ...(await import("../../services/sentinel/readOnly.js")).readOnlySources() };
    const first = runSentinelTick({ config: config(), userIds: [id], sources: new Proxy(slow, { get: (target, key) => (key === "users" ? { find: (...args) => { const query = target.users.find(...args); return { select: (fields) => ({ lean: () => ({ maxTimeMS: async () => { await gate; return query.select(fields).lean().maxTimeMS(8000); } }) }) }; } } : target[key]) }) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await runSentinelTick({ config: config(), userIds: [id] });
    assert.equal(second.skipped, "lease_unavailable");
    release();
    await first;
  });

  dbTest("a writer caught between its two steps raises no false alert", async () => {
    const id = await newUser();
    const uid = `race-${id}`;
    await Hoosh.create({ uid, orderId: `or-${id}`, userId: Number(id), amount: 40_000, status: "pending", createdAt: ago(HOUR) });
    await creditWalletOnce({ telegramId: id, amount: 40_000, creditKey: `hooshpay:${uid}` });
    // The credit landed but the invoice has not moved yet. The first read sees a credit on a pending invoice...
    const { readOnlySources } = await import("../../services/sentinel/readOnly.js");
    const real = readOnlySources();
    let loads = 0;
    const sources = new Proxy({ ...real }, {
      get(target, key) {
        if (key !== "users") return target[key];
        return {
          find: (...args) => {
            loads += 1;
            if (loads > 1) return target.users.find(...args);
            // ...and the writer finishes before the confirming second read.
            return { select: (fields) => ({ lean: () => ({ maxTimeMS: async () => {
              const rows = await target.users.find(...args).select(fields).lean().maxTimeMS(8000);
              await Hoosh.updateOne({ uid }, { $set: { status: "paid", fulfilled: true, paidAt: new Date(), balanceCredited: true, balanceCreditedAt: new Date(), creditLedgerVersion: 2 } });
              return rows;
            } }) }) };
          },
        };
      },
    });
    const result = await evaluateUsers([id], { sources, config: config() });
    assert.ok(loads >= 2, "a new finding must be read twice");
    assert.ok(result.deferred >= 1, "the first read did see it");
    assert.deepEqual(await openCodes(id), []);
  });

  dbTest("a large backlog of informational findings cannot crowd out a live problem", async () => {
    const legacy = Array.from({ length: 30 }, (_, index) => `77${String(index).padStart(7, "0")}`);
    await Finding.insertMany(legacy.map((userId, index) => ({ fingerprint: `BALANCE_DRIFT:user:${userId}`, code: "BALANCE_DRIFT", category: "wallet", classification: "informational", severity: "info", rank: 4, userId, subjectType: "wallet", subjectKey: `user:${userId}`, lastCheckedAt: ago((index + 1) * HOUR) })));
    const probable = await newUser();
    await Finding.create({ fingerprint: `LEDGER_KEY_WITHOUT_PAYMENT:user:${probable}:x`, code: "LEDGER_KEY_WITHOUT_PAYMENT", category: "wallet", classification: "probable", severity: "high", rank: 1, userId: probable, subjectType: "wallet", subjectKey: `user:${probable}:x`, lastCheckedAt: ago(HOUR) });
    const { collectPriorityUsers, TICK_DEFAULTS } = await import("../../services/sentinel/reconciler.js");
    const { readOnlySources } = await import("../../services/sentinel/readOnly.js");
    const picked = await collectPriorityUsers({ sources: readOnlySources(), now: new Date(), limits: { ...TICK_DEFAULTS, priorityUsers: 5 } });
    assert.ok(picked.includes(probable));
    assert.ok(legacy.every((id) => !picked.includes(id)));
    await Finding.deleteMany({});
  });

  dbTest("the rolling pass walks every user, resumes from its cursor and wraps", async () => {
    await Finding.deleteMany({});
    const total = await User.countDocuments({});
    const small = readSentinelConfig({ SENTINEL_USERS_PER_TICK: "10" });
    let seen = 0;
    let wrapped = false;
    for (let index = 0; index < total + 2 && !wrapped; index += 1) {
      const summary = await runSentinelTick({ config: small, priorityUsers: 0 });
      seen += summary.rolling;
      wrapped = summary.wrapped;
    }
    assert.equal(wrapped, true);
    assert.equal(seen, total);
    const checkpoint = await Checkpoint.findOne({ name: SENTINEL_JOB }).lean();
    assert.equal(checkpoint.state.cursor, null);
    assert.ok(checkpoint.state.lastPassCompletedAt);
  });

  dbTest("a failing tick records the failure, keeps its cursor and is shown as delayed", async () => {
    await runSentinelTick({ config: config(), priorityUsers: 0 });
    const broken = { ...(await import("../../services/sentinel/readOnly.js")).readOnlySources(), users: { find: () => { throw Object.assign(new Error("boom"), { name: "MongoNetworkError" }); } } };
    const summary = await runSentinelTick({ config: config(), sources: broken, priorityUsers: 0, userIds: undefined });
    assert.equal(summary.error, "MongoNetworkError");
    const sync = await queries.getSyncStatus({ config: config() });
    assert.equal(sync.lastError, "MongoNetworkError");
    assert.equal(sync.consecutiveFailures, 1);
    assert.equal(sync.health, "delayed");
  });

  dbTest("the indexes serve the feed, the refunds and the tracking lookup", async () => {
    const explain = async (query) => JSON.stringify(await query.explain("queryPlanner"));
    assert.match(await explain(Hoosh.find({ balanceCreditedAt: { $gte: ago(HOUR) } })), /idx_sentinel_credited/);
    assert.match(await explain(WalletPurchase.find({ refundedAt: { $gte: ago(HOUR) } })), /idx_sentinel_refunded/);
    assert.match(await explain(Hoosh.find({ trackingCode: { $in: ["x"] } })), /idx_sentinel_tracking/);
    assert.match(await explain(Tombstone.find({ lateEventCount: { $gt: 0 } })), /idx_sentinel_tombstone_late/);
    assert.match(await explain(Finding.find({ state: "open" }).sort({ state: 1, rank: 1, firstDetectedAt: -1, _id: -1 })), /idx_sentinel_list/);
  });
});

describe("no automatic mutation", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  dbTest("detection, every read view and every review leave all money collections byte-identical", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 25_000 } });
    const stuck = await buy(id, 10_000);
    await WalletPurchase.collection.updateOne({ purchaseId: stuck }, { $set: { status: "manual_review", errorCode: "PANEL_RESULT_UNKNOWN" } });
    const before = await fingerprintMoney();

    await run([id]);
    await runSentinelTick({ config: config() });
    const actorId = "424242";
    await adminSentinel.getSentinelOverview({ actorId, query: { range: "30d" } });
    await adminSentinel.getSentinelFlow({ actorId, query: {} });
    await adminSentinel.getSentinelLive({ actorId, query: {} });
    const page = await adminSentinel.listSentinelTransactions({ actorId, query: { userId: id } });
    await adminSentinel.getSentinelTransaction({ actorId, key: page.items[0].key });
    const findings = await adminSentinel.listSentinelFindings({ actorId, query: { userId: id } });
    assert.ok(findings.items.length >= 2);
    for (const item of findings.items) {
      const detail = await adminSentinel.getSentinelFinding({ actorId, id: item.id });
      await adminSentinel.updateSentinelFindingReview({ actorId, operationId: operation(), id: item.id, review: "investigating", reason: "Looking at this one now" });
      await adminSentinel.updateSentinelFindingReview({ actorId, operationId: operation(), id: item.id, review: "remediation_proposed", optionId: detail.explanation.options[0].id, reason: "Proposed after checking the records" });
    }
    await adminSentinel.runSentinelReconciliation({ actorId, operationId: operation(), userId: id });

    assert.equal(await fingerprintMoney(), before);
  });
});

describe("review rules", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  const actorId = "424242";

  async function driftFinding() {
    const id = await newUser();
    await topUp(id, 100_000);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 1_000 } });
    await run([id]);
    const [row] = await open(id);
    return { id, row };
  }

  dbTest("a problem that still reproduces cannot be marked resolved", async () => {
    const { row } = await driftFinding();
    await assert.rejects(
      adminSentinel.updateSentinelFindingReview({ actorId, operationId: operation(), id: String(row._id), review: "resolved", reason: "It looks fine to me" }),
      (error) => error.code === "finding_still_reproduces" && error.status === 409,
    );
    assert.equal((await Finding.findById(row._id).lean()).review, "new");
  });

  dbTest("once the records are right it can, and it is audited with the actor", async () => {
    const { id, row } = await driftFinding();
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: -1_000 } });
    const operationId = operation();
    const result = await adminSentinel.updateSentinelFindingReview({ actorId, operationId, id: String(row._id), review: "resolved", reason: "Balance repaired by hand" });
    assert.equal(result.review, "resolved");
    const audit = await Audit.findOne({ operationId }).lean();
    assert.equal(audit.action, "SENTINEL_FINDING_REVIEWED");
    assert.equal(audit.status, "succeeded");
    const stored = await Finding.findById(row._id).lean();
    assert.equal(stored.reviewHistory.length, 1);
    assert.equal(stored.reviewHistory[0].actor, actorId);
  });

  dbTest("a proposal must name an option the server offers now", async () => {
    const { row } = await driftFinding();
    await assert.rejects(
      adminSentinel.updateSentinelFindingReview({ actorId, operationId: operation(), id: String(row._id), review: "remediation_proposed", optionId: "delete_everything", reason: "Do something drastic" }),
      (error) => error.code === "invalid_option",
    );
  });

  dbTest("the same operationId replays instead of acting twice", async () => {
    const { row } = await driftFinding();
    const operationId = operation();
    await adminSentinel.updateSentinelFindingReview({ actorId, operationId, id: String(row._id), review: "investigating", reason: "Opening the investigation" });
    await adminSentinel.updateSentinelFindingReview({ actorId, operationId, id: String(row._id), review: "investigating", reason: "Opening the investigation" });
    assert.equal((await Finding.findById(row._id).lean()).reviewHistory.length, 1);
  });

  dbTest("two admins cannot overwrite each other unseen", async () => {
    const { row } = await driftFinding();
    const results = await Promise.allSettled(["a", "b"].map(() => adminSentinel.updateSentinelFindingReview({ actorId, operationId: operation(), id: String(row._id), review: "investigating", reason: "Taking this one over" })));
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal((await Finding.findById(row._id).lean()).reviewHistory.length, 1);
  });

  dbTest("a dismissed finding leaves the exposure, and a reappearing one stays dismissed", async () => {
    const { id, row } = await driftFinding();
    await adminSentinel.updateSentinelFindingReview({ actorId, operationId: operation(), id: String(row._id), review: "false_positive", reason: "Known manual gift from the owner" });
    assert.equal((await queries.findingSummary()).exposure.excessInWallets, 0);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: -1_000 } });
    await run([id]);
    await User.collection.updateOne({ telegramId: id }, { $inc: { balance: 1_000 } });
    await run([id]);
    assert.equal((await Finding.findById(row._id).lean()).review, "false_positive");
  });
});

describe("read views", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  const actorId = "424242";

  dbTest("the live feed is incremental, deduplicated and tolerates overlap", async () => {
    const id = await newUser();
    await topUp(id, 90_000);
    const first = await adminSentinel.getSentinelLive({ actorId, query: { since: ago(5 * HOUR).toISOString() } });
    const ids = first.events.map((event) => event.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(first.events.some((event) => event.stage === "credited"));
    const later = await adminSentinel.getSentinelLive({ actorId, query: { since: first.nextSince } });
    assert.ok(later.events.every((event) => !ids.includes(event.id) || event.at >= first.nextSince));
  });

  dbTest("a source that fails degrades the feed instead of failing it", async () => {
    const { readOnlySources } = await import("../../services/sentinel/readOnly.js");
    const real = readOnlySources();
    const sources = new Proxy({ ...real }, { get: (target, key) => (key === "trx" ? { find: () => { throw new Error("down"); } } : target[key]) });
    const result = await queries.getLiveEvents({ sources });
    assert.ok(result.degraded.some((name) => name.startsWith("trx")));
    assert.ok(Array.isArray(result.events));
  });

  dbTest("transactions page by keyset without repeats, across providers", async () => {
    const id = await newUser();
    for (let index = 0; index < 7; index += 1) await topUp(id, 10_000 + index);
    await buy(id, 5_000);
    const seen = [];
    let before = "";
    for (let page = 0; page < 5; page += 1) {
      const result = await adminSentinel.listSentinelTransactions({ actorId, query: { userId: id, pageSize: "3", before } });
      seen.push(...result.items.map((item) => item.key));
      if (!result.nextBefore) break;
      before = result.nextBefore;
    }
    assert.equal(seen.length, 8);
    assert.equal(new Set(seen).size, 8);
  });

  dbTest("filters narrow the list", async () => {
    const id = await newUser();
    await topUp(id, 12_345);
    await buy(id, 2_000);
    const byProvider = await adminSentinel.listSentinelTransactions({ actorId, query: { userId: id, provider: "wallet" } });
    assert.ok(byProvider.items.every((item) => item.provider === "wallet"));
    const byAmount = await adminSentinel.listSentinelTransactions({ actorId, query: { userId: id, minAmount: "12000", maxAmount: "13000" } });
    assert.deepEqual(byAmount.items.map((item) => item.amount), [12_345]);
    const byState = await adminSentinel.listSentinelTransactions({ actorId, query: { userId: id, state: "credited" } });
    assert.ok(byState.items.every((item) => item.kind === "payment"));
  });

  dbTest("the transaction view links payment, wallet and order without inventing a link, and leaks nothing", async () => {
    const id = await newUser();
    const uid = await topUp(id, 100_000, { extra: { cardNumber: "CARD-FIXTURE", cardHolder: "HOLDER-FIXTURE", paymentUrl: "https://example.test/secret" } });
    const detail = await adminSentinel.getSentinelTransaction({ actorId, key: `hooshpay:${uid}` });
    assert.deepEqual(detail.flow.map((item) => item.stage), ["initiated", "confirmed", "credited"]);
    assert.ok(detail.flow.every((item) => item.state === "done"));
    assert.equal(detail.relationships[0].basis, "recorded");
    assert.equal(detail.wallet.coverage, "complete");
    const text = JSON.stringify(detail);
    for (const secret of ["CARD-FIXTURE", "HOLDER-FIXTURE", "example.test"]) assert.ok(!text.includes(secret), secret);
  });

  dbTest("the overview counts money once and the flow stages are subsets", async () => {
    const id = await newUser();
    await topUp(id, 100_000);
    await buy(id, 40_000, { status: "completed" });
    const overview = await adminSentinel.getSentinelOverview({ actorId, query: { range: "7d" } });
    assert.ok(overview.activity.totals.inflow.amount >= 100_000);
    assert.deepEqual(overview.degraded, []);
    const flow = await adminSentinel.getSentinelFlow({ actorId, query: { range: "7d" } });
    for (const provider of flow.payments) {
      assert.ok(provider.confirmed.count <= provider.initiated.count);
      assert.ok(provider.credited.count <= provider.confirmed.count + provider.initiated.count);
    }
    assert.ok(flow.orders.fulfilled.count <= flow.orders.reserved.count);
  });

  dbTest("an investigation explains, revalidates and counts impact once", async () => {
    const id = await newUser();
    await Hoosh.create({ uid: `lost-${id}`, orderId: `ol-${id}`, userId: Number(id), amount: 50_000, status: "paid", fulfilled: true, paidAt: ago(3 * HOUR), creditLedgerVersion: 2, createdAt: ago(4 * HOUR) });
    await run([id]);
    const [row] = (await open(id)).filter((item) => item.code === "CONFIRMED_NOT_CREDITED");
    const detail = await adminSentinel.getSentinelFinding({ actorId, id: String(row._id) });
    assert.equal(detail.revalidation.stillReproduces, true);
    assert.equal(detail.classification, "confirmed");
    assert.ok(detail.explanation.why);
    assert.ok(detail.explanation.likelyCause);
    assert.ok(detail.explanation.options.some((option) => option.id === "retry_payment"));
    assert.ok(detail.timeline.length >= 2);
    assert.ok(detail.timeline.every((event, index, all) => index === 0 || all[index - 1].at <= event.at));
    assert.equal(detail.impact.customer.owedToCustomers, 50_000);
  });

  dbTest("a legacy wallet is labelled, not accused", async () => {
    const id = await newUser({ createdAt: new Date("2026-01-01T00:00:00Z"), balance: 77_000, successfulPayments: 4 });
    await run([id]);
    const [row] = await open(id);
    assert.equal(row.code, "BALANCE_DRIFT");
    assert.equal(row.classification, "informational");
    assert.equal(row.facts.coverage, "partial");
  });

  dbTest("audit rows drive reconstruction of admin adjustments", async () => {
    const id = await newUser();
    const { changeUserBalance } = await import("../../services/admin/users.js");
    await changeUserBalance({ actorId, operationId: operation(), telegramId: id, amount: 8_000, direction: "add", reason: "Goodwill credit" });
    await run([id]);
    assert.deepEqual(await openCodes(id), []);
  });
});
