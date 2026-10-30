/**
 * The order status message, driven through the real callback handler and purchase path against a REAL MongoDB. The one
 * confirmation message becomes "⏳ processing" and then the outcome; the wallet, order and notice guarantees must hold
 * however Telegram behaves. WizardXray is a local HTTP stub and Telegram a stub that can refuse chosen calls.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { makeSessionClient } from "../helpers/fakeSupport.js";

const PRICE = 25_000; // customer plan "mini"
const PROCESSING = "⏳ <b>در حال ثبت سفارش شما...</b>";
const RESERVED = "✅ سفارش شما ثبت و مبلغ آن از کیف پولتان رزرو شد.\nسرویس در انتظار تأمین موجودی ارائه‌دهنده است و پس از آماده‌شدن، لینک اتصال برای شما ارسال می‌شود.\nنیازی به ثبت سفارش مجدد نیست.";
const INSUFFICIENT = "⚠️ موجودی شما کافی نیست. لطفاً ابتدا حساب خود را شارژ کنید.";
const REFUNDED = "❌ ایجاد سرویس انجام نشد و مبلغ رزروشده به کیف پول شما بازگشت.";
const COMPLETED = "✅ سرویس ساخته و به حساب شما اضافه شد. لینک‌های سرویس در پیام بعدی ارسال می‌شوند.";

const CANT_EDIT = "ETELEGRAM: 400 Bad Request: message can't be edited";
const NOT_FOUND = "ETELEGRAM: 400 Bad Request: message to edit not found";
const NOT_MODIFIED = "ETELEGRAM: 400 Bad Request: message is not modified: specified new message content and reply markup are exactly the same";
const BLOCKED = "ETELEGRAM: 403 Forbidden: bot was blocked by the user";

let wizard;
let wizardMode = "ok";
let wizardCalls = 0;
let releaseWizard = null;

const savedEnv = { ADMINS: process.env.ADMINS, GROUP_ID: process.env.GROUP_ID, WIZARD_API_URL: process.env.WIZARD_API_URL, VPN_API_KEY: process.env.VPN_API_KEY };

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.ADMINS = "9001";
  process.env.GROUP_ID = "";
  wizard = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      wizardCalls += 1;
      if (releaseWizard) await releaseWizard;
      res.setHeader("Content-Type", "application/json");
      if (wizardMode === "insufficient") return res.end(JSON.stringify({ ok: false, error: "panel: insufficient balance" }));
      if (wizardMode === "api_error") return res.end(JSON.stringify({ ok: false, error: "provider rejected request" }));
      res.end(JSON.stringify({
        ok: true,
        result: {
          username: `stub_${wizardCalls}_${Math.random().toString(36).slice(2, 7)}`,
          hash: "abc123hash",
          sub_link: "https://panel.example.test/sub/abc123hash",
          tak_links: [],
        },
      }));
    });
  });
  await new Promise((resolve) => wizard.listen(0, "127.0.0.1", resolve));
  process.env.WIZARD_API_URL = `http://127.0.0.1:${wizard.address().port}`;
  process.env.VPN_API_KEY = "fake-test-key-never-a-real-credential";
});

const dbAvailable = await connectTestDB();

let User, WalletPurchase, handleCallbackQuery, orderService, reservedAlerts, fulfillment, resetCallbackGuardForTests, sessionStore;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js"));
  orderService = (await import("../../services/buyService/orderService.js")).default;
  reservedAlerts = await import("../../services/buyService/reservedAlerts.js");
  fulfillment = await import("../../services/buyService/reservedFulfillment.js");
  ({ resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js"));
  sessionStore = await import("../../config/sessionStore.js");
}

after(async () => {
  if (wizard) await new Promise((resolve) => wizard.close(resolve));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  sessionStore?.clearSessionClientForTests();
  await disconnectTestDB();
});

const dbTest = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

/** Telegram stub. `refuseEdit(text, messageId)` / `refuseSend(text)` return an error message to fail that call. */
function telegram({ refuseEdit = () => null, refuseSend = () => null } = {}) {
  const log = [];
  let nextMessageId = 900;
  return {
    log,
    edits: () => log.filter((entry) => entry.kind === "edit"),
    sends: () => log.filter((entry) => entry.kind === "send"),
    photos: () => log.filter((entry) => entry.kind === "photo"),
    answers: () => log.filter((entry) => entry.kind === "answer"),
    async editMessageText(text, options) {
      const refusal = refuseEdit(text, options.message_id);
      log.push({ kind: "edit", text, messageId: options.message_id, chatId: options.chat_id, refused: Boolean(refusal) });
      if (refusal) throw new Error(refusal);
      return true;
    },
    async sendMessage(chatId, text) {
      const refusal = refuseSend(text);
      log.push({ kind: "send", chatId, text, refused: Boolean(refusal) });
      if (refusal) throw new Error(refusal);
      return { message_id: nextMessageId++ };
    },
    async sendPhoto(chatId) {
      log.push({ kind: "photo", chatId });
      return { message_id: nextMessageId++ };
    },
    async answerCallbackQuery(id) {
      log.push({ kind: "answer", id });
      return true;
    },
  };
}

let counter = 0;
async function customer(balance = 50_000) {
  counter += 1;
  const telegramId = String(7_100_000 + counter);
  await User.create({ telegramId, balance });
  return telegramId;
}

const tap = (telegramId, { messageId = 55, plan = "mini" } = {}) => ({
  id: `q-${telegramId}-${messageId}`,
  from: { id: Number(telegramId) },
  data: `confirm_order_${plan}`,
  message: { message_id: messageId, chat: { id: Number(telegramId), type: "private" } },
});

const balance = async (telegramId) => (await User.findOne({ telegramId }).lean()).balance;
const orders = (telegramId) => WalletPurchase.find({ telegramId }).lean();

beforeEach(() => {
  wizardMode = "ok";
  wizardCalls = 0;
  releaseWizard = null;
  resetCallbackGuardForTests?.();
  sessionStore?.setSessionClientForTests(makeSessionClient());
});

describe("reserved order: the one message becomes the outcome", () => {
  dbTest("sends the processing text once, edits the same message to the exact notice and sends no second message", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.deepEqual(bot.edits().map((edit) => [edit.text, edit.messageId]), [[PROCESSING, 55], [RESERVED, 55]]);
    assert.equal(bot.edits()[1].chatId, Number(telegramId));
    assert.equal(bot.sends().length, 0, "no second message when the edit succeeds");
    assert.equal(bot.answers().length, 1);
    const [order] = await orders(telegramId);
    assert.equal(order.status, "awaiting_provider");
    assert.equal(order.walletDebitStatus, "reserved");
    assert.equal(order.customerNoticePending, false);
    assert.ok(order.customerNotifiedAt);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });

  dbTest("the success text is written only after the order and the debit exist", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const seen = [];
    const bot = telegram();
    const edit = bot.editMessageText.bind(bot);
    bot.editMessageText = async (text, options) => {
      if (text === RESERVED) {
        const [order] = await orders(telegramId);
        seen.push({ status: order.status, debit: order.walletDebitStatus, balance: await balance(telegramId) });
      }
      return edit(text, options);
    };

    await handleCallbackQuery(bot, tap(telegramId));

    assert.deepEqual(seen, [{ status: "awaiting_provider", debit: "reserved", balance: 50_000 - PRICE }]);
  });

  dbTest("the callback is acknowledged before the processing edit and before the provider is called", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    let callsAtAck = null;
    const bot = telegram();
    const answer = bot.answerCallbackQuery.bind(bot);
    bot.answerCallbackQuery = async (id) => { callsAtAck = wizardCalls; return answer(id); };

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal(bot.log[0].kind, "answer");
    assert.equal(callsAtAck, 0);
  });
});

describe("failed orders never read as success", () => {
  dbTest("an insufficient wallet edits the message to the existing error and debits nothing", async () => {
    const telegramId = await customer(100);
    const bot = telegram();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.deepEqual(bot.edits().map((edit) => edit.text), [PROCESSING, INSUFFICIENT]);
    assert.equal(bot.sends().length, 0);
    assert.equal(wizardCalls, 0);
    assert.equal(await balance(telegramId), 100);
    assert.equal((await orders(telegramId))[0].status, "failed");
  });

  dbTest("a provider rejection reports the refund, and only after the refund landed", async () => {
    wizardMode = "api_error";
    const telegramId = await customer();
    const bot = telegram();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.deepEqual(bot.edits().map((edit) => edit.text), [PROCESSING, REFUNDED]);
    assert.equal(bot.log.some((entry) => entry.text === RESERVED), false);
    assert.equal(await balance(telegramId), 50_000);
    assert.equal((await orders(telegramId))[0].status, "refunded");
  });

  dbTest("an unavailable plan reports the existing error and creates no order", async () => {
    const telegramId = await customer();
    const bot = telegram();

    await orderService(bot, telegramId, telegramId, "no-such-plan", { messageId: 55 });

    assert.equal(bot.edits().at(-1).text, "❌ این پلن در حال حاضر فعال نیست یا حذف شده است. لطفاً از منوی خرید دوباره انتخاب کنید.");
    assert.equal(bot.sends().length, 0);
    assert.equal((await orders(telegramId)).length, 0);
  });
});

describe("completed order", () => {
  dbTest("the status message is closed in place and the links stay one separate photo", async () => {
    const telegramId = await customer();
    const bot = telegram();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.deepEqual(bot.edits().map((edit) => edit.text), [PROCESSING, COMPLETED]);
    assert.equal(bot.photos().length, 1);
    assert.equal(bot.sends().length, 0);
    assert.equal((await orders(telegramId))[0].status, "completed");
  });

  dbTest("a refused closing edit adds no message once the links were delivered", async () => {
    const telegramId = await customer();
    const bot = telegram({ refuseEdit: (text) => (text === COMPLETED ? CANT_EDIT : null) });

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal(bot.photos().length, 1);
    assert.equal(bot.sends().length, 0);
  });
});

describe("edit failures fall back without touching money", () => {
  for (const [label, error] of [["deleted", NOT_FOUND], ["too old", CANT_EDIT]]) {
    dbTest(`a ${label} message gets exactly one fallback notice and one reservation`, async () => {
      wizardMode = "insufficient";
      const telegramId = await customer();
      const bot = telegram({ refuseEdit: (text) => (text === RESERVED ? error : null) });

      await handleCallbackQuery(bot, tap(telegramId));

      assert.deepEqual(bot.sends().map((send) => [String(send.chatId), send.text]), [[telegramId, RESERVED]]);
      assert.equal((await orders(telegramId)).length, 1);
      assert.equal(wizardCalls, 1);
      assert.equal(await balance(telegramId), 50_000 - PRICE);
      assert.equal((await orders(telegramId))[0].customerNoticePending, false);
    });
  }

  dbTest("when the processing edit fails, the fresh processing message is the one the outcome edits", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram({ refuseEdit: (_text, messageId) => (messageId === 55 ? CANT_EDIT : null) });

    await handleCallbackQuery(bot, tap(telegramId));

    assert.deepEqual(bot.sends().map((send) => send.text), [PROCESSING], "processing is sent exactly once");
    assert.deepEqual(bot.edits().at(-1), { kind: "edit", text: RESERVED, messageId: 900, chatId: Number(telegramId), refused: false });
  });

  dbTest("'not modified' on the status message counts as delivered, so no copy is sent", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram({ refuseEdit: (text) => (text === RESERVED ? NOT_MODIFIED : null) });

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal(bot.sends().length, 0);
    assert.equal((await orders(telegramId))[0].customerNoticePending, false);
  });

  dbTest("the callback is acknowledged when every edit fails, and when the fallback fails too", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram({ refuseEdit: () => CANT_EDIT, refuseSend: () => BLOCKED });

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal(bot.answers().length, 1);
    assert.equal(bot.log[0].kind, "answer");
    assert.equal((await orders(telegramId)).length, 1);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });
});

describe("retries and concurrency", () => {
  dbTest("concurrent taps create one order, one reservation, one processing message and one notice", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram();
    let release;
    releaseWizard = new Promise((resolve) => { release = resolve; });

    const first = orderService(bot, telegramId, telegramId, "mini", { messageId: 55 });
    while (wizardCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await orderService(bot, telegramId, telegramId, "mini", { messageId: 55 });
    release();
    await first;

    assert.equal(second.failure, "already_in_flight");
    assert.equal(bot.edits().filter((edit) => edit.text === PROCESSING).length, 1);
    assert.equal(bot.edits().filter((edit) => edit.text === RESERVED).length, 1);
    assert.equal(bot.sends().length, 0);
    assert.equal(wizardCalls, 1);
    assert.equal((await orders(telegramId)).length, 1);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });

  dbTest("through the handler, a burst of taps also ends with one order and one notice", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram();

    await Promise.all([1, 2, 3].map(() => handleCallbackQuery(bot, tap(telegramId))));

    assert.equal(bot.log.filter((entry) => entry.text === RESERVED).length, 1);
    assert.equal(bot.answers().length, 3);
    assert.equal(wizardCalls, 1);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });

  dbTest("a later redelivery keeps the notice in place: no ⏳ over it and no new message", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram();
    await handleCallbackQuery(bot, tap(telegramId));
    const before = bot.log.length;
    resetCallbackGuardForTests();

    await handleCallbackQuery(bot, tap(telegramId));

    const replay = bot.log.slice(before);
    assert.equal(replay.some((entry) => entry.text === PROCESSING), false);
    assert.equal(replay.filter((entry) => entry.kind === "send").length, 0);
    assert.equal(wizardCalls, 1);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });

  dbTest("a retry after a fallback notice adds no second notice even when its edit fails too", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram({ refuseEdit: (text) => (text === RESERVED ? CANT_EDIT : null) });
    await handleCallbackQuery(bot, tap(telegramId));
    resetCallbackGuardForTests();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal(bot.sends().length, 1, "the fallback notice is the only one");
    assert.equal((await orders(telegramId)).length, 1);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });

  dbTest("a retried completed order delivers its links once and adds no message", async () => {
    const telegramId = await customer();
    const bot = telegram();
    await handleCallbackQuery(bot, tap(telegramId));
    resetCallbackGuardForTests();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal(bot.photos().length, 1);
    assert.equal(bot.sends().length, 0);
    assert.equal(wizardCalls, 1);
    assert.equal(await balance(telegramId), 50_000 - PRICE);
  });

  dbTest("the purchase id stays tied to the tapped message when the processing message had to be replaced", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram({ refuseEdit: (_text, messageId) => (messageId === 55 ? CANT_EDIT : null) });
    await handleCallbackQuery(bot, tap(telegramId));
    resetCallbackGuardForTests();

    await handleCallbackQuery(bot, tap(telegramId));

    assert.equal((await orders(telegramId)).length, 1, "tapping the same screen again is the same order");
    assert.equal(wizardCalls, 1);
  });
});

describe("the customer notice survives Telegram failures and restarts", () => {
  const staleNow = () => new Date(Date.now() + 10 * 60_000);
  const clearBackoff = (telegramId) => WalletPurchase.updateOne({ telegramId }, { $set: { customerNoticeNextAt: null } });

  // The sweep is global, so each test starts without other tests' pending notices.
  beforeEach(async () => { if (dbAvailable) await WalletPurchase.deleteMany({}); });

  dbTest("a notice that could not be delivered is sent once by the recovery sweep", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const down = telegram({ refuseEdit: () => CANT_EDIT, refuseSend: () => BLOCKED });
    await handleCallbackQuery(down, tap(telegramId));
    const [failed] = await orders(telegramId);
    assert.equal(failed.customerNoticePending, true);
    assert.equal(failed.customerNoticeClaimedAt, null);
    assert.ok(failed.customerNoticeNextAt, "backoff recorded");
    await clearBackoff(telegramId);

    const bot = telegram();
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot, { now: staleNow() }), 1);
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot, { now: staleNow() }), 0);

    assert.deepEqual(bot.sends().map((send) => [String(send.chatId), send.text]), [[telegramId, RESERVED]]);
    assert.equal((await orders(telegramId))[0].customerNoticePending, false);
  });

  dbTest("a crash between parking and notifying is recovered by the sweep", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const { purchasePlan } = await import("../../services/buyService/purchaseService.js");
    await purchasePlan(telegramId, "mini", { purchaseId: `crash-${telegramId}` });

    const bot = telegram();
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot, { now: staleNow() }), 1);
    assert.equal(bot.sends().length, 1);
  });

  dbTest("the sweep leaves an order alone while the live purchase can still report it", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const { purchasePlan } = await import("../../services/buyService/purchaseService.js");
    await purchasePlan(telegramId, "mini", { purchaseId: `fresh-${telegramId}` });

    const bot = telegram();
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot), 0);
    assert.equal(bot.sends().length, 0);
  });

  dbTest("a worker that crashed holding the claim does not block delivery forever", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const { purchasePlan } = await import("../../services/buyService/purchaseService.js");
    await purchasePlan(telegramId, "mini", { purchaseId: `claim-${telegramId}` });
    await WalletPurchase.updateOne({ telegramId }, { $set: { customerNoticeClaimedAt: new Date(Date.now() - 10 * 60_000) } });

    const bot = telegram();
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot, { now: staleNow() }), 1);
  });

  dbTest("orders parked before this feature are not messaged by the sweep", async () => {
    const telegramId = await customer();
    await WalletPurchase.create({
      purchaseId: `legacy-${telegramId}`,
      telegramId,
      planId: "mini",
      gig: 5,
      days: 7,
      amount: PRICE,
      status: "awaiting_provider",
      awaitingProviderSince: new Date(Date.now() - 60 * 60_000),
    });

    const bot = telegram();
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot), 0);
    assert.equal(bot.sends().length, 0);
  });

  dbTest("an admin approval that finds the provider still short does not message the customer again", async () => {
    wizardMode = "insufficient";
    const telegramId = await customer();
    const bot = telegram();
    await handleCallbackQuery(bot, tap(telegramId));
    const [order] = await orders(telegramId);
    assert.equal(order.customerNoticePending, false);

    const result = await fulfillment.approveReservedOrder({
      orderRef: String(order._id),
      adminId: 9001,
      bot,
    });

    assert.equal(result.outcome, "still_short");
    const [after] = await orders(telegramId);
    assert.equal(after.customerNoticePending, false, "the re-park queues no second notice");
    assert.equal(await reservedAlerts.retryPendingReservedNotices(bot, { now: staleNow() }), 0);
    assert.equal(bot.sends().filter((send) => send.text === RESERVED).length, 0);
  });
});
