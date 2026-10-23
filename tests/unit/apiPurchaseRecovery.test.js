/**
 * Active-purchase session protection and durable recovery.
 *
 *  - While a provider purchase is running, no other callback or menu action may clear or replace the shared
 *    group session; only the per-admin panel (`adm:`) may run, and it must not write the shared key.
 *  - Non-admins' taps in the admin group are ignored; customer flows in private chats are unchanged.
 *  - An unsettled purchase (crash or ambiguous provider outcome) stays unresolved in the durable ledger until an
 *    admin attests the real outcome. Age, a cleared session or an expired marker never count as proof of failure,
 *    and nothing is ever retried automatically.
 *
 * All fakes: in-memory session store, audit model and Telegram bot, plus a stubbed provider client. Nothing
 * contacts Telegram, a provider, MongoDB or Redis.
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
    if (/status/.test(options.url)) return { status: 200, data: { ok: true, result: { per_gb: 100, per_day: 10 } } };
    return createBehavior(options);
  },
});
mock.method(axios, "create", providerStub);

const { setSessionClientForTests, clearSessionClientForTests, getSession, setSession } = await import("../../config/sessionStore.js");
const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const apiModule = await import("../../handlers/admin/apiServicePurchase.js");
const { createApiService, resetApiPurchaseLocksForTests, setApiPurchaseDepsForTests, isApiPurchaseInFlight } = apiModule;
const { resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js");
const ledger = await import("../../services/admin/apiPurchaseLedger.js");

const GROUP = -100777;
const OWNER = 9001;
const OTHER_ADMIN = 9002;
const OUTSIDER = 5555;
const PID1 = "a1b2c3d4e5f60718293a";
const PID2 = "0f9e8d7c6b5a49382716";
const PID3 = "11223344556677889900";

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

const confirmation = (extra = {}) => ({ step: "waiting_for_api_confirmation", gig: 5, days: 30, per_gb: 100, per_day: 10, totalPrice: 800, messageId: 10, adminUserId: String(OWNER), purchaseId: PID1, ...extra });
const query = (from, data = "admin_create_api_service", { messageId = 10, chat = { id: GROUP, type: "supergroup" } } = {}) => ({
  id: `q-${from}-${Math.random()}`, from: { id: from }, data, message: { message_id: messageId, chat },
});
const rawKey = (key) => sessions.map.get(`session:${key}`) ?? null;
const raw = () => rawKey(GROUP);
const stored = () => getSession(GROUP);
const mutating = () => ["sendMessage", "editMessageText", "deleteMessage", "sendPhoto"].flatMap((method) => bot.of(method));
const edits = () => bot.of("editMessageText").map((call) => String(call.args[0]));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const ambiguous = () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); };
const tapConfirm = (extra = {}, from = OWNER) => createApiService(bot, query(from), confirmation(extra));

async function startLivePurchase() {
  const gate = deferred();
  createBehavior = () => gate.promise;
  await setSession(GROUP, confirmation());
  const running = tapConfirm();
  await settle();
  assert.equal(isApiPurchaseInFlight(GROUP), true);
  assert.equal(created().length, 1);
  return { gate, running };
}

/** Run one purchase to an ambiguous outcome and return the purchase id. */
async function ambiguousPurchase(purchaseId = PID1) {
  createBehavior = ambiguous;
  await setSession(GROUP, confirmation({ purchaseId }));
  await tapConfirm({ purchaseId });
  createBehavior = okService;
  return purchaseId;
}

describe("while a purchase is running, nothing may clear or replace the shared session", () => {
  const ACTIONS = [
    "menu:home", "menu:buy", "menu:services", "menu:topup", "menu:profile", "menu:guide", "menu:support",
    "back_to_home", "back_to_topup", "admin_back_to_panel",
    "admin_send_message_to_user", "send_config_to_user_1", "register_vpn_id:1", "admin_hoosh_search_prompt:uid",
    "admin_api_service_purchase", "admin_cancel_api_purchase", "admin_create_api_service",
    "hoosh_verify:HU1", "pay_hoosh", "pay_nowpayments", `apires:n:${PID1}`,
  ];
  for (const [who, id] of [["the owner", OWNER], ["a different admin", OTHER_ADMIN]]) {
    for (const data of ACTIONS) {
      test(`${data} by ${who} is ignored`, async () => {
        const { gate, running } = await startLivePurchase();
        const before = raw();
        const callsBefore = mutating().length;
        await handleCallbackQuery(bot, query(id, data, { messageId: 77 }));
        assert.equal(raw(), before, "the shared session must be byte-identical");
        assert.equal(mutating().length, callsBefore, "no message may be sent, edited or deleted");
        assert.equal(created().length, 1);
        gate.resolve(okService());
        await running;
      });
    }
  }

  test("the per-admin panel (adm:) still works and never writes the shared session key", async () => {
    const { gate, running } = await startLivePurchase();
    const before = raw();
    for (const data of ["adm:home", "adm:us"]) {
      await handleCallbackQuery(bot, query(OTHER_ADMIN, data, { messageId: 88 }));
    }
    assert.equal(raw(), before, "nested panel helpers must use only their per-admin key");
    assert.ok(rawKey(`${GROUP}:${OTHER_ADMIN}`) !== null, "the panel wrote its own per-admin key");
    gate.resolve(okService());
    await running;
  });

  test("everything works again once the purchase has finished", async () => {
    const { gate, running } = await startLivePurchase();
    gate.resolve(okService());
    await running;
    assert.equal(isApiPurchaseInFlight(GROUP), false);
    await setSession(GROUP, { step: "admin_waiting_for_message", targetUserId: "1", messageId: 10, adminUserId: String(OWNER) });
    await handleCallbackQuery(bot, query(OWNER, "back_to_home", { messageId: 77 }));
    assert.notEqual((await stored()).step, "admin_waiting_for_message");
  });

  test("the lock is released even when the provider call fails", async () => {
    createBehavior = ambiguous;
    await setSession(GROUP, confirmation());
    await tapConfirm();
    assert.equal(isApiPurchaseInFlight(GROUP), false);
  });
});

describe("the admin group is not a customer surface", () => {
  const prompt = { step: "admin_waiting_for_message", targetUserId: "12345", messageId: 10, adminUserId: String(OWNER) };

  for (const data of ["menu:home", "menu:buy", "menu:topup", "menu:profile", "back_to_home", "back_to_topup", "pay_hoosh", "pay_nowpayments", "np_cancel", "hoosh_verify:HU1", "sup_open", "confirm_order_x", "show_service_x"]) {
    test(`${data} from a non-admin is ignored and leaves the admin prompt untouched`, async () => {
      await setSession(GROUP, prompt);
      const before = raw();
      await handleCallbackQuery(bot, query(OUTSIDER, data, { messageId: 77 }));
      assert.equal(raw(), before);
      assert.equal(mutating().length, 0);
    });
  }

  test("a non-admin is also ignored when the session is empty (no session is created)", async () => {
    await handleCallbackQuery(bot, query(OUTSIDER, "menu:topup", { messageId: 77 }));
    assert.equal(raw(), null);
  });

  test("customer flows in a private chat are unchanged", async () => {
    const chat = { id: OUTSIDER, type: "private" };
    await setSession(OUTSIDER, { step: "waiting_for_hoosh_amount", messageId: 5 });
    await handleCallbackQuery(bot, query(OUTSIDER, "menu:home", { messageId: 77, chat }));
    assert.equal(rawKey(OUTSIDER), null, "menu:home still clears the customer's own session");
    await handleCallbackQuery(bot, query(OUTSIDER, "menu:topup", { messageId: 78, chat }));
    assert.equal((await getSession(OUTSIDER)).step, "waiting_for_payment_method");
  });

  test("another group that is not GROUP_ID is unaffected", async () => {
    const chat = { id: -100999, type: "supergroup" };
    await setSession(-100999, { step: "waiting_for_hoosh_amount", messageId: 5 });
    await handleCallbackQuery(bot, query(OUTSIDER, "menu:home", { messageId: 77, chat }));
    assert.equal(rawKey(-100999), null);
  });

  test("an admin's menu tap is ignored while another admin's prompt is active", async () => {
    await setSession(GROUP, prompt);
    const before = raw();
    for (const data of ["menu:home", "menu:buy", "menu:topup", "menu:profile"]) {
      await handleCallbackQuery(bot, query(OTHER_ADMIN, data, { messageId: 77 }));
    }
    assert.equal(raw(), before);
    assert.equal(mutating().length, 0);
  });

  test("an admin's menu tap still works for their own prompt and when no prompt is active", async () => {
    await setSession(GROUP, prompt);
    await handleCallbackQuery(bot, query(OWNER, "menu:home", { messageId: 77 }));
    assert.equal(raw(), null);
    await handleCallbackQuery(bot, query(OTHER_ADMIN, "menu:home", { messageId: 78 }));
    assert.ok(mutating().length > 0, "the menu was rendered");
  });

  test("an expired foreign prompt no longer blocks an admin's menu tap", async () => {
    await setSession(GROUP, prompt);
    const old = JSON.parse(raw());
    old.updatedAt = Date.now() - 3 * 60 * 60 * 1000;
    sessions.map.set(`session:${GROUP}`, JSON.stringify(old));
    await handleCallbackQuery(bot, query(OTHER_ADMIN, "menu:home", { messageId: 77 }));
    assert.equal(raw(), null);
  });
});

describe("an unsettled purchase stays unresolved until an admin reconciles it", () => {
  test("an ambiguous outcome writes a durable unresolved row and never retries", async () => {
    await ambiguousPurchase();
    assert.equal(created().length, 1);
    const [row] = audit.byAction(ledger.API_PURCHASE_ACTION);
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, ledger.API_PURCHASE_UNKNOWN_CODE);
    assert.equal(row.targetId, PID1);
    assert.equal(row.actorTelegramId, String(OWNER));
    assert.deepEqual((await ledger.findUnresolvedApiPurchases({ auditModel: audit })).map((entry) => entry.purchaseId), [PID1]);
    // Replaying the same confirmation must not reach the provider.
    await tapConfirm();
    await tapConfirm();
    assert.equal(created().length, 1);
  });

  test("the notice offers the audited resolve buttons and no one-tap retry", async () => {
    await ambiguousPurchase();
    const call = bot.of("editMessageText").find((entry) => String(entry.args[0]).includes("نامشخص"));
    const markup = JSON.stringify(call.args[1].reply_markup);
    assert.ok(markup.includes(`apires:c:${PID1}`) && markup.includes(`apires:n:${PID1}`));
    assert.ok(!markup.includes("admin_api_service_purchase"));
    assert.ok(markup.length < 2000 && `apires:c:${PID1}`.length <= 64);
  });

  test("clearing the session (or letting it expire) does not release the block", async () => {
    await ambiguousPurchase();
    sessions.map.clear(); // as after the 7-day session TTL, a clear, or a Redis flush
    await setSession(GROUP, confirmation({ purchaseId: PID2 }));
    await tapConfirm({ purchaseId: PID2 });
    assert.equal(created().length, 1, "a fresh confirmation is still blocked");
    assert.ok(edits().some((text) => text.includes("بلاتکلیف")));
    sessions.map.clear();
    await handleCallbackQuery(bot, query(OWNER, "admin_api_service_purchase", { messageId: 30 }));
    assert.equal((await stored()).step ?? null, null, "starting a new purchase is refused too");
    assert.equal(created().length, 1);
  });

  test("age is never treated as proof: a year-old unresolved row still blocks", async () => {
    await ambiguousPurchase();
    for (const row of audit.byAction(ledger.API_PURCHASE_ACTION)) row.createdAt = new Date(Date.now() - 400 * 24 * 3600_000);
    await setSession(GROUP, confirmation({ purchaseId: PID2 }));
    await tapConfirm({ purchaseId: PID2 });
    assert.equal(created().length, 1);
    assert.equal((await ledger.findUnresolvedApiPurchases({ auditModel: audit })).length, 1);
  });

  test("a crash after the claim (row still 'started') blocks, and a stale session marker is irrelevant", async () => {
    await audit.create({ operationId: ledger.purchaseOperationId(PID1), actorTelegramId: String(OWNER), action: ledger.API_PURCHASE_ACTION, targetType: "api_purchase", targetId: PID1, metadata: {} });
    audit.all()[0].createdAt = new Date(Date.now() - 10 * 24 * 3600_000);
    await setSession(GROUP, { step: null, adminUserId: String(OWNER), apiPurchase: { state: "in_progress", at: Date.now() - 10 * 24 * 3600_000, gig: 5, days: 30, purchaseId: PID1 } });
    await handleCallbackQuery(bot, query(OTHER_ADMIN, "admin_back_to_panel", { messageId: 40 }));
    assert.equal(raw(), null, "no purchase is running in this process, so the stale marker may be cleared");
    await setSession(GROUP, confirmation({ purchaseId: PID2 }));
    await tapConfirm({ purchaseId: PID2 });
    assert.equal(created().length, 0, "but the durable record still blocks any new purchase");
  });

  test("a stale session marker WITHOUT a ledger row does not block (the row is written first)", async () => {
    await setSession(GROUP, { step: null, adminUserId: String(OWNER), apiPurchase: { state: "in_progress", at: Date.now() - 10 * 24 * 3600_000, purchaseId: PID1 } });
    await handleCallbackQuery(bot, query(OWNER, "admin_api_service_purchase", { messageId: 31 }));
    assert.equal((await stored()).step, "waiting_for_api_gig");
  });

  test("a definite rejection leaves nothing unresolved", async () => {
    createBehavior = () => { throw Object.assign(new Error("payment required"), { response: { status: 402, data: { ok: false, error: "insufficient balance", http_code: 402 } } }); };
    await setSession(GROUP, confirmation());
    await tapConfirm();
    assert.equal(audit.byAction(ledger.API_PURCHASE_ACTION)[0].errorCode, "API_PURCHASE_REJECTED");
    assert.equal((await ledger.findUnresolvedApiPurchases({ auditModel: audit })).length, 0);
    createBehavior = okService;
    await setSession(GROUP, confirmation({ purchaseId: PID2 }));
    await tapConfirm({ purchaseId: PID2 });
    assert.equal(created().length, 2);
  });

  test("a successful purchase is recorded as succeeded and is not unresolved", async () => {
    await setSession(GROUP, confirmation());
    await tapConfirm();
    const [row] = audit.byAction(ledger.API_PURCHASE_ACTION);
    assert.equal(row.status, "succeeded");
    assert.equal((await ledger.findUnresolvedApiPurchases({ auditModel: audit })).length, 0);
  });

  for (const [flag, outcome] of [["n", "no_service"], ["c", "service_created"]]) {
    test(`apires:${flag} by an admin records an audited attestation and unblocks purchases`, async () => {
      await ambiguousPurchase();
      await handleCallbackQuery(bot, query(OTHER_ADMIN, `apires:${flag}:${PID1}`, { messageId: 50 }));
      const [resolved] = audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION);
      assert.equal(resolved.actorTelegramId, String(OTHER_ADMIN));
      assert.equal(resolved.targetId, PID1);
      assert.equal(resolved.metadata.outcome, outcome);
      assert.equal(audit.byAction(ledger.API_PURCHASE_ACTION)[0].errorCode, ledger.API_PURCHASE_UNKNOWN_CODE, "the original record is never rewritten");
      assert.equal((await ledger.findUnresolvedApiPurchases({ auditModel: audit })).length, 0);
      await setSession(GROUP, confirmation({ purchaseId: PID2 }));
      await tapConfirm({ purchaseId: PID2 });
      assert.equal(created().length, 2, "a deliberate new purchase now works");
    });
  }

  test("only an authorized admin can reconcile; non-admins in the group are ignored", async () => {
    await ambiguousPurchase();
    await handleCallbackQuery(bot, query(OUTSIDER, `apires:n:${PID1}`, { messageId: 50 }));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 0);
    process.env.ADMINS = "9002";
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID1}`, { messageId: 50 }));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 0, "a former admin cannot reconcile");
  });

  test("the resolve handler enforces authorization itself, not only the router in front of it", async () => {
    await ambiguousPurchase();
    await apiModule.resolveApiPurchaseCallback(bot, query(OUTSIDER, `apires:n:${PID1}`));
    process.env.ADMINS = "9002";
    await apiModule.resolveApiPurchaseCallback(bot, query(OWNER, `apires:n:${PID1}`));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 0);
    // Reconciliation is an admin-group action: an admin tapping a forwarded button elsewhere is refused too.
    await apiModule.resolveApiPurchaseCallback(bot, query(OTHER_ADMIN, `apires:n:${PID1}`, { chat: { id: OTHER_ADMIN, type: "private" } }));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 0);
  });

  test("reconciling is idempotent and refuses references that are not awaiting reconciliation", async () => {
    await ambiguousPurchase();
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID1}`, { messageId: 50 }));
    resetCallbackGuardForTests();
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID1}`, { messageId: 50 }));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 1);
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID3}`, { messageId: 51 }));
    await handleCallbackQuery(bot, query(OWNER, "apires:n:not-a-reference", { messageId: 52 }));
    await handleCallbackQuery(bot, query(OWNER, "apires:x:" + PID1, { messageId: 53 }));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 1);
  });

  test("a successful or rejected purchase cannot be 'reconciled' away", async () => {
    await setSession(GROUP, confirmation());
    await tapConfirm();
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID1}`, { messageId: 50 }));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 0);
  });

  test("with several unresolved purchases, resolving one keeps the block", async () => {
    await ambiguousPurchase(PID1);
    sessions.map.clear();
    // Simulate a second crashed attempt recorded by another process.
    await audit.create({ operationId: ledger.purchaseOperationId(PID2), actorTelegramId: String(OTHER_ADMIN), action: ledger.API_PURCHASE_ACTION, targetType: "api_purchase", targetId: PID2, metadata: {} });
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID1}`, { messageId: 50 }));
    assert.deepEqual((await ledger.findUnresolvedApiPurchases({ auditModel: audit })).map((entry) => entry.purchaseId), [PID2]);
    await setSession(GROUP, confirmation({ purchaseId: PID3 }));
    await tapConfirm({ purchaseId: PID3 });
    assert.equal(created().length, 1);
  });

  test("the informational uncertain marker is dropped on reconciliation, but another admin's prompt is never touched", async () => {
    await ambiguousPurchase();
    await handleCallbackQuery(bot, query(OWNER, `apires:n:${PID1}`, { messageId: 50 }));
    assert.equal(raw() === null || (await stored()).apiPurchase === undefined, true);

    await ambiguousPurchase(PID2);
    await setSession(GROUP, { step: "admin_waiting_for_message", targetUserId: "1", messageId: 10, adminUserId: String(OTHER_ADMIN) });
    const before = raw();
    await handleCallbackQuery(bot, query(OWNER, `apires:c:${PID2}`, { messageId: 51 }));
    assert.equal(raw(), before);
  });

  test("reconciling is refused while a purchase is running", async () => {
    await ambiguousPurchase(PID1);
    const { gate, running } = await (async () => {
      const g = deferred();
      createBehavior = () => g.promise;
      await setSession(GROUP, confirmation({ purchaseId: PID2 }));
      // the unresolved PID1 blocks a new purchase, so start the live one directly as another process would have
      audit.docs.delete(ledger.purchaseOperationId(PID1));
      const run = tapConfirm({ purchaseId: PID2 });
      await settle();
      return { gate: g, running: run };
    })();
    assert.equal(isApiPurchaseInFlight(GROUP), true);
    await audit.create({ operationId: ledger.purchaseOperationId(PID3), actorTelegramId: String(OWNER), action: ledger.API_PURCHASE_ACTION, targetType: "api_purchase", targetId: PID3, metadata: {} });
    await apiModule.resolveApiPurchaseCallback(bot, query(OWNER, `apires:n:${PID3}`));
    assert.equal(audit.byAction(ledger.API_PURCHASE_RESOLVED_ACTION).length, 0);
    gate.resolve(okService());
    await running;
  });

  test("if the ledger cannot be read nothing is bought and nothing can be started", async () => {
    await setSession(GROUP, confirmation());
    audit.state.failFind = true;
    await tapConfirm();
    await handleCallbackQuery(bot, query(OWNER, "admin_api_service_purchase", { messageId: 60 }));
    assert.equal(created().length, 0);
    assert.equal((await stored()).step, "waiting_for_api_confirmation", "the confirmation was not consumed");
  });

  test("if the ledger cannot be written nothing is bought and the confirmation is preserved", async () => {
    await setSession(GROUP, confirmation());
    audit.state.failCreate = true;
    await tapConfirm();
    assert.equal(created().length, 0);
    assert.equal((await stored()).step, "waiting_for_api_confirmation");
    audit.state.failCreate = false;
    await tapConfirm();
    assert.equal(created().length, 1, "once the ledger is back the same confirmation works, exactly once");
  });

  test("the ledger claim is atomic across processes (two module instances, one shared store)", async () => {
    const second = await import("../../handlers/admin/apiServicePurchase.js?second-process");
    second.setApiPurchaseDepsForTests({ auditModel: audit });
    const gate = deferred();
    createBehavior = () => gate.promise;
    await setSession(GROUP, confirmation());
    const first = createApiService(bot, query(OWNER), confirmation());
    const other = second.createApiService(bot, query(OWNER), confirmation());
    await settle(40);
    gate.resolve(okService());
    await Promise.all([first, other]);
    assert.equal(created().length, 1, "the unique ledger row lets only one process reach the provider");
    second.resetApiPurchaseLocksForTests();
  });

  test("a confirmation without a purchase reference, or whose reference differs from the stored one, is refused", async () => {
    await setSession(GROUP, confirmation());
    const { purchaseId, ...legacy } = confirmation();
    await createApiService(bot, query(OWNER), legacy);
    await createApiService(bot, query(OWNER), confirmation({ purchaseId: PID2 }));
    assert.equal(created().length, 0);
    assert.equal(bot.calls.length, 0);
  });
});
