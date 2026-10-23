/**
 * R-1 / R-2 / R-3 regression tests.
 *
 *  R-1  The provider's /create has no idempotency key, so one confirmation must never reach it twice
 *       (repeat taps, concurrent taps, stale session copies) and an ambiguous outcome must never be retried.
 *  R-2  Back/cancel buttons must not wipe another admin's active prompt out of the shared group session.
 *  R-3  Confirmation only works from the `waiting_for_api_confirmation` step.
 *
 * Everything runs on fakes: in-memory session store, fake Telegram bot, a stubbed provider HTTP client.
 * Nothing contacts Telegram, a provider, a payment service, MongoDB or Redis.
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

// The provider stub. `createBehavior` decides what POST /create does; every request is recorded.
const providerRequests = [];
let createBehavior;
const created = () => providerRequests.filter((request) => /create/.test(request.url));
const okService = () => ({ status: 200, data: { ok: true, result: { username: "svc_new", hash: "abc123", tak_links: ["vless://x"] } } });
mock.method(axios, "create", () => ({
  request: async (options) => {
    providerRequests.push(options);
    if (/status/.test(options.url)) return { status: 200, data: { ok: true, result: { per_gb: 100, per_day: 10 } } };
    return createBehavior(options);
  },
}));

const { setSessionClientForTests, clearSessionClientForTests, getSession, setSession } = await import("../../config/sessionStore.js");
const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const { createApiService, cancelApiPurchase, resetApiPurchaseLocksForTests, setApiPurchaseDepsForTests, isDefiniteProviderFailure } = await import("../../handlers/admin/apiServicePurchase.js");
const { resetCallbackGuardForTests, isSensitiveCallback } = await import("../../utils/callbackGuard.js");
const { isActiveForeignAdminPrompt } = await import("../../utils/adminStepSession.js");
const { WizardApiError } = await import("../../api/wizardApi.js");

const GROUP = -100777;
const OWNER = 9001;
const OTHER_ADMIN = 9002;
const OUTSIDER = 5555;

let sessions;
let bot;

beforeEach(() => {
  process.env.ADMINS = "9001,9002";
  sessions = makeSessionClient();
  setSessionClientForTests(sessions);
  bot = makeFakeBot();
  providerRequests.length = 0;
  createBehavior = okService;
  resetApiPurchaseLocksForTests();
  setApiPurchaseDepsForTests({ auditModel: makeAuditModel() });
  resetCallbackGuardForTests();
  mock.method(console, "error", () => {});
});

afterEach(() => {
  clearSessionClientForTests();
  mock.restoreAll();
  mock.method(axios, "create", () => ({
    request: async (options) => {
      providerRequests.push(options);
      if (/status/.test(options.url)) return { status: 200, data: { ok: true, result: { per_gb: 100, per_day: 10 } } };
      return createBehavior(options);
    },
  }));
});

const confirmation = (extra = {}) => ({ step: "waiting_for_api_confirmation", gig: 5, days: 30, per_gb: 100, per_day: 10, totalPrice: 800, messageId: 10, adminUserId: String(OWNER), purchaseId: "a1b2c3d4e5f60718293a", ...extra });
const query = (from, { data = "admin_create_api_service", messageId = 10, id } = {}) => ({
  id: id || `q-${from}-${Math.random()}`, from: { id: from }, data,
  message: { message_id: messageId, chat: { id: GROUP, type: "supergroup" } },
});
const stored = () => getSession(GROUP);
const edits = () => bot.of("editMessageText").map((call) => String(call.args[0]));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe("R-1: one confirmation reaches the provider at most once", () => {
  test("admin_create_api_service is covered by the sensitive-callback dedupe", () => {
    assert.equal(isSensitiveCallback("admin_create_api_service"), true);
  });

  test("a single confirmation buys exactly one service and consumes the confirmation", async () => {
    await setSession(GROUP, confirmation());
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);
    assert.equal(bot.of("sendPhoto").length, 1);
    const after = await stored();
    assert.equal(after.step ?? null, null);
    assert.equal(after.apiPurchase, undefined);
  });

  test("repeating the tap (with the old session copy) never reaches the provider again", async () => {
    const copy = confirmation();
    await setSession(GROUP, copy);
    await createApiService(bot, query(OWNER), copy);
    await createApiService(bot, query(OWNER), copy);
    await createApiService(bot, query(OWNER), copy);
    assert.equal(created().length, 1);
  });

  test("concurrent taps while the provider call is running issue one request", async () => {
    const gate = deferred();
    createBehavior = () => gate.promise;
    await setSession(GROUP, confirmation());
    const first = createApiService(bot, query(OWNER), confirmation());
    const second = createApiService(bot, query(OWNER), confirmation());
    const third = createApiService(bot, query(OWNER), confirmation());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(created().length, 1, "only the first tap may contact the provider");
    gate.resolve(okService());
    await Promise.all([first, second, third]);
    assert.equal(created().length, 1);
    assert.equal(bot.of("sendPhoto").length, 1);
  });

  test("concurrent taps through the real callback router (different message ids) issue one request", async () => {
    const gate = deferred();
    createBehavior = () => gate.promise;
    await setSession(GROUP, confirmation());
    const taps = [
      handleCallbackQuery(bot, query(OWNER, { messageId: 10 })),
      handleCallbackQuery(bot, query(OWNER, { messageId: 11 })),
      handleCallbackQuery(bot, query(OWNER, { messageId: 10 })),
    ];
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve(okService());
    await Promise.all(taps);
    assert.equal(created().length, 1);
  });

  test("while the call is running the session shows a purchase in progress and the confirmation is gone", async () => {
    const gate = deferred();
    createBehavior = () => gate.promise;
    await setSession(GROUP, confirmation());
    const running = createApiService(bot, query(OWNER), confirmation());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mid = await stored();
    assert.equal(mid.step ?? null, null);
    assert.equal(mid.apiPurchase.state, "in_progress");
    gate.resolve(okService());
    await running;
  });

  test("a definite provider rejection can be started over, with one request only", async () => {
    createBehavior = () => { throw Object.assign(new Error("payment required"), { response: { status: 402, data: { ok: false, error: "insufficient balance", http_code: 402 } } }); };
    await setSession(GROUP, confirmation());
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);
    const after = await stored();
    assert.equal(after.step ?? null, null);
    assert.equal(after.apiPurchase, undefined, "no stale in-progress marker may survive a definite failure");
    assert.ok(edits().some((text) => text.includes("خطا در ایجاد سرویس")));
    assert.ok(bot.of("editMessageText").some((call) => JSON.stringify(call.args[1].reply_markup || {}).includes("admin_api_service_purchase")), "retry button offered");

    // A stale tap of the old confirm button still does nothing…
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);

    // …but a deliberately restarted purchase works end to end.
    createBehavior = okService;
    await handleCallbackQuery(bot, query(OWNER, { data: "admin_api_service_purchase", messageId: 20 }));
    assert.equal((await stored()).step, "waiting_for_api_gig");
    // The restarted flow mints a fresh purchase reference (a used one can never be claimed again).
    const restarted = confirmation({ messageId: 20, purchaseId: "0f9e8d7c6b5a49382716" });
    await setSession(GROUP, restarted);
    await createApiService(bot, query(OWNER, { messageId: 20 }), restarted);
    assert.equal(created().length, 2, "the second purchase is a new, explicit confirmation");
  });

  test("a panel-level rejection (ok:false) is a definite failure", async () => {
    createBehavior = () => ({ status: 200, data: { ok: false, message: "insufficient balance" } });
    await setSession(GROUP, confirmation());
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);
    assert.equal((await stored()).apiPurchase, undefined);
  });

  test("invalid figures are rejected before any request leaves the process", async () => {
    await setSession(GROUP, confirmation({ gig: 0.1 }));
    await createApiService(bot, query(OWNER), confirmation({ gig: 0.1 }));
    assert.equal(created().length, 0);
    assert.equal((await stored()).apiPurchase, undefined);
  });

  const AMBIGUOUS = [
    ["a network timeout", () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); }],
    ["a connection reset", () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); }],
    ["a 503 from the provider", () => { throw Object.assign(new Error("unavailable"), { response: { status: 503, data: {} } }); }],
    ["a 408 request timeout", () => { throw Object.assign(new Error("timeout"), { response: { status: 408, data: {} } }); }],
    ["a malformed success response", () => ({ status: 200, data: { ok: true, result: { username: "bad name!", hash: "h" } } })],
    ["a non-object response", () => ({ status: 200, data: "<html>gateway</html>" })],
  ];
  for (const [label, behavior] of AMBIGUOUS) {
    test(`${label} is ambiguous: no retry, confirmation stays consumed, admin is told to verify`, async () => {
      createBehavior = behavior;
      await setSession(GROUP, confirmation());
      await createApiService(bot, query(OWNER), confirmation());
      assert.equal(created().length, 1);
      const after = await stored();
      assert.equal(after.step ?? null, null, "the confirmation must stay consumed");
      assert.equal(after.apiPurchase.state, "uncertain");
      assert.ok(edits().some((text) => text.includes("نامشخص")));
      assert.ok(!bot.of("editMessageText").some((call) => JSON.stringify(call.args[1]?.reply_markup || {}).includes("admin_api_service_purchase")), "no one-tap retry is offered");

      // Neither another tap of the old button nor the stale session copy can repeat it.
      createBehavior = okService;
      await createApiService(bot, query(OWNER), confirmation());
      await handleCallbackQuery(bot, query(OWNER, { messageId: 12 }));
      assert.equal(created().length, 1);
      assert.equal(bot.of("sendPhoto").length, 0);
    });
  }

  test("a delivery failure after a successful purchase is not reported as a failed purchase", async () => {
    bot = makeFakeBot({ failOn: ["sendPhoto"] });
    await setSession(GROUP, confirmation());
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);
    assert.equal(bot.of("sendMessage").length, 1, "the link is still delivered as a plain message");
    assert.ok(!edits().some((text) => text.includes("خطا در ایجاد سرویس")));
    assert.equal((await stored()).apiPurchase, undefined);
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);
  });

  test("even if every delivery attempt fails the session is closed and nothing is retried", async () => {
    bot = makeFakeBot({ failOn: ["sendPhoto", "sendMessage"] });
    await setSession(GROUP, confirmation());
    await createApiService(bot, query(OWNER), confirmation());
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 1);
    assert.equal((await stored()).apiPurchase, undefined);
  });

  test("if the claim cannot be persisted nothing is purchased", async () => {
    await setSession(GROUP, confirmation());
    const seeded = sessions.map.get(`session:${GROUP}`);
    sessions.set = async () => "OK"; // writes are silently dropped, as when the store is unavailable
    assert.equal(sessions.map.get(`session:${GROUP}`), seeded);
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 0);
  });

  test("isDefiniteProviderFailure only trusts failures that precede the request", () => {
    assert.equal(isDefiniteProviderFailure(new TypeError("gig must be")), true);
    assert.equal(isDefiniteProviderFailure(new WizardApiError("create", { status: 402, code: "provider_insufficient_balance", ambiguous: false })), true);
    assert.equal(isDefiniteProviderFailure(new WizardApiError("create", { status: 402, ambiguous: false })), false, "a bare status is not proof");
    assert.equal(isDefiniteProviderFailure(new WizardApiError("create", { status: 408, ambiguous: false })), false);
    assert.equal(isDefiniteProviderFailure(new WizardApiError("create", { status: 503, ambiguous: true })), false);
    assert.equal(isDefiniteProviderFailure(new WizardApiError("create", { ambiguous: true })), false);
    assert.equal(isDefiniteProviderFailure(new Error("WIZARD_API_URL is not configured")), false, "unknown errors fail closed");
    assert.equal(isDefiniteProviderFailure(undefined), false);
  });

  test("a running purchase blocks cancelling and restarting; nothing is replaced", async () => {
    const gate = deferred();
    createBehavior = () => gate.promise;
    await setSession(GROUP, confirmation());
    const running = createApiService(bot, query(OWNER), confirmation());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = sessions.map.get(`session:${GROUP}`);
    const editsBefore = bot.of("editMessageText").length;
    await cancelApiPurchase(bot, query(OWNER, { data: "admin_cancel_api_purchase" }));
    await handleCallbackQuery(bot, query(OTHER_ADMIN, { data: "admin_api_service_purchase" }));
    await handleCallbackQuery(bot, query(OWNER, { data: "admin_cancel_api_purchase" }));
    assert.equal(sessions.map.get(`session:${GROUP}`), before);
    assert.equal(bot.of("editMessageText").length, editsBefore);
    gate.resolve(okService());
    await running;
  });
});

describe("R-3: confirmation only from the confirmation step", () => {
  for (const step of ["waiting_for_api_gig", "waiting_for_api_days", "admin_waiting_for_message", "waiting_for_payment_method", null, undefined]) {
    test(`step ${String(step)} cannot confirm (stored and passed copies)`, async () => {
      const wrong = confirmation({ step });
      await setSession(GROUP, wrong);
      const before = sessions.map.get(`session:${GROUP}`);
      await createApiService(bot, query(OWNER), wrong);
      assert.equal(created().length, 0);
      assert.equal(bot.calls.length, 0, "no message edited, nothing answered");
      assert.equal(sessions.map.get(`session:${GROUP}`), before);
    });
  }

  test("a stale passed session cannot confirm when the stored session has moved on", async () => {
    await setSession(GROUP, confirmation({ step: "waiting_for_api_days" }));
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 0);
    assert.equal(bot.calls.length, 0);
  });

  test("an empty store cannot be confirmed from a caller-supplied session", async () => {
    await createApiService(bot, query(OWNER), confirmation());
    assert.equal(created().length, 0);
    assert.equal(bot.calls.length, 0);
  });

  for (const [label, patch] of [["missing gig", { gig: undefined }], ["zero days", { days: 0 }], ["fractional days", { days: 2.5 }], ["text gig", { gig: "lots" }], ["negative gig", { gig: -3 }]]) {
    test(`malformed figures (${label}) are rejected before any edit or request`, async () => {
      const bad = confirmation(patch);
      await setSession(GROUP, bad);
      await createApiService(bot, query(OWNER), bad);
      assert.equal(created().length, 0);
      assert.equal(bot.calls.length, 0);
    });
  }

  test("another admin and an outsider still cannot confirm", async () => {
    await setSession(GROUP, confirmation());
    await createApiService(bot, query(OTHER_ADMIN), confirmation());
    await createApiService(bot, query(OUTSIDER), confirmation());
    assert.equal(created().length, 0);
    assert.equal(bot.calls.length, 0);
  });
});

describe("R-2: back and cancel buttons cannot wipe another admin's active prompt", () => {
  const prompt = (extra = {}) => ({ step: "admin_waiting_for_message", targetUserId: "12345", messageId: 10, adminUserId: String(OWNER), ...extra });
  const raw = () => sessions.map.get(`session:${GROUP}`) ?? null;
  const mutating = () => ["sendMessage", "editMessageText", "deleteMessage", "sendPhoto"].flatMap((method) => bot.of(method));

  for (const data of ["back_to_home", "back_to_topup"]) {
    for (const [who, id] of [["an outsider", OUTSIDER], ["a different admin", OTHER_ADMIN]]) {
      test(`${data} by ${who} leaves the owner's prompt and the messages untouched`, async () => {
        await setSession(GROUP, prompt());
        const before = raw();
        await handleCallbackQuery(bot, query(id, { data, messageId: 77 }));
        assert.equal(raw(), before);
        assert.equal(mutating().length, 0);
      });
    }

    test(`${data} by the owner still clears the prompt (existing behavior)`, async () => {
      await setSession(GROUP, prompt());
      await handleCallbackQuery(bot, query(OWNER, { data, messageId: 77 }));
      const after = await stored();
      assert.equal(after.adminUserId, undefined);
      assert.notEqual(after.step, "admin_waiting_for_message");
    });

    test(`${data} is unchanged for a customer's own payment prompt in a private chat`, async () => {
      // Customer flows live in private chats; the admin-group rule must not change them.
      const PRIVATE = 5555;
      await setSession(PRIVATE, { step: "waiting_for_hoosh_amount", messageId: 5 });
      await handleCallbackQuery(bot, { id: "qp", from: { id: PRIVATE }, data, message: { message_id: 77, chat: { id: PRIVATE, type: "private" } } });
      const after = JSON.parse(sessions.map.get(`session:${PRIVATE}`) ?? "null");
      assert.notEqual(after?.step, "waiting_for_hoosh_amount", "a user's own payment prompt is still cleared");
    });

    test(`${data} by a non-admin in the admin group is ignored entirely`, async () => {
      await setSession(GROUP, { step: "waiting_for_hoosh_amount", messageId: 5 });
      const before = raw();
      await handleCallbackQuery(bot, query(OUTSIDER, { data, messageId: 77 }));
      assert.equal(raw(), before);
      assert.equal(mutating().length, 0);
    });

    test(`${data} may clear an expired foreign prompt`, async () => {
      await setSession(GROUP, prompt());
      const old = JSON.parse(raw());
      old.updatedAt = Date.now() - 2 * 60 * 60 * 1000;
      sessions.map.set(`session:${GROUP}`, JSON.stringify(old));
      await handleCallbackQuery(bot, query(OTHER_ADMIN, { data, messageId: 77 }));
      assert.notEqual((await stored()).step, "admin_waiting_for_message");
    });

    test(`${data} cannot clear an ownerless admin prompt either (fail closed)`, async () => {
      const { adminUserId, ...legacy } = prompt();
      await setSession(GROUP, legacy);
      const before = raw();
      await handleCallbackQuery(bot, query(OTHER_ADMIN, { data, messageId: 77 }));
      assert.equal(raw(), before);
    });
  }

  test("every protected step is covered", async () => {
    for (const step of ["admin_waiting_for_hoosh_search", "admin_waiting_for_user_id", "admin_waiting_for_message", "waiting_for_config_details", "waiting_for_vpn_id", "waiting_for_api_gig", "waiting_for_api_days", "waiting_for_api_confirmation"]) {
      await setSession(GROUP, prompt({ step }));
      const before = raw();
      await handleCallbackQuery(bot, query(OUTSIDER, { data: "back_to_home", messageId: 77 }));
      assert.equal(raw(), before, step);
    }
  });

  test("admin_cancel_api_purchase by a non-owner leaves the owner's purchase prompt alone", async () => {
    await setSession(GROUP, confirmation());
    const before = raw();
    await cancelApiPurchase(bot, query(OTHER_ADMIN, { data: "admin_cancel_api_purchase" }));
    await handleCallbackQuery(bot, query(OUTSIDER, { data: "admin_cancel_api_purchase" }));
    await handleCallbackQuery(bot, query(OTHER_ADMIN, { data: "admin_cancel_api_purchase" }));
    assert.equal(raw(), before);
    assert.equal(bot.of("editMessageText").length, 0);
  });

  test("admin_cancel_api_purchase by the owner cancels as before", async () => {
    await setSession(GROUP, confirmation());
    await handleCallbackQuery(bot, query(OWNER, { data: "admin_cancel_api_purchase" }));
    assert.equal((await stored()).step ?? null, null);
    assert.ok(edits().some((text) => text.includes("لغو شد")));
  });

  test("admin_cancel_api_purchase with no session at all still works", async () => {
    await handleCallbackQuery(bot, query(OWNER, { data: "admin_cancel_api_purchase" }));
    assert.ok(edits().some((text) => text.includes("لغو شد")));
  });

  test("isActiveForeignAdminPrompt", () => {
    const base = { chatId: GROUP, userId: OTHER_ADMIN };
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: prompt() }), true);
    assert.equal(isActiveForeignAdminPrompt({ ...base, userId: OWNER, session: prompt() }), false, "the owner may clear");
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: { step: "waiting_for_hoosh_amount" } }), false);
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: {} }), false);
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: null }), false);
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: { step: null, apiPurchase: { state: "in_progress" }, adminUserId: String(OWNER) } }), true);
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: { step: null, apiPurchase: { state: "uncertain" }, adminUserId: String(OWNER) } }), false);
    assert.equal(isActiveForeignAdminPrompt({ ...base, session: prompt({ updatedAt: 1 }) }), false, "expired");
    process.env.ADMINS = "9002";
    assert.equal(isActiveForeignAdminPrompt({ ...base, userId: OWNER, session: prompt() }), true, "an owner who lost admin rights no longer owns it");
  });
});
