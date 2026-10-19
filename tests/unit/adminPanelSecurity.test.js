/**
 * Telegram admin panel security: forged callbacks, confirmation binding and
 * throttling. Uses only paths that need neither MongoDB nor Redis.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ADMINS = "424242,424243";
process.env.GROUP_ID = "";

const { handleAdminPanelCallbacks, handleAdminPanelStep } = await import("../../handlers/admin/panel.js");

function botStub() {
  const events = [];
  return {
    events,
    async editMessageText(text, options) { events.push({ kind: "edit", text, options }); return { message_id: 42 }; },
    async sendMessage(chatId, text, options) { events.push({ kind: "send", text, options }); return { message_id: 43 }; },
    async answerCallbackQuery(id, options) { events.push({ kind: "answer", id, options }); return true; },
  };
}
const answers = (bot) => bot.events.filter((e) => e.kind === "answer");
let counter = 0;
const press = (bot, data, { userId = 424242, chatId = 555, chatType = "private", messageId = 42 } = {}) => handleAdminPanelCallbacks(bot, {
  id: `cb_${++counter}`,
  data,
  from: { id: userId },
  message: { chat: { id: chatId, type: chatType }, message_id: messageId },
});

/** Opens a confirmation (no database needed) and returns its callback_data. */
async function openConfirmation(bot, options) {
  await press(bot, "adm:recgo", options);
  const edit = bot.events.filter((e) => e.kind === "edit").at(-1);
  const buttons = edit.options.reply_markup.inline_keyboard.flat();
  return buttons.find((b) => b.callback_data.startsWith("adm:y:")).callback_data;
}

describe("admin callbacks are authorized from Telegram metadata only", () => {
  test("non-admins are denied for every privileged callback, including forged ones", async () => {
    const bot = botStub();
    for (const data of ["adm:home", "adm:tsr", "adm:ul:1", "adm:uo:0", "adm:vpact:revoke:0", "adm:y:AAAAAAAAAAAA", "adm:bal:add", "adm:admrm:424242"]) {
      await press(bot, data, { userId: 111 });
    }
    assert.equal(bot.events.filter((e) => e.kind !== "answer").length, 0, "nothing rendered or executed");
    assert.equal(answers(bot).length, 8);
    assert.ok(answers(bot).every((a) => a.options?.show_alert));
  });

  test("a user id embedded in callback data is never treated as identity", async () => {
    const bot = botStub();
    await press(bot, "adm:uo:424242", { userId: 111 });
    await press(bot, "adm:admrm:424242", { userId: 111 });
    assert.equal(bot.events.filter((e) => e.kind === "edit").length, 0);
  });

  test("a group chat is not enough: the clicker must be allowlisted and GROUP_ID configured", async () => {
    const bot = botStub();
    await press(bot, "adm:home", { userId: 424242, chatType: "supergroup", chatId: -100123 });
    assert.equal(bot.events.filter((e) => e.kind === "edit").length, 0);
  });

  test("text steps from non-admins are ignored", async () => {
    const bot = botStub();
    const handled = await handleAdminPanelStep(bot, { chat: { id: 555, type: "private" }, from: { id: 111 }, text: "424242" });
    assert.equal(handled, false);
  });
});

describe("confirmations", () => {
  test("keys are unpredictable, fit Telegram's limit and differ every time", async () => {
    const bot = botStub();
    const keys = new Set();
    for (let i = 0; i < 20; i += 1) keys.add(await openConfirmation(bot, { messageId: 100 + i }));
    assert.equal(keys.size, 20);
    for (const key of keys) {
      assert.match(key, /^adm:y:[A-Za-z0-9_-]{12}$/);
      assert.ok(Buffer.byteLength(key) <= 64);
    }
  });

  test("another admin cannot press the confirmation, and the original stays valid", async () => {
    const bot = botStub();
    const key = await openConfirmation(bot, { userId: 424242, messageId: 200 });
    const other = botStub();
    await press(other, key, { userId: 424243, messageId: 200 });
    assert.match(answers(other).at(-1).options.text, /مدیر دیگری/);
    assert.equal(other.events.filter((e) => e.kind === "edit").length, 0, "nothing was executed");
    // Still pending for its owner: a stale/second consumer sees "owner" rejection only for others,
    // so a replay by the same admin from a different message is also refused.
    const replayElsewhere = botStub();
    await press(replayElsewhere, key, { userId: 424242, messageId: 999 });
    assert.match(answers(replayElsewhere).at(-1).options.text, /مدیر دیگری/);
  });

  test("a made-up or expired key is rejected without running anything", async () => {
    const bot = botStub();
    await press(bot, "adm:y:AAAAAAAAAAAA");
    assert.match(answers(bot).at(-1).options.text, /منقضی/);
    assert.equal(bot.events.filter((e) => e.kind === "edit").length, 0);
  });
});

describe("throttling and source-level guarantees", () => {
  test("a burst of callbacks from one admin is slowed down", async () => {
    const bot = botStub();
    for (let i = 0; i < 40; i += 1) await press(bot, "adm:x", { userId: 424243 });
    const slowed = answers(bot).filter((a) => a.options?.text);
    assert.ok(slowed.length >= 5, "calls over the limit were refused");
  });

  test("the acting admin comes from async context, not a shared mutable property", () => {
    const source = readFileSync(new URL("../../handlers/admin/panel.js", import.meta.url), "utf8");
    assert.match(source, /AsyncLocalStorage/);
    assert.doesNotMatch(source, /bot\.__adminActorId\s*=/);
    assert.doesNotMatch(source, /Math\.random\(\)/);
    assert.doesNotMatch(source, /(?:get|set|clear)Session\(chatId\b/);
  });
});
