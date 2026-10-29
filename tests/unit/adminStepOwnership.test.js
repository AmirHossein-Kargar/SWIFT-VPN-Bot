/**
 * F-01 regression: privileged admin text steps are bound to the admin who opened them.
 *
 * The prompts keep their state in the admin GROUP's session (one key per chat), so before
 * the fix any group member could answer a prompt another admin had opened. Everything
 * here runs on fakes: an in-memory session store, a fake Telegram bot, stubbed Mongoose
 * model statics and a stubbed provider HTTP client. Nothing touches Telegram, MongoDB,
 * Redis or a financial provider.
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

// Created before the provider client is first used, so no real HTTP client ever exists.
const providerRequests = [];
mock.method(axios, "create", () => ({
  request: async (options) => {
    providerRequests.push(options);
    return { status: 200, data: { ok: true, result: { per_gb: 100, per_day: 10, username: "svc_new", hash: "abc123" } } };
  },
}));

const { setSessionClientForTests, clearSessionClientForTests, getSession, setSession } = await import("../../config/sessionStore.js");
const { default: handleMessage } = await import("../../handlers/onMessage.js");
const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const { createApiService, setApiPurchaseDepsForTests } = await import("../../handlers/admin/apiServicePurchase.js");
const { resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js");
const { canContinueAdminStep, adminOwnerFields } = await import("../../utils/adminStepSession.js");
const { default: User } = await import("../../models/User.js");
const { default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js");

const GROUP = -100777;
const OWNER = 9001; // opened the prompt
const OTHER_ADMIN = 9002; // authorized admin, but not the one who opened it
const OUTSIDER = 5555; // group member who is not an admin

let sessions;
let bot;
let userFinds;
let userSaves;
let invoiceFinds;
let nextId = 700;

beforeEach(() => {
  process.env.ADMINS = "9001,9002";
  sessions = makeSessionClient();
  setSessionClientForTests(sessions);
  bot = makeFakeBot();
  providerRequests.length = 0;
  userFinds = 0;
  userSaves = 0;
  invoiceFinds = 0;
  resetCallbackGuardForTests();
  setApiPurchaseDepsForTests({ auditModel: makeAuditModel() });
  mock.method(User, "findOne", async () => {
    userFinds += 1;
    return { telegramId: "12345", firstName: "Ali", services: [], totalServices: 0, save: async () => { userSaves += 1; } };
  });
  mock.method(HooshPayInvoice, "findOne", async () => { invoiceFinds += 1; return null; });
});

afterEach(() => {
  clearSessionClientForTests();
  mock.restoreAll();
  mock.method(axios, "create", () => ({ request: async (options) => { providerRequests.push(options); return { status: 200, data: { ok: true, result: { per_gb: 100, per_day: 10, username: "svc_new", hash: "abc123" } } }; } }));
});

const groupMsg = (from, extra = {}) => ({
  message_id: ++nextId,
  chat: { id: GROUP, type: "supergroup" },
  from: { id: from, first_name: "X" },
  ...extra,
});
const rawSession = () => sessions.map.get(`session:${GROUP}`) ?? null;
const owned = (fields) => ({ ...fields, adminUserId: String(OWNER) });

/** Every affected text step: its session, the reply that continues it, and what success looks like. */
const STEPS = [
  {
    name: "HooshPay invoice search",
    session: owned({ step: "admin_waiting_for_hoosh_search", hooshSearchType: "uid", messageId: 10 }),
    message: (from) => groupMsg(from, { text: "HP-abc" }),
    // "Not found" edits the original prompt (session.messageId) in place
    // instead of sending a second message.
    succeeded: () => invoiceFinds === 1 && bot.of("editMessageText").length === 1,
  },
  {
    name: "support-message target lookup",
    session: owned({ step: "admin_waiting_for_user_id", action: "send_message_to_user", messageId: 10 }),
    message: (from) => groupMsg(from, { text: "12345" }),
    succeeded: async () => {
      const next = await getSession(GROUP);
      return userFinds === 1 && next.step === "admin_waiting_for_message" && next.adminUserId === String(OWNER);
    },
  },
  {
    name: "support-message sending",
    session: owned({ step: "admin_waiting_for_message", targetUserId: "12345", messageId: 10 }),
    message: (from) => groupMsg(from, { text: "hello from support" }),
    succeeded: () => bot.of("sendMessage").some((call) => call.args[0] === 12345),
  },
  {
    name: "configuration details",
    session: owned({ step: "waiting_for_config_details", targetUserId: "12345", messageId: 10 }),
    message: (from) => groupMsg(from, { text: "vless://cfg", reply_to_message: { message_id: 10 } }),
    succeeded: () => bot.of("sendMessage").some((call) => call.args[0] === 12345),
  },
  {
    name: "VPN ID assignment",
    session: owned({ step: "waiting_for_vpn_id", targetTelegramId: "12345", messageId: 10 }),
    message: (from) => groupMsg(from, { text: "svc-0001", reply_to_message: { message_id: 10 } }),
    succeeded: () => userSaves === 1,
  },
  {
    name: "API purchase: gigabytes",
    session: owned({ step: "waiting_for_api_gig", per_gb: 100, per_day: 10, messageId: 10 }),
    message: (from) => groupMsg(from, { text: "5" }),
    succeeded: async () => {
      const next = await getSession(GROUP);
      return next.step === "waiting_for_api_days" && next.gig === 5 && next.adminUserId === String(OWNER);
    },
  },
  {
    name: "API purchase: days",
    session: owned({ step: "waiting_for_api_days", per_gb: 100, per_day: 10, gig: 5, gigPrice: 500, messageId: 10 }),
    message: (from) => groupMsg(from, { text: "30" }),
    succeeded: async () => {
      const next = await getSession(GROUP);
      return next.step === "waiting_for_api_confirmation" && next.days === 30 && next.adminUserId === String(OWNER);
    },
  },
];

function assertNoSideEffects(before) {
  assert.equal(bot.calls.length, 0, "no Telegram call (send, edit, delete or answer) may happen");
  assert.equal(userFinds, 0, "no user lookup");
  assert.equal(userSaves, 0, "no user/service change");
  assert.equal(invoiceFinds, 0, "no invoice lookup");
  assert.equal(providerRequests.length, 0, "no provider (purchase) request");
  assert.equal(rawSession(), before, "the session must be left exactly as it was");
}

describe("admin text steps: only the initiating, still-authorized admin may continue", () => {
  for (const step of STEPS) {
    describe(step.name, () => {
      test("the initiating admin completes it", async () => {
        await setSession(GROUP, step.session);
        await handleMessage(bot, step.message(OWNER));
        assert.equal(await step.succeeded(), true);
      });

      test("a group member who is not an admin is ignored without side effects", async () => {
        await setSession(GROUP, step.session);
        const before = rawSession();
        await handleMessage(bot, step.message(OUTSIDER));
        assertNoSideEffects(before);
      });

      test("a different authorized admin cannot continue another admin's flow", async () => {
        await setSession(GROUP, step.session);
        const before = rawSession();
        await handleMessage(bot, step.message(OTHER_ADMIN));
        assertNoSideEffects(before);
      });

      test("the owner loses access when no longer an authorized admin", async () => {
        await setSession(GROUP, step.session);
        const before = rawSession();
        process.env.ADMINS = "9002";
        await handleMessage(bot, step.message(OWNER));
        assertNoSideEffects(before);
      });

      test("a message with no sender is ignored", async () => {
        await setSession(GROUP, step.session);
        const before = rawSession();
        const message = step.message(OWNER);
        delete message.from;
        await handleMessage(bot, message);
        assertNoSideEffects(before);
      });

      test("fails closed when the session has no owner, even for an admin", async () => {
        const { adminUserId, ...legacy } = step.session;
        await setSession(GROUP, legacy);
        const before = rawSession();
        await handleMessage(bot, step.message(OWNER));
        assertNoSideEffects(before);
      });

      for (const [label, badOwner] of [["non-numeric", "owner"], ["zero", "0"], ["object", { $ne: null }], ["numeric string with junk", "9001 "]]) {
        test(`fails closed on a malformed owner (${label})`, async () => {
          await setSession(GROUP, { ...step.session, adminUserId: badOwner });
          const before = rawSession();
          await handleMessage(bot, step.message(OWNER));
          assertNoSideEffects(before);
        });
      }
    });
  }

  test("an outsider cannot expire or clear someone else's stale prompt", async () => {
    await setSession(GROUP, owned({ step: "admin_waiting_for_message", targetUserId: "12345", messageId: 10 }));
    const stale = JSON.parse(rawSession());
    stale.updatedAt = Date.now() - 2 * 60 * 60 * 1000;
    sessions.map.set(`session:${GROUP}`, JSON.stringify(stale));
    const before = rawSession();
    await handleMessage(bot, groupMsg(OUTSIDER, { text: "anything" }));
    assertNoSideEffects(before);
  });

  test("the owner still gets the existing expiry notice for their own stale prompt", async () => {
    await setSession(GROUP, owned({ step: "admin_waiting_for_message", targetUserId: "12345", messageId: 10 }));
    const stale = JSON.parse(rawSession());
    stale.updatedAt = Date.now() - 2 * 60 * 60 * 1000;
    sessions.map.set(`session:${GROUP}`, JSON.stringify(stale));
    await handleMessage(bot, groupMsg(OWNER, { text: "late" }));
    assert.equal(bot.of("sendMessage").length, 1);
    assert.equal(rawSession(), null);
  });

  test("a session object smuggled on the message cannot stand in for the stored one", async () => {
    // The stored session is empty; only the message claims a VPN-ID prompt.
    const message = groupMsg(OUTSIDER, { text: "svc-0001", reply_to_message: { message_id: 10 } });
    message.session = owned({ step: "waiting_for_vpn_id", targetTelegramId: "12345", messageId: 10 });
    await handleMessage(bot, message);
    assert.equal(userFinds, 0);
    assert.equal(userSaves, 0);
  });
});

describe("API purchase confirmation", () => {
  const confirmSession = owned({ step: "waiting_for_api_confirmation", gig: 5, days: 30, per_gb: 100, per_day: 10, totalPrice: 800, messageId: 10, purchaseId: "a1b2c3d4e5f60718293a" });
  const confirmQuery = (from) => ({ id: `q-${from}`, from: { id: from }, data: "admin_create_api_service", message: { message_id: 10, chat: { id: GROUP, type: "supergroup" } } });

  test("the initiating admin can confirm and the service is requested once", async () => {
    // The stored session is authoritative (the passed copy may be stale), so it must be seeded.
    await setSession(GROUP, confirmSession);
    await createApiService(bot, confirmQuery(OWNER), confirmSession);
    assert.equal(providerRequests.filter((request) => /create/i.test(request.url)).length, 1);
  });

  for (const [label, from] of [["an outsider", OUTSIDER], ["a different admin", OTHER_ADMIN]]) {
    test(`${label} cannot confirm another admin's purchase`, async () => {
      await createApiService(bot, confirmQuery(from), confirmSession);
      assert.equal(bot.calls.length, 0);
      assert.equal(providerRequests.length, 0);
    });
  }

  test("a confirmation session without an owner is refused", async () => {
    const { adminUserId, ...legacy } = confirmSession;
    await createApiService(bot, confirmQuery(OWNER), legacy);
    assert.equal(bot.calls.length, 0);
    assert.equal(providerRequests.length, 0);
  });
});

describe("prompts record their owner when they are opened", () => {
  const query = (data, from = OWNER, messageId = 42) => ({ id: `cb-${data}`, from: { id: from }, data, message: { message_id: messageId, chat: { id: GROUP, type: "supergroup" } } });

  for (const [data, step] of [
    ["admin_send_message_to_user", "admin_waiting_for_user_id"],
    ["send_config_to_user_12345", "waiting_for_config_details"],
    ["register_vpn_id:12345", "waiting_for_vpn_id"],
    ["admin_hoosh_search_prompt:uid", "admin_waiting_for_hoosh_search"],
    ["admin_api_service_purchase", "waiting_for_api_gig"],
  ]) {
    test(`${data} binds ${step} to the admin who tapped it`, async () => {
      await handleCallbackQuery(bot, query(data, OWNER));
      const stored = await getSession(GROUP);
      assert.equal(stored.step, step);
      assert.equal(stored.adminUserId, String(OWNER));
    });

    test(`${data} from an outsider opens nothing`, async () => {
      await handleCallbackQuery(bot, query(data, OUTSIDER));
      assert.equal(rawSession(), null);
    });
  }

  test("a flow opened by one admin cannot be answered by the admin who opened a different one earlier", async () => {
    await handleCallbackQuery(bot, query("admin_send_message_to_user", OWNER));
    await handleCallbackQuery(bot, query("admin_hoosh_search_prompt:uid", OTHER_ADMIN, 43));
    assert.equal((await getSession(GROUP)).adminUserId, String(OTHER_ADMIN));
    bot.calls.length = 0;
    await handleMessage(bot, groupMsg(OWNER, { text: "HP-abc" }));
    assert.equal(invoiceFinds, 0, "the first admin's reply must not drive the second admin's prompt");
    assert.equal(bot.calls.length, 0);
  });
});

describe("canContinueAdminStep", () => {
  test("requires the exact recorded owner and current authorization", () => {
    const session = { adminUserId: "9001" };
    assert.equal(canContinueAdminStep({ session, chatId: GROUP, userId: 9001 }), true);
    assert.equal(canContinueAdminStep({ session, chatId: GROUP, userId: "9001" }), true);
    assert.equal(canContinueAdminStep({ session, chatId: GROUP, userId: 9002 }), false);
    assert.equal(canContinueAdminStep({ session, chatId: -100999, userId: 9001 }), false, "wrong chat");
    assert.equal(canContinueAdminStep({ session: {}, chatId: GROUP, userId: 9001 }), false);
    assert.equal(canContinueAdminStep({ session: null, chatId: GROUP, userId: 9001 }), false);
    assert.equal(canContinueAdminStep({ session, chatId: GROUP, userId: undefined }), false);
  });

  test("adminOwnerFields refuses to record an invalid id", () => {
    assert.deepEqual(adminOwnerFields(9001), { adminUserId: "9001" });
    assert.deepEqual(adminOwnerFields(undefined), { adminUserId: null });
    assert.deepEqual(adminOwnerFields("abc"), { adminUserId: null });
    assert.deepEqual(adminOwnerFields(-5), { adminUserId: null });
  });
});
