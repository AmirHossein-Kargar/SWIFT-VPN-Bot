/**
 * /start is how a user gets back to the menu: it always sends a new message
 * carrying the inline menu and never touches an earlier message.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "9001";

const { renderWelcome } = await import("../../handlers/message/handleStart.js");
const { WELCOME_MESSAGE } = await import("../../messages/staticMessages.js");
const {
  getActiveMessage,
  setActiveMessage,
  setActiveMessageClientForTests,
  clearActiveMessageClientForTests,
} = await import("../../services/messaging/activeMessageStore.js");

const NOT_MODIFIED = "ETELEGRAM: 400 Bad Request: message is not modified: specified new message content and reply markup are exactly the same";

const CUSTOMER_MENU = ["menu:buy", "menu:services", "menu:topup", "menu:test", "menu:profile", "menu:support", "menu:guide"];

function trackPointers() {
  const store = new Map();
  setActiveMessageClientForTests({
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); return "OK"; },
    async del(key) { store.delete(key); },
  });
}

function botStub({ editError, sendError, placeholderError } = {}) {
  const edits = [];
  const sends = [];
  const deletes = [];
  let nextMessageId = 1000;
  return {
    edits,
    sends,
    deletes,
    async editMessageText(text, options) {
      edits.push({ text, options });
      if (editError) throw new Error(editError);
    },
    async editMessageReplyMarkup(reply_markup, options) {
      edits.push({ reply_markup, options });
      if (editError) throw new Error(editError);
    },
    async sendMessage(chatId, text, options) {
      if (sendError) throw new Error(sendError);
      if (placeholderError && options?.reply_markup?.remove_keyboard) throw new Error(placeholderError);
      const message_id = nextMessageId++;
      sends.push({ chatId, text, options, message_id });
      return { message_id };
    },
    async deleteMessage(chatId, messageId) {
      deletes.push({ chatId, messageId });
    },
  };
}

const menuCallbacks = (send) => send.options.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
const welcomeSends = (bot) => bot.sends.filter((send) => send.text === WELCOME_MESSAGE);

afterEach(() => clearActiveMessageClientForTests());

describe("handleStart.renderWelcome", () => {
  test("sends a new message carrying the main menu and every customer button", async () => {
    const bot = botStub();
    const result = await renderWelcome(bot, { chatId: 1, userId: 42, chatType: "private" });

    assert.equal(welcomeSends(bot).length, 1);
    assert.deepEqual(menuCallbacks(welcomeSends(bot)[0]), CUSTOMER_MENU);
    assert.deepEqual(result, { messageId: welcomeSends(bot)[0].message_id, edited: false, sent: true });
  });

  test("an allowlisted admin also gets the admin row on that message", async () => {
    const bot = botStub();
    await renderWelcome(bot, { chatId: 9001, userId: 9001, chatType: "private" });
    assert.deepEqual(menuCallbacks(welcomeSends(bot)[0]), [...CUSTOMER_MENU, "adm:mock", "adm:home"]);
  });

  test("works with no previous message id: nothing is edited, the menu is the last message", async () => {
    trackPointers();
    const bot = botStub();
    const { messageId } = await renderWelcome(bot, { chatId: 2, userId: 42, chatType: "private" });

    assert.equal(bot.edits.length, 0, "there is nothing to edit yet");
    assert.equal(bot.sends.at(-1).text, WELCOME_MESSAGE, "the menu must end up at the bottom of the chat");
    assert.equal(await getActiveMessage(2), messageId, "buttons on this message have a tracked screen");
  });

  test("the legacy Reply Keyboard is cleared by its own message, never on the menu message", async () => {
    // Telegram can only edit messages without reply_markup or with inline keyboards, so a menu message
    // sent with remove_keyboard could never receive its buttons.
    const bot = botStub();
    await renderWelcome(bot, { chatId: 3, userId: 42, chatType: "private" });

    const [placeholder] = bot.sends.filter((send) => send.options?.reply_markup?.remove_keyboard);
    assert.ok(placeholder, "a chat with no tracked screen may still hold the legacy keyboard");
    assert.deepEqual(bot.deletes, [{ chatId: 3, messageId: placeholder.message_id }]);
    assert.equal(welcomeSends(bot)[0].options.reply_markup.remove_keyboard, undefined);
  });

  test("a failed legacy-keyboard clear never costs the user the menu", async () => {
    const bot = botStub({ placeholderError: "ETELEGRAM: 429 Too Many Requests" });
    await renderWelcome(bot, { chatId: 4, userId: 42, chatType: "private" });
    assert.deepEqual(menuCallbacks(welcomeSends(bot)[0]), CUSTOMER_MENU);
  });

  test("a tracked message is never edited, even when Telegram would accept the edit", async () => {
    // Such an edit lands out of view (or in history the user cleared on their side only): they see nothing.
    trackPointers();
    await setActiveMessage(5, 500);
    const bot = botStub();
    const { messageId } = await renderWelcome(bot, { chatId: 5, userId: 42, chatType: "private" });

    assert.equal(bot.edits.length, 0);
    assert.equal(bot.deletes.length, 0, "the older screen is left alone");
    assert.equal(bot.sends.length, 1, "a recently active chat has no legacy keyboard left to clear");
    assert.equal(await getActiveMessage(5), messageId, "the pointer moves to the new menu");
  });

  test("every repeated /start gets its own visible message", async () => {
    // Regression: the second identical render answered "message is not modified", which counted as success.
    trackPointers();
    const bot = botStub({ editError: NOT_MODIFIED });
    for (let press = 1; press <= 3; press += 1) {
      await renderWelcome(bot, { chatId: 6, userId: 42, chatType: "private" });
      assert.equal(welcomeSends(bot).length, press);
    }
    assert.equal(bot.edits.length, 0);
  });

  test("a stale tracked message id cannot affect /start", async () => {
    trackPointers();
    await setActiveMessage(7, 501);
    const bot = botStub({ editError: "ETELEGRAM: 400 Bad Request: message to edit not found" });
    await renderWelcome(bot, { chatId: 7, userId: 42, chatType: "private" });
    assert.deepEqual(menuCallbacks(welcomeSends(bot)[0]), CUSTOMER_MENU);
  });

  test("still sends the menu when Redis is unavailable (no pointer can be read or stored)", async () => {
    const bot = botStub();
    const { messageId } = await renderWelcome(bot, { chatId: 8, userId: 42, chatType: "private" });
    assert.equal(messageId, welcomeSends(bot)[0].message_id);
  });

  test("group chats also get a new message, with no legacy-keyboard clear", async () => {
    trackPointers();
    await setActiveMessage(-5, 502);
    const bot = botStub();
    await renderWelcome(bot, { chatId: -5, userId: 42, chatType: "group" });

    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.deepEqual(menuCallbacks(bot.sends[0]), CUSTOMER_MENU);
  });

  test("a failed send reaches the caller, so bot.js can report the error instead of staying silent", async () => {
    const bot = botStub({ sendError: "ETELEGRAM: 500 Internal Server Error" });
    await assert.rejects(() => renderWelcome(bot, { chatId: 9, userId: 42, chatType: "group" }), /500/);
  });
});
