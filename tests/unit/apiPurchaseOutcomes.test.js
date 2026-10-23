/**
 * API purchase ledger: outcome classification, unresolved detection and reconciliation consistency.
 *
 *  B-1  A purchase is settled only by an allowlist of proven outcomes. Any other row (started, interrupted, or failed
 *       with an unknown or arbitrary code, e.g. a database error written after the provider had already succeeded)
 *       keeps blocking new purchases until an admin reconciles it.
 *  C-1  The reconciliation confirmation always shows the outcome the ledger stored, not the button that was tapped.
 *  B-2  Only explicitly established provider rejections are "definite"; HTTP 3xx, 408, 5xx, timeouts, network errors
 *       and malformed responses stay ambiguous.
 *
 * Fakes only: in-memory session store, Telegram bot and a persisted-vs-in-memory audit model, plus a stubbed provider
 * client. Nothing contacts Telegram, a provider, MongoDB or Redis.
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
const providerStub = () => ({
  request: async (options) => {
    providerRequests.push(options);
    return createBehavior(options);
  },
});
mock.method(axios, "create", providerStub);

const { setSessionClientForTests, clearSessionClientForTests, getSession, setSession } = await import("../../config/sessionStore.js");
const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const { createApiService, resetApiPurchaseLocksForTests, setApiPurchaseDepsForTests, isDefiniteProviderFailure } = await import("../../handlers/admin/apiServicePurchase.js");
const { resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js");
const ledger = await import("../../services/admin/apiPurchaseLedger.js");
const { WizardApiError, WIZARD_REJECTION_CODES } = await import("../../api/wizardApi.js");

const GROUP = -100777;
const OWNER = 9001;
const OTHER_ADMIN = 9002;
const pid = (n) => String(n).padStart(20, "a");

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

const confirmation = (purchaseId = pid(1), extra = {}) => ({ step: "waiting_for_api_confirmation", gig: 5, days: 30, per_gb: 100, per_day: 10, totalPrice: 800, messageId: 10, adminUserId: String(OWNER), purchaseId, ...extra });
const query = (from, data = "admin_create_api_service", messageId = 10) => ({
  id: `q-${from}-${Math.random()}`, from: { id: from }, data,
  message: { message_id: messageId, chat: { id: GROUP, type: "supergroup" } },
});
const edits = () => bot.of("editMessageText").map((call) => String(call.args[0]));
const unresolved = async () => (await ledger.findUnresolvedApiPurchases({ auditModel: audit })).map((entry) => entry.purchaseId);
const purchaseRows = () => audit.byAction(ledger.API_PURCHASE_ACTION);
const resolveRows = () => audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION);
// A bare HTTP error: nothing in the body proves the panel refused the request.
const httpError = (status) => () => { throw Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } }); };
// An explicit panel refusal as the client's contract defines it: JSON {ok:false, error, http_code} with a 4xx code.
const refusal = (status) => () => { throw Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { ok: false, error: "refused", http_code: status } } }); };
const networkError = (code) => () => { throw Object.assign(new Error(code), { code }); };

async function confirmWith(behavior, purchaseId = pid(1)) {
  createBehavior = behavior;
  await setSession(GROUP, confirmation(purchaseId));
  await createApiService(bot, query(OWNER), confirmation(purchaseId));
}

/** Seed a persisted purchase row directly, as an earlier run (or another process) would have left it. */
async function seedRow(purchaseId, { status, errorCode = null }) {
  await audit.create({ operationId: ledger.purchaseOperationId(purchaseId), actorTelegramId: String(OWNER), action: ledger.API_PURCHASE_ACTION, targetType: "api_purchase", targetId: purchaseId, metadata: {} });
  Object.assign(audit.docs.get(ledger.purchaseOperationId(purchaseId)), { status, errorCode });
}

describe("test harness: the audit fake separates persisted rows from in-memory documents", () => {
  test("a failed save() leaves the persisted record untouched", async () => {
    const doc = await audit.create({ operationId: "OP-1234567890123456", actorTelegramId: "1", action: "X", metadata: {} });
    doc.status = "succeeded";
    audit.state.failSave = true;
    await assert.rejects(() => doc.save(), /connection lost/);
    assert.equal(audit.docs.get("OP-1234567890123456").status, "started", "the stored row must not see the unsaved change");
    audit.state.failSave = false;
    await doc.save();
    assert.equal(audit.docs.get("OP-1234567890123456").status, "succeeded");
  });
});

describe("B-1: only proven outcomes settle a purchase (allowlist)", () => {
  const CASES = [
    ["started", null, true],
    ["started", ledger.API_PURCHASE_REJECTED_CODE, true],
    ["interrupted", null, true],
    ["failed", null, true],
    ["failed", "MongoNetworkError", true],
    ["failed", "ECONNRESET", true],
    ["failed", ledger.API_PURCHASE_UNKNOWN_CODE, true],
    ["failed", "SOME_FUTURE_CODE", true],
    ["failed", "api_purchase_rejected", true],
    ["unexpected-status", null, true],
    ["succeeded", null, false],
    ["failed", ledger.API_PURCHASE_REJECTED_CODE, false],
    ["failed", ledger.API_PURCHASE_NOT_CLAIMED_CODE, false],
  ];
  for (const [status, errorCode, blocks] of CASES) {
    test(`a ${status} row with code ${String(errorCode)} ${blocks ? "stays unresolved" : "is settled"}`, async () => {
      await seedRow(pid(7), { status, errorCode });
      assert.deepEqual(await unresolved(), blocks ? [pid(7)] : []);
    });
  }

  test("the definite allowlist is exactly the two proven non-creation codes", () => {
    assert.deepEqual([...ledger.API_PURCHASE_DEFINITE_CODES].sort(), ["API_PURCHASE_NOT_CLAIMED", "API_PURCHASE_REJECTED"]);
  });

  test("provider success, then the success save fails, then the fallback failure-save succeeds with a database error code", async () => {
    audit.state.failSave = true;
    await confirmWith(okService, pid(1));
    audit.state.failSave = false;

    assert.equal(created().length, 1);
    const [row] = purchaseRows();
    assert.equal(row.status, "failed", "the persisted row carries the fallback failure");
    assert.equal(row.errorCode, "MongoNetworkError", "an arbitrary database error code, not a proven outcome");
    assert.deepEqual(await unresolved(), [pid(1)], "so it still blocks");
    assert.equal(bot.of("sendPhoto").length + bot.of("sendMessage").length > 0, true, "the admin still received the service");

    // A new purchase is refused, with no provider call, and reconciliation is offered.
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER), confirmation(pid(2)));
    assert.equal(created().length, 1);
    assert.ok(edits().some((text) => text.includes("بلاتکلیف")));
    const markup = JSON.stringify(bot.of("editMessageText").at(-1).args[1].reply_markup);
    assert.ok(markup.includes(`apires:c:${pid(1)}`));

    // Only audited reconciliation lifts the block; the original record is not rewritten.
    await handleCallbackQuery(bot, query(OWNER, `apires:c:${pid(1)}`, 60));
    assert.deepEqual(await unresolved(), []);
    assert.equal(purchaseRows()[0].errorCode, "MongoNetworkError");
    assert.equal(resolveRows().length, 1);
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER), confirmation(pid(2)));
    assert.equal(created().length, 2);
  });

  test("provider success, then both the success save and the fallback failure-save fail: the row stays 'started' and blocks", async () => {
    audit.state.failSave = true;
    audit.state.failUpdate = true;
    await confirmWith(okService, pid(1));
    audit.state.failSave = false;
    audit.state.failUpdate = false;
    assert.equal(created().length, 1);
    assert.equal(purchaseRows()[0].status, "started");
    assert.deepEqual(await unresolved(), [pid(1)]);
    await setSession(GROUP, confirmation(pid(2)));
    await createApiService(bot, query(OWNER), confirmation(pid(2)));
    assert.equal(created().length, 1);
  });

  test("a rejection whose failure-save fails stays blocked rather than being assumed safe", async () => {
    audit.state.failUpdate = true;
    await confirmWith(refusal(402), pid(1));
    audit.state.failUpdate = false;
    assert.equal(purchaseRows()[0].status, "started");
    assert.deepEqual(await unresolved(), [pid(1)]);
  });

  test("a purchase stopped before the provider (state could not be recorded) is settled and nothing was bought", async () => {
    await setSession(GROUP, confirmation(pid(1)));
    sessions.set = async () => "OK"; // session writes are silently dropped
    await createApiService(bot, query(OWNER), confirmation(pid(1)));
    assert.equal(created().length, 0);
    assert.equal(purchaseRows()[0].errorCode, ledger.API_PURCHASE_NOT_CLAIMED_CODE);
    assert.deepEqual(await unresolved(), []);
  });

  test("every unsettled kind can be reconciled (no deadlock) and settled rows cannot", async () => {
    const kinds = [["started", null], ["interrupted", null], ["failed", "MongoNetworkError"], ["failed", null]];
    for (const [index, [status, errorCode]] of kinds.entries()) {
      await seedRow(pid(10 + index), { status, errorCode });
      const result = await ledger.resolveApiPurchase({ actorId: OWNER, purchaseId: pid(10 + index), outcome: "no_service", auditModel: audit });
      assert.equal(result.outcome, "no_service");
    }
    assert.deepEqual(await unresolved(), []);
    for (const [index, [status, errorCode]] of [["succeeded", null], ["failed", ledger.API_PURCHASE_REJECTED_CODE], ["failed", ledger.API_PURCHASE_NOT_CLAIMED_CODE]].entries()) {
      await seedRow(pid(30 + index), { status, errorCode });
      await assert.rejects(() => ledger.resolveApiPurchase({ actorId: OWNER, purchaseId: pid(30 + index), outcome: "no_service", auditModel: audit }), (error) => error.code === "purchase_not_unresolved");
    }
  });

  test("an unreadable ledger still blocks every purchase", async () => {
    await setSession(GROUP, confirmation(pid(1)));
    audit.state.failFind = true;
    await createApiService(bot, query(OWNER), confirmation(pid(1)));
    assert.equal(created().length, 0);
  });
});

describe("C-1: the reconciliation confirmation shows the stored outcome", () => {
  const SAYS_NO_SERVICE = "ثبت شد که سرویسی ساخته نشده بود";
  const SAYS_EXISTED = "ثبت شد که سرویس ساخته شده بود";
  const lastResultText = () => edits().filter((text) => text.includes("نتیجه ثبت شد")).at(-1) || "";

  beforeEach(async () => { await confirmWith(networkError("ECONNABORTED"), pid(1)); });

  test("the first tap shows what was stored", async () => {
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 50));
    assert.equal(resolveRows()[0].metadata.outcome, "no_service");
    assert.ok(lastResultText().includes(SAYS_NO_SERVICE));
    assert.ok(!lastResultText().includes("نمایش داده شده است"), "no mismatch note when the tap matches");
  });

  test("the same admin tapping the OPPOSITE button afterwards sees the stored outcome, with a note", async () => {
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 50));
    resetCallbackGuardForTests();
    const alertsBefore = bot.of("answerCallbackQuery").length;
    await handleCallbackQuery(bot, query(OWNER, `apires:c:${pid(1)}`, 51));
    assert.equal(resolveRows().length, 1);
    assert.equal(resolveRows()[0].metadata.outcome, "no_service", "the stored resolution never changes");
    const text = lastResultText();
    assert.ok(text.includes(SAYS_NO_SERVICE) && !text.includes(SAYS_EXISTED), text);
    assert.ok(text.includes("قبلاً با نتیجهٔ دیگری ثبت شده بود"));
    const alerts = bot.of("answerCallbackQuery").slice(alertsBefore).map((call) => call.args[1]?.text);
    assert.ok(alerts.some((alertText) => String(alertText).includes("تغییر نکرد")));
  });

  test("the reverse order (service existed first, then 'no service') also shows the stored outcome", async () => {
    await handleCallbackQuery(bot, query(OWNER, `apires:c:${pid(1)}`, 50));
    resetCallbackGuardForTests();
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 51));
    assert.equal(resolveRows().length, 1);
    const text = lastResultText();
    assert.ok(text.includes(SAYS_EXISTED) && !text.includes(SAYS_NO_SERVICE), text);
  });

  test("a different admin submitting the opposite outcome changes nothing and is shown the stored outcome", async () => {
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 50));
    resetCallbackGuardForTests();
    const editsBefore = edits().length;
    await handleCallbackQuery(bot, query(OTHER_ADMIN, `apires:c:${pid(1)}`, 51));
    assert.equal(resolveRows().length, 1);
    assert.equal(resolveRows()[0].actorTelegramId, String(OWNER), "the recorded actor never changes");
    assert.equal(resolveRows()[0].metadata.outcome, "no_service");
    const text = edits().slice(editsBefore).filter((entry) => entry.includes("نتیجه ثبت شد")).at(-1) || "";
    assert.ok(text.includes(SAYS_NO_SERVICE) && !text.includes(SAYS_EXISTED), text);
    assert.ok(text.includes("قبلاً با نتیجهٔ دیگری ثبت شده بود"));
  });

  test("concurrent opposite attestations store one outcome and every displayed result matches it", async () => {
    await Promise.all([
      handleCallbackQuery(bot, query(OWNER, `apires:n:${pid(1)}`, 50)),
      handleCallbackQuery(bot, query(OTHER_ADMIN, `apires:c:${pid(1)}`, 51)),
    ]);
    assert.equal(resolveRows().length, 1);
    const stored = resolveRows()[0].metadata.outcome;
    for (const text of edits().filter((entry) => entry.includes("نتیجه ثبت شد"))) {
      assert.ok(text.includes(stored === "no_service" ? SAYS_NO_SERVICE : SAYS_EXISTED), text);
      assert.ok(!text.includes(stored === "no_service" ? SAYS_EXISTED : SAYS_NO_SERVICE), text);
    }
  });

  test("resolveApiPurchase reports the persisted outcome and whether it matched the request", async () => {
    const first = await ledger.resolveApiPurchase({ actorId: OWNER, purchaseId: pid(1), outcome: "no_service", auditModel: audit });
    assert.deepEqual(first, { purchaseId: pid(1), outcome: "no_service", requestedOutcome: "no_service", matchesRequest: true, recovered: false });
    const second = await ledger.resolveApiPurchase({ actorId: OWNER, purchaseId: pid(1), outcome: "service_created", auditModel: audit });
    assert.deepEqual(second, { purchaseId: pid(1), outcome: "no_service", requestedOutcome: "service_created", matchesRequest: false, recovered: false });
    assert.equal(resolveRows().length, 1);
  });

  test("if the stored resolution cannot be read back, the result is unverified and nothing is claimed", async () => {
    const realFindOne = audit.findOne.bind(audit);
    audit.findOne = async (filter) => (String(filter.operationId).startsWith("APIRES-") && audit.docs.has(filter.operationId) ? null : realFindOne(filter));
    await assert.rejects(() => ledger.resolveApiPurchase({ actorId: OWNER, purchaseId: pid(1), outcome: "no_service", auditModel: audit }), (error) => error.code === "resolution_unverified");
  });
});

describe("B-2: only established provider rejections are definite", () => {
  const AMBIGUOUS = [
    ...[301, 302, 303, 304, 307, 308, 399].map((status) => [`HTTP ${status} (3xx and other non-error statuses)`, httpError(status)]),
    ["HTTP 408 request timeout", httpError(408)],
    ["HTTP 408 even with an ok:false body", refusal(408)],
    ["HTTP 404 with an empty body (a gateway, not a refusal)", httpError(404)],
    ["HTTP 400 with an HTML body", () => { throw Object.assign(new Error("x"), { response: { status: 400, data: "<html>bad request</html>" } }); }],
    ["HTTP 400 ok:false but body http_code 500", () => { throw Object.assign(new Error("x"), { response: { status: 400, data: { ok: false, http_code: 500 } } }); }],
    ["HTTP 200 ok:false with body http_code 500", () => ({ status: 200, data: { ok: false, error: "internal error", http_code: 500 } })],
    ["HTTP 200 ok:false with body http_code 503", () => ({ status: 200, data: { ok: false, error: "unavailable", http_code: 503 } })],
    ["HTTP 200 ok:false with a malformed body http_code", () => ({ status: 200, data: { ok: false, error: "x", http_code: "banana" } })],
    ["HTTP 200 ok:false with body http_code 200 (contradictory)", () => ({ status: 200, data: { ok: false, error: "x", http_code: 200 } })],
    ["HTTP 200 with ok:\"false\" (not a boolean)", () => ({ status: 200, data: { ok: "false", error: "x" } })],
    ["HTTP 200 with an empty object", () => ({ status: 200, data: {} })],
    ...[500, 502, 503, 504, 599].map((status) => [`HTTP ${status}`, httpError(status)]),
    ["request timeout (no response)", networkError("ECONNABORTED")],
    ["connection reset", networkError("ECONNRESET")],
    ["DNS failure", networkError("ENOTFOUND")],
    ["HTTP 200 with a non-JSON body", () => ({ status: 200, data: "<html>gateway</html>" })],
    ["HTTP 200 with an array body", () => ({ status: 200, data: [] })],
    ["HTTP 200 with an empty body", () => ({ status: 200, data: null })],
    ["ok:true without a result", () => ({ status: 200, data: { ok: true } })],
    ["ok:true with a malformed username", () => ({ status: 200, data: { ok: true, result: { username: "bad name!", hash: "h" } } })],
    ["ok:true with neither hash nor link", () => ({ status: 200, data: { ok: true, result: { username: "svc" } } })],
  ];
  for (const [label, behavior] of AMBIGUOUS) {
    test(`${label} is ambiguous: unresolved, no retry offered, next purchase blocked`, async () => {
      await confirmWith(behavior, pid(1));
      assert.equal(created().length, 1);
      const [row] = purchaseRows();
      assert.equal(row.status, "failed");
      assert.equal(row.errorCode, ledger.API_PURCHASE_UNKNOWN_CODE);
      assert.deepEqual(await unresolved(), [pid(1)]);
      assert.ok(!bot.of("editMessageText").some((call) => JSON.stringify(call.args[1]?.reply_markup || {}).includes("admin_api_service_purchase")), "no one-tap retry");

      createBehavior = okService;
      await setSession(GROUP, confirmation(pid(2)));
      await createApiService(bot, query(OWNER), confirmation(pid(2)));
      assert.equal(created().length, 1, "a second purchase must not reach the provider");
    });
  }

  const DEFINITE = [
    ...[400, 401, 402, 403, 404, 409, 422, 429, 499].map((status) => [`HTTP ${status} with an explicit ok:false refusal`, refusal(status)]),
    ["HTTP 200 ok:false with a 4xx body http_code", () => ({ status: 200, data: { ok: false, error: "no", http_code: 404 } })],
    ["HTTP 200 ok:false with no body http_code", () => ({ status: 200, data: { ok: false, error: "insufficient balance" } })],
    ["HTTP 200 ok:false with a numeric-string body http_code", () => ({ status: 200, data: { ok: false, error: "no", http_code: "400" } })],
    ["an explicit panel rejection ({ok:false}, e.g. insufficient balance)", () => ({ status: 200, data: { ok: false, error: "insufficient balance" } })],
  ];
  for (const [label, behavior] of DEFINITE) {
    test(`${label} is a definite rejection: settled, retry offered, a new purchase may follow`, async () => {
      await confirmWith(behavior, pid(1));
      assert.equal(created().length, 1);
      assert.equal(purchaseRows()[0].errorCode, ledger.API_PURCHASE_REJECTED_CODE);
      assert.deepEqual(await unresolved(), []);
      assert.ok(bot.of("editMessageText").some((call) => JSON.stringify(call.args[1]?.reply_markup || {}).includes("admin_api_service_purchase")), "retry offered");
      createBehavior = okService;
      await setSession(GROUP, confirmation(pid(2)));
      await createApiService(bot, query(OWNER), confirmation(pid(2)));
      assert.equal(created().length, 2);
    });
  }

  test("isDefiniteProviderFailure follows the shared client's verdict, never a bare status", () => {
    const err = (options) => new WizardApiError("create", options);
    for (const code of WIZARD_REJECTION_CODES) {
      for (const status of [200, 400, 402, 404, 429, undefined]) assert.equal(isDefiniteProviderFailure(err({ status, code, ambiguous: false })), true, `${code}/${status}`);
      assert.equal(isDefiniteProviderFailure(err({ status: 400, code, ambiguous: true })), false, "ambiguous always wins");
    }
    // A bare status without the client's rejection proof is never enough, whatever the number.
    for (const status of [100, 200, 300, 302, 304, 400, 402, 408, 429, 500, 503, undefined]) {
      assert.equal(isDefiniteProviderFailure(err({ status, ambiguous: false })), false, `no code / ${status}`);
      assert.equal(isDefiniteProviderFailure(err({ status, code: "ERR_BAD_RESPONSE", ambiguous: false })), false, `transport code / ${status}`);
    }
    assert.equal(isDefiniteProviderFailure(err({ status: 200, code: "panel_response_unproven", ambiguous: true })), false);
    assert.equal(isDefiniteProviderFailure(new TypeError("gig must be")), true);
    assert.equal(isDefiniteProviderFailure(new Error("WIZARD_API_URL is not configured")), false);
    assert.equal(isDefiniteProviderFailure({ ambiguous: false, code: "panel_rejected_request" }), false, "must be a real WizardApiError");
    assert.equal(isDefiniteProviderFailure(undefined), false);
  });
});
