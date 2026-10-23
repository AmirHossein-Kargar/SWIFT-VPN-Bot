/**
 * D4: reconciliation of an unsettled API purchase must be durable, atomic and recoverable.
 *
 *  - A purchase stays unresolved unless a SUCCESSFULLY PERSISTED, VALID resolution row exists. A resolution row that
 *    is started, failed, interrupted or malformed never counts.
 *  - A resolution is one atomic insert (unique operationId) written already `succeeded`; a failed attempt leaves
 *    nothing behind, so it can simply be retried.
 *  - A leftover non-succeeded row from an earlier interrupted attempt is recovered with one conditional update that only
 *    one caller can win; two different outcomes can never both be recorded.
 *  - If the ledger cannot be written or verified, the purchase stays blocked and the admin is told to retry.
 *  - The original purchase record is never modified, and nothing is ever inferred from age, timeouts or partial writes.
 *
 * Fakes only: a persisted-vs-in-memory audit model with MongoDB-style equality/$in/$nin matching and conditional
 * updates, an in-memory session store and Telegram bot, and a stubbed provider client. No real database is contacted.
 */
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";
import { makeAuditModel } from "../helpers/fakeAuditModel.js";

process.env.ADMINS = "9001,9002";
process.env.GROUP_ID = "-100777";
process.env.WIZARD_API_URL = "https://wizard.invalid/api/v1";
process.env.VPN_API_KEY = "test-key";

const providerRequests = [];
let createBehavior;
const created = () => providerRequests.filter((request) => /create/.test(request.url));
const okService = () => ({ status: 200, data: { ok: true, result: { username: "svc_new", hash: "abc123" } } });
const providerStub = () => ({ request: async (options) => { providerRequests.push(options); return createBehavior(options); } });
mock.method(axios, "create", providerStub);

const { setSessionClientForTests, clearSessionClientForTests, setSession } = await import("../../config/sessionStore.js");
const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const { createApiService, resetApiPurchaseLocksForTests, setApiPurchaseDepsForTests } = await import("../../handlers/admin/apiServicePurchase.js");
const { resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js");
const ledger = await import("../../services/admin/apiPurchaseLedger.js");

const GROUP = -100777;
const OWNER = 9001;
const OTHER_ADMIN = 9002;
const pid = (n) => String(n).padStart(20, "a");
const DAY = 24 * 3600_000;

let sessions;
let bot;
let audit;

beforeEach(() => {
  process.env.ADMINS = "9001,9002";
  sessions = makeSessionClient();
  setSessionClientForTests(sessions);
  bot = makeFakeBot();
  audit = makeAuditModel();
  providerRequests.length = 0;
  createBehavior = okService;
  resetApiPurchaseLocksForTests();
  setApiPurchaseDepsForTests({ auditModel: audit });
  resetCallbackGuardForTests();
  mock.method(console, "error", () => {});
});

afterEach(() => {
  clearSessionClientForTests();
  mock.restoreAll();
  mock.method(axios, "create", providerStub);
});

const resolveRows = () => audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION);
const purchaseRow = (purchaseId) => audit.docs.get(ledger.purchaseOperationId(purchaseId));
const unresolved = async () => (await ledger.findUnresolvedApiPurchases({ auditModel: audit })).map((entry) => entry.purchaseId);
const resolve = (actorId, purchaseId, outcome) => ledger.resolveApiPurchase({ actorId, purchaseId, outcome, auditModel: audit });
const isResolveCreate = (fields) => fields.action === ledger.API_PURCHASE_RESOLVED_ACTION;
const query = (from, data, messageId = 50) => ({ id: `q-${from}-${Math.random()}`, from: { id: from }, data, message: { message_id: messageId, chat: { id: GROUP, type: "supergroup" } } });
const alerts = () => bot.of("answerCallbackQuery").map((call) => String(call.args[1]?.text || ""));
const edits = () => bot.of("editMessageText").map((call) => String(call.args[0]));

/** An unsettled purchase, as an ambiguous provider outcome leaves it. */
async function seedPurchase(purchaseId, { status = "failed", errorCode = ledger.API_PURCHASE_UNKNOWN_CODE, createdAt } = {}) {
  await audit.create({ operationId: ledger.purchaseOperationId(purchaseId), actorTelegramId: String(OWNER), action: ledger.API_PURCHASE_ACTION, targetType: "api_purchase", targetId: purchaseId, metadata: { gig: 5, days: 30 } });
  Object.assign(purchaseRow(purchaseId), { status, errorCode, ...(createdAt ? { createdAt } : {}) });
}

/** A resolution-action row in an arbitrary state, as an earlier interrupted attempt (or corruption) could leave one. */
async function seedResolutionRow(purchaseId, fields = {}) {
  await audit.create({
    operationId: ledger.resolveOperationId(purchaseId),
    actorTelegramId: String(OTHER_ADMIN),
    action: ledger.API_PURCHASE_RESOLVED_ACTION,
    targetType: "api_purchase",
    targetId: purchaseId,
    metadata: { outcome: "service_created" },
    status: "started",
    ...fields,
  });
}

const confirmation = (purchaseId) => ({ step: "waiting_for_api_confirmation", gig: 5, days: 30, messageId: 10, adminUserId: String(OWNER), purchaseId });
async function purchaseThrough(purchaseId, behavior) {
  createBehavior = behavior;
  await setSession(GROUP, confirmation(purchaseId));
  await createApiService(bot, query(OWNER, "admin_create_api_service", 10), confirmation(purchaseId));
}
const timeout = () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); };

describe("a successful reconciliation is one durable, auditable event", () => {
  test("records actor, outcome and timestamps in a separate row and leaves the purchase record untouched", async () => {
    await seedPurchase(pid(1));
    const before = JSON.stringify(purchaseRow(pid(1)));
    assert.deepEqual(await unresolved(), [pid(1)]);

    const result = await resolve(OTHER_ADMIN, pid(1), "no_service");
    assert.deepEqual(result, { purchaseId: pid(1), outcome: "no_service", requestedOutcome: "no_service", matchesRequest: true, recovered: false });

    const [row] = resolveRows();
    assert.equal(row.status, "succeeded");
    assert.equal(row.operationId, ledger.resolveOperationId(pid(1)));
    assert.equal(row.actorTelegramId, String(OTHER_ADMIN));
    assert.equal(row.targetId, pid(1));
    assert.equal(row.metadata.outcome, "no_service");
    assert.ok(row.createdAt instanceof Date && row.completedAt instanceof Date);
    assert.equal(JSON.stringify(purchaseRow(pid(1))), before, "the original purchase audit record is never rewritten");
    assert.deepEqual(await unresolved(), []);
  });

  test("a non-admin cannot reconcile", async () => {
    await seedPurchase(pid(1));
    await assert.rejects(() => resolve(5555, pid(1), "no_service"), (error) => error.code === "forbidden");
    assert.equal(resolveRows().length, 0);
    assert.deepEqual(await unresolved(), [pid(1)]);
  });

  test("a purchase that is not awaiting reconciliation is refused and nothing is recorded", async () => {
    await seedPurchase(pid(1), { status: "succeeded", errorCode: null });
    await seedPurchase(pid(2), { status: "failed", errorCode: ledger.API_PURCHASE_REJECTED_CODE });
    for (const id of [pid(1), pid(2), pid(3)]) {
      await assert.rejects(() => resolve(OWNER, id, "no_service"), (error) => error.code === "purchase_not_unresolved");
    }
    assert.equal(resolveRows().length, 0);
  });
});

describe("a purchase stays blocked until a resolution is durably recorded", () => {
  test("a failed insert leaves nothing behind, keeps the purchase blocked, and a retry then succeeds exactly once", async () => {
    await seedPurchase(pid(1));
    audit.state.failCreateIf = isResolveCreate;
    await assert.rejects(() => resolve(OWNER, pid(1), "no_service"), (error) => error.code === "resolution_unverified");
    assert.equal(resolveRows().length, 0, "no half-written row");
    assert.deepEqual(await unresolved(), [pid(1)]);

    audit.state.failCreateIf = null;
    const retry = await resolve(OWNER, pid(1), "no_service");
    assert.equal(retry.outcome, "no_service");
    assert.equal(resolveRows().length, 1);
    assert.deepEqual(await unresolved(), []);
  });

  test("the purchase record cannot be read: nothing is recorded and the call fails closed", async () => {
    await seedPurchase(pid(1));
    audit.state.failFindOneIf = (filter) => String(filter.operationId).startsWith("APIBUY-");
    await assert.rejects(() => resolve(OWNER, pid(1), "no_service"), (error) => error.code === "resolution_unverified");
    assert.equal(resolveRows().length, 0);
    assert.deepEqual(await unresolved(), [pid(1)]);
  });

  test("the insert lands but cannot be read back: the admin is told it is unverified; the database remains the truth and a retry is idempotent", async () => {
    await seedPurchase(pid(1));
    audit.state.failFindOneIf = (filter) => String(filter.operationId).startsWith("APIRES-");
    await assert.rejects(() => resolve(OWNER, pid(1), "no_service"), (error) => error.code === "resolution_unverified");
    audit.state.failFindOneIf = null;
    assert.equal(resolveRows().length, 1, "the durable record exists");
    assert.deepEqual(await unresolved(), [], "the gate reads the database, which holds a valid resolution");
    const retry = await resolve(OTHER_ADMIN, pid(1), "service_created");
    assert.equal(retry.outcome, "no_service");
    assert.equal(retry.matchesRequest, false);
    assert.equal(resolveRows().length, 1);
  });

  test("the ledger cannot be read: the unresolved check throws, so purchases and new flows stay blocked", async () => {
    await seedPurchase(pid(1));
    audit.state.failFind = true;
    await assert.rejects(() => ledger.findUnresolvedApiPurchases({ auditModel: audit }), /unavailable/);
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER, "admin_create_api_service", 10), confirmation(pid(2)));
    await handleCallbackQuery(bot, query(OWNER, "admin_api_service_purchase", 11));
    assert.equal(created().length, 0);
  });

  test("end to end: a failed reconciliation never unblocks; only a durably recorded one does", async () => {
    await purchaseThrough(pid(1), timeout);
    assert.equal(created().length, 1);

    audit.state.failCreateIf = isResolveCreate;
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`));
    assert.ok(alerts().some((text) => text.includes("مسدود می‌ماند")), "the admin is told the purchase stays blocked");
    assert.equal(resolveRows().length, 0);

    createBehavior = okService;
    resetCallbackGuardForTests();
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER, "admin_create_api_service", 10), confirmation(pid(2)));
    assert.equal(created().length, 1, "still blocked: the provider is not reached");

    audit.state.failCreateIf = null;
    resetCallbackGuardForTests();
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 51));
    assert.equal(resolveRows().length, 1);
    assert.ok(edits().some((text) => text.includes("نتیجه ثبت شد")));

    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER, "admin_create_api_service", 10), confirmation(pid(2)));
    assert.equal(created().length, 2, "unblocked only after the resolution was durably recorded");
  });
});

describe("only a successfully persisted, valid resolution row counts", () => {
  const CASES = [
    ["a started resolution row", { status: "started" }, false],
    ["a failed resolution row", { status: "failed", errorCode: "MongoNetworkError" }, false],
    ["an interrupted resolution row", { status: "interrupted" }, false],
    ["a succeeded row without an outcome", { status: "succeeded", metadata: {} }, false],
    ["a succeeded row with an unknown outcome", { status: "succeeded", metadata: { outcome: "maybe" } }, false],
    ["a succeeded row filed under the wrong operation key", { status: "succeeded", operationId: "APIRES-" + "b".repeat(20) }, false],
    ["a succeeded row of a different action", { status: "succeeded", action: "SOMETHING_ELSE" }, false],
    ["a valid succeeded row", { status: "succeeded", metadata: { outcome: "no_service" } }, true],
    ["a valid succeeded row (service existed)", { status: "succeeded", metadata: { outcome: "service_created" } }, true],
  ];
  for (const [label, fields, counts] of CASES) {
    test(`${label} ${counts ? "resolves the purchase" : "does NOT resolve the purchase"}`, async () => {
      await seedPurchase(pid(1));
      await seedResolutionRow(pid(1), fields);
      assert.deepEqual(await unresolved(), counts ? [] : [pid(1)]);
    });
  }

  test("a started resolution row keeps a real purchase blocked end to end", async () => {
    await purchaseThrough(pid(1), timeout);
    await seedResolutionRow(pid(1), { status: "started" });
    createBehavior = okService;
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER, "admin_create_api_service", 10), confirmation(pid(2)));
    assert.equal(created().length, 1);
  });

  test("nothing is inferred from age: a year-old unresolved purchase and a year-old started resolution stay unresolved", async () => {
    await seedPurchase(pid(1), { createdAt: new Date(Date.now() - 400 * DAY) });
    await seedResolutionRow(pid(1), { status: "started", createdAt: new Date(Date.now() - 400 * DAY) });
    assert.deepEqual(await unresolved(), [pid(1)]);
    assert.equal(resolveRows().filter((row) => row.status === "succeeded").length, 0);
  });
});

describe("an interrupted or failed reconciliation is recoverable without a second outcome", () => {
  for (const [label, leftover] of [
    ["started", { status: "started" }],
    ["failed", { status: "failed", errorCode: "MongoNetworkError" }],
    ["interrupted", { status: "interrupted" }],
  ]) {
    test(`a ${label} leftover is taken over atomically, with history preserved`, async () => {
      await seedPurchase(pid(1));
      await seedResolutionRow(pid(1), { ...leftover, actorTelegramId: String(OTHER_ADMIN), metadata: { outcome: "service_created" } });
      assert.deepEqual(await unresolved(), [pid(1)], "blocked before recovery");

      const result = await resolve(OWNER, pid(1), "no_service");
      assert.equal(result.recovered, true);
      assert.equal(result.outcome, "no_service");
      assert.equal(resolveRows().length, 1, "still exactly one resolution row");
      const [row] = resolveRows();
      assert.equal(row.status, "succeeded");
      assert.equal(row.actorTelegramId, String(OWNER));
      assert.equal(row.errorCode, null);
      assert.ok(row.completedAt instanceof Date);
      assert.equal(row.metadata.outcome, "no_service");
      assert.equal(row.metadata.recovered, true);
      assert.equal(row.metadata.recoveredFrom, leftover.status);
      assert.equal(row.metadata.previousActor, String(OTHER_ADMIN));
      assert.equal(row.metadata.previousOutcome, "service_created");
      assert.deepEqual(await unresolved(), []);
    });
  }

  test("after recovery, an opposite later attempt changes nothing and is shown the stored outcome", async () => {
    await seedPurchase(pid(1));
    await seedResolutionRow(pid(1), { status: "failed", errorCode: "X" });
    await resolve(OWNER, pid(1), "no_service");
    const again = await resolve(OTHER_ADMIN, pid(1), "service_created");
    assert.equal(again.outcome, "no_service");
    assert.equal(again.matchesRequest, false);
    assert.equal(again.recovered, false);
    assert.equal(resolveRows().length, 1);
    assert.equal(resolveRows()[0].actorTelegramId, String(OWNER));
  });

  test("end to end: tapping the button on an interrupted reconciliation completes it and unblocks purchases", async () => {
    await purchaseThrough(pid(1), timeout);
    await seedResolutionRow(pid(1), { status: "started" });
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 60));
    assert.equal(resolveRows().length, 1);
    assert.equal(resolveRows()[0].status, "succeeded");
    assert.ok(edits().some((text) => text.includes("ثبت ناتمام قبلی")), "the admin is told an unfinished record was completed");
    createBehavior = okService;
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER, "admin_create_api_service", 10), confirmation(pid(2)));
    assert.equal(created().length, 2);
  });

  test("a succeeded-but-malformed row is never rewritten: the call fails closed and the purchase stays blocked", async () => {
    await seedPurchase(pid(1));
    await seedResolutionRow(pid(1), { status: "succeeded", metadata: {} });
    const snapshot = JSON.stringify(resolveRows()[0]);
    await assert.rejects(() => resolve(OWNER, pid(1), "no_service"), (error) => error.code === "resolution_unverified");
    assert.equal(JSON.stringify(resolveRows()[0]), snapshot);
    assert.deepEqual(await unresolved(), [pid(1)]);
  });

  test("a leftover filed for a different purchase is never taken over", async () => {
    await seedPurchase(pid(1));
    await seedResolutionRow(pid(1), { status: "started", targetId: pid(9) });
    const snapshot = JSON.stringify(resolveRows()[0]);
    await assert.rejects(() => resolve(OWNER, pid(1), "no_service"), (error) => error.code === "resolution_unverified");
    assert.equal(JSON.stringify(resolveRows()[0]), snapshot);
  });

  test("if the recovery update itself fails, nothing changes and the purchase stays blocked", async () => {
    await seedPurchase(pid(1));
    await seedResolutionRow(pid(1), { status: "failed", errorCode: "X" });
    audit.state.failUpdateIf = (filter) => filter.action === ledger.API_PURCHASE_RESOLVED_ACTION;
    await assert.rejects(() => resolve(OWNER, pid(1), "no_service"), (error) => error.code === "resolution_unverified");
    assert.equal(resolveRows()[0].status, "failed");
    assert.deepEqual(await unresolved(), [pid(1)]);
    audit.state.failUpdateIf = null;
    assert.equal((await resolve(OWNER, pid(1), "no_service")).recovered, true);
  });
});

describe("concurrent reconciliation never records two outcomes or two successes", () => {
  const consistent = (results, rows) => {
    const succeeded = rows.filter((row) => row.status === "succeeded");
    assert.equal(succeeded.length, 1, "exactly one successful resolution");
    const stored = succeeded[0].metadata.outcome;
    for (const result of results) {
      assert.equal(result.outcome, stored, "every caller is told the one stored outcome");
      assert.equal(result.matchesRequest, result.requestedOutcome === stored);
    }
    return stored;
  };

  test("two admins, same outcome", async () => {
    await seedPurchase(pid(1));
    const results = await Promise.all([resolve(OWNER, pid(1), "no_service"), resolve(OTHER_ADMIN, pid(1), "no_service")]);
    assert.equal(consistent(results, resolveRows()), "no_service");
    assert.ok(results.every((result) => result.matchesRequest));
  });

  test("two admins, conflicting outcomes (repeated across interleavings)", async () => {
    for (let trial = 0; trial < 40; trial += 1) {
      audit = makeAuditModel();
      await seedPurchase(pid(1));
      const order = trial % 2 === 0
        ? [resolve(OWNER, pid(1), "no_service"), resolve(OTHER_ADMIN, pid(1), "service_created")]
        : [resolve(OTHER_ADMIN, pid(1), "service_created"), resolve(OWNER, pid(1), "no_service")];
      const results = await Promise.all(order);
      consistent(results, resolveRows());
      assert.equal(results.filter((result) => result.matchesRequest).length, 1, "exactly one admin's request won");
      assert.deepEqual(await unresolved(), []);
    }
  });

  test("three concurrent callers with three requests (two outcomes only)", async () => {
    await seedPurchase(pid(1));
    const results = await Promise.all([
      resolve(OWNER, pid(1), "no_service"),
      resolve(OTHER_ADMIN, pid(1), "service_created"),
      resolve(OWNER, pid(1), "service_created"),
    ]);
    consistent(results, resolveRows());
  });

  test("two admins racing to recover the same interrupted row: one wins the conditional update, the other reads it back", async () => {
    for (const leftover of [{ status: "started" }, { status: "failed", errorCode: "X" }]) {
      for (let trial = 0; trial < 20; trial += 1) {
        audit = makeAuditModel();
        await seedPurchase(pid(1));
        await seedResolutionRow(pid(1), leftover);
        const results = await Promise.all([resolve(OWNER, pid(1), "no_service"), resolve(OTHER_ADMIN, pid(1), "service_created")]);
        consistent(results, resolveRows());
        assert.equal(results.filter((result) => result.recovered).length, 1, "only one caller performed the recovery");
        assert.equal(resolveRows()[0].metadata.recovered, true);
      }
    }
  });

  test("concurrent button taps through the real handler store one outcome and display it", async () => {
    await purchaseThrough(pid(1), timeout);
    await Promise.all([
      handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 70)),
      handleCallbackQuery(bot, query(OTHER_ADMIN, `apires:c:${pid(1)}`, 71)),
    ]);
    const stored = consistent([], resolveRows());
    for (const text of edits().filter((entry) => entry.includes("نتیجه ثبت شد"))) {
      assert.ok(text.includes(stored === "no_service" ? "ثبت شد که سرویسی ساخته نشده بود" : "ثبت شد که سرویس ساخته شده بود"), text);
    }
  });
});
