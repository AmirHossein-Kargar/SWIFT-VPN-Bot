/**
 * Inline-keyboard-only navigation: no Reply Keyboard is rendered, the legacy one
 * is removed, menu callbacks edit in place, every callback is answered exactly
 * once, repeated taps are dropped, and stale text-input states expire.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { makeBotStub } from "../helpers/db.js";
import { makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";

const { default: keyboard, adminKeyboard, keyboardFor, LEGACY_MENU_TEXT } = await import("../../keyboards/mainKeyboard.js");
const { default: hideKeyboard } = await import("../../utils/hideKeyboard.js");
const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const { MENU_ACTIONS, legacyMenuAction } = await import("../../handlers/menuActions.js");
const { claimCallback, withSingleAck, resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js");
const { getGroupKeyboard } = await import("../../handlers/admin/groupManager.js");
const { isInputStepExpired, INPUT_STEP_TTL_MS } = await import("../../utils/inputExpiry.js");
const { default: handleMessage } = await import("../../handlers/onMessage.js");
const sessionStore = await import("../../config/sessionStore.js");

const root = path.resolve(import.meta.dirname, "../..");
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "tests", "admin-panel", "storefront", "web", "docs", "node-compile-cache"].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const buttons = (kb) => kb.reply_markup.inline_keyboard.flat();
const query = (data, { userId = 1001, messageId = 77, chatType = "private" } = {}) => ({
  id: `q-${Math.random()}`,
  from: { id: userId },
  data,
  message: { message_id: messageId, chat: { id: userId, type: chatType } },
});
const answers = (bot) => bot.sent.filter((e) => e.kind === "answer");
const nonAnswers = (bot) => bot.sent.filter((e) => e.kind !== "answer");

beforeEach(() => { resetCallbackGuardForTests(); sessionStore.setSessionClientForTests(makeSessionClient()); });
afterEach(() => sessionStore.clearSessionClientForTests());

describe("no Reply Keyboard is rendered", () => {
  test("source defines no reply keyboard except the removal markup", () => {
    const offenders = [];
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (/resize_keyboard|one_time_keyboard|is_persistent|[^_]keyboard\s*:\s*\[/.test(src)) offenders.push(path.relative(root, file));
    }
    assert.deepEqual(offenders, []);
  });

  test("customer, admin and group menus are inline only", () => {
    for (const kb of [keyboard, adminKeyboard, keyboardFor("9001", "private"), keyboardFor("1", "private")]) {
      assert.ok(Array.isArray(kb.reply_markup.inline_keyboard));
      assert.equal(kb.reply_markup.keyboard, undefined);
    }
    assert.ok(Array.isArray(getGroupKeyboard().inline_keyboard));
    assert.equal(getGroupKeyboard().keyboard, undefined);
  });

  test("admin buttons are offered only to admins in private chats", () => {
    const names = (kb) => buttons(kb).map((b) => b.callback_data);
    assert.ok(names(keyboardFor("9001", "private")).includes("adm:home"));
    assert.ok(!names(keyboardFor("1", "private")).includes("adm:home"));
    assert.ok(!names(keyboardFor("9001", "supergroup")).includes("adm:home"));
  });

  test("every main-menu button carries a valid compact callback", () => {
    for (const button of buttons(keyboardFor("9001", "private"))) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      if (button.callback_data.startsWith("menu:")) {
        assert.ok(MENU_ACTIONS.includes(button.callback_data.slice(5)), button.callback_data);
      }
    }
  });
});

describe("legacy Reply Keyboard migration", () => {
  test("hideKeyboard sends remove_keyboard and deletes the placeholder", async () => {
    const bot = makeFakeBot();
    await hideKeyboard(bot, 1001);
    const sent = bot.of("sendMessage");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].args[2].reply_markup, { remove_keyboard: true });
    assert.ok(bot.of("deleteMessage").some((call) => call.args[1] === sent[0].result.message_id));
  });

  test("old button labels still resolve to the matching menu action", () => {
    for (const [label, action] of Object.entries(LEGACY_MENU_TEXT)) {
      assert.equal(legacyMenuAction(label), action);
      assert.ok(MENU_ACTIONS.includes(action));
    }
    assert.equal(legacyMenuAction("hello"), null);
    assert.equal(legacyMenuAction("__proto__"), null);
  });

  test("bot.js clears the old keyboard on legacy taps, and routes /start through the single-message welcome screen", () => {
    const src = readFileSync(path.join(root, "bot.js"), "utf8");
    // /start no longer sends-then-deletes a throwaway "⏳" placeholder before
    // the welcome screen (that flash is exactly what handleStart.renderWelcome
    // was introduced to eliminate — see tests/unit/handleStart.test.js); the
    // legacy-keyboard clear for a tap on an old Reply Keyboard button is still
    // targeted and unconditional, since that path provably has one to remove.
    assert.match(src, /case "\/start"[\s\S]{0,400}renderWelcome\(bot,/);
    assert.doesNotMatch(src, /case "\/start"[\s\S]{0,400}hideKeyboard\(bot, chatId\)/);
    assert.match(src, /legacyMenuAction[\s\S]{0,300}hideKeyboard\(bot, chatId\)[\s\S]{0,120}runMenuAction/);
  });
});

describe("menu callbacks", () => {
  test("menu:home edits the current message into the main menu and acknowledges once", async () => {
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("menu:home"));
    assert.equal(bot.sent.filter((e) => e.kind === "message").length, 0, "no new message");
    const edit = bot.sent.find((e) => e.kind === "edit");
    assert.equal(edit.opts.message_id, 77);
    assert.ok(edit.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "menu:buy"));
    assert.equal(answers(bot).length, 1);
  });

  test("menu:buy edits the same message into the duration menu", async () => {
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("menu:buy"));
    assert.match(bot.sent.find((e) => e.kind === "edit").text, /مدت زمان اشتراک/);
    assert.equal(bot.sent.filter((e) => e.kind === "message").length, 0);
  });

  test("menu:topup edits into the payment-method screen (no new message)", async () => {
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("menu:topup"));
    assert.match(bot.sent.find((e) => e.kind === "edit").text, /افزایش موجودی/);
    assert.equal(bot.sent.filter((e) => e.kind === "message").length, 0);
  });

  test("menu:guide and menu:support edit in place", async () => {
    for (const data of ["menu:guide", "menu:support"]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, query(data));
      assert.ok(bot.sent.some((e) => e.kind === "edit"), data);
      assert.equal(bot.sent.filter((e) => e.kind === "message").length, 0, data);
    }
  });

  test("an unknown menu action navigates nowhere and is still acknowledged", async () => {
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("menu:drop_tables"));
    assert.equal(answers(bot).length, 1);
    assert.equal(nonAnswers(bot).length, 0);
  });

  test("leaving to the menu discards a pending text-input step", async () => {
    await sessionStore.setSession(1001, { step: "waiting_for_hoosh_amount", messageId: 5 });
    await handleCallbackQuery(makeBotStub(), query("menu:home"));
    assert.equal((await sessionStore.getSession(1001)).step, undefined);
  });

  test("admin buttons are authorization-checked server-side", async () => {
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("adm:home", { userId: 1001 }));
    assert.equal(answers(bot).length, 1);
    assert.equal(answers(bot)[0].opts.show_alert, true);
    assert.equal(nonAnswers(bot).length, 0);
  });

  test("back_to_home edits in place instead of delete-and-resend", async () => {
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("back_to_home"));
    assert.ok(bot.sent.some((e) => e.kind === "edit"));
    assert.equal(bot.sent.filter((e) => e.kind === "message").length, 0);
  });

  test("back_to_home closes an orphaned support screen (opened from a different message) by editing it, never deleting it", async () => {
    await sessionStore.setSession(1001, { supportMessageId: 7 });
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query("back_to_home", { messageId: 77 }));
    assert.equal(bot.sent.filter((e) => e.kind === "message").length, 0, "no new message");
    const edits = bot.sent.filter((e) => e.kind === "edit");
    assert.ok(edits.some((e) => e.opts.message_id === 7), "the orphaned support screen is edited, not deleted");
    assert.ok(edits.some((e) => e.opts.message_id === 77), "the clicked screen is edited into the main menu");
  });
});

describe("callback acknowledgement and repeats", () => {
  test("withSingleAck forwards only the first answer and ensureAnswered fills the gap", async () => {
    const calls = [];
    const raw = { answerCallbackQuery: async (id, opts) => { calls.push([id, opts]); return true; } };
    const ack = withSingleAck(raw, "q1");
    await ack.bot.answerCallbackQuery("q1", { text: "a" });
    await ack.bot.answerCallbackQuery("q1", { text: "b" });
    await ack.ensureAnswered();
    assert.equal(calls.length, 1);

    const silent = withSingleAck(raw, "q2");
    await silent.ensureAnswered();
    await silent.ensureAnswered();
    assert.equal(calls.length, 2);
  });

  test("an expired query does not break handling", async () => {
    const raw = { answerCallbackQuery: async () => { throw new Error("query is too old"); } };
    const ack = withSingleAck(raw, "q1");
    await assert.doesNotReject(() => ack.bot.answerCallbackQuery("q1"));
    await assert.doesNotReject(ack.ensureAnswered);
  });

  test("unknown, malformed and message-less callbacks are each answered exactly once", async () => {
    for (const q of [
      query("totally_unknown"),
      { ...query("x"), data: undefined },
      { id: "m", from: { id: 1 }, data: "menu:buy", message: { chat: { id: 1, type: "private" } } },
    ]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, q);
      assert.equal(answers(bot).length, 1, String(q.data));
    }
  });

  test("rapid repeats of a state-changing button are dropped, navigation is not", () => {
    const tap = { userId: 1, messageId: 9, now: 1_000 };
    assert.equal(claimCallback({ ...tap, data: "confirm_order_p1" }), true);
    assert.equal(claimCallback({ ...tap, data: "confirm_order_p1", now: 1_500 }), false);
    assert.equal(claimCallback({ ...tap, data: "confirm_order_p1", now: 4_000 }), true);
    assert.equal(claimCallback({ ...tap, data: "confirm_order_p2", now: 1_100 }), true, "different button");
    assert.equal(claimCallback({ userId: 2, messageId: 9, data: "confirm_order_p1", now: 1_100 }), true, "different user");
    assert.equal(claimCallback({ ...tap, data: "menu:buy", now: 1_000 }), true);
    assert.equal(claimCallback({ ...tap, data: "menu:buy", now: 1_001 }), true);
  });

  test("a repeated sensitive tap through the handler is acknowledged but does no work", async () => {
    await handleCallbackQuery(makeBotStub(), query("np_create", { messageId: 5 }));
    const second = makeBotStub();
    await handleCallbackQuery(second, query("np_create", { messageId: 5 }));
    assert.equal(nonAnswers(second).length, 0);
    assert.equal(answers(second).length, 1);
  });
});

describe("text-input flows keep working and expire safely", () => {
  test("input steps expire after the TTL but never earlier", () => {
    const now = 10_000_000;
    assert.equal(isInputStepExpired({ step: "waiting_for_hoosh_amount", updatedAt: now - INPUT_STEP_TTL_MS - 1 }, now), true);
    assert.equal(isInputStepExpired({ step: "waiting_for_hoosh_amount", updatedAt: now - 1000 }, now), false);
    assert.equal(isInputStepExpired({ step: "waiting_for_hoosh_amount" }, now), false, "untimestamped sessions stay live");
    assert.equal(isInputStepExpired({ step: "waiting_for_payment_method", updatedAt: 1 }, now), false);
  });

  test("setSession stamps input-step sessions", async () => {
    await sessionStore.setSession(5, { step: "waiting_for_hoosh_amount" });
    assert.ok((await sessionStore.getSession(5)).updatedAt > 0);
  });

  test("a message arriving after an expired amount prompt is not treated as an amount", async () => {
    const redis = makeSessionClient();
    sessionStore.setSessionClientForTests(redis);
    await redis.set("session:1001", JSON.stringify({ step: "waiting_for_hoosh_amount", updatedAt: Date.now() - INPUT_STEP_TTL_MS - 5000 }));
    const bot = makeBotStub();
    await handleMessage(bot, { message_id: 1, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text: "500000" });
    const sent = bot.sent.filter((e) => e.kind === "message");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /مهلت/);
    assert.equal(sent[0].opts.reply_markup.inline_keyboard[0][0].callback_data, "back_to_home");
    assert.equal((await sessionStore.getSession(1001)).step, undefined);
  });

  test("a fresh amount prompt still reaches the payment handler", async () => {
    await sessionStore.setSession(1001, { step: "waiting_for_hoosh_amount", messageId: 5 });
    const bot = makeBotStub();
    await handleMessage(bot, { message_id: 1, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text: "abc" });
    assert.ok(bot.sent.length > 0, "the amount handler responded instead of dropping the message");
    assert.ok(!bot.sent.some((e) => /مهلت/.test(e.text || "")));
  });
});
