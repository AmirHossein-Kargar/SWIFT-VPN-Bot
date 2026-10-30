import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  renderInterface,
  answerCallback,
  safeDeleteUserMessage,
  isNotModifiedError,
  updateStatusMessage,
} from "../../services/messaging/messageManager.js";
import {
  getActiveMessage,
  setActiveMessage,
  setActiveMessageIfUnchanged,
  clearActiveMessage,
  setActiveMessageClientForTests,
  clearActiveMessageClientForTests,
} from "../../services/messaging/activeMessageStore.js";

// A tiny in-memory stand-in for the `redis` client, implementing only the
// get/set/del/eval surface activeMessageStore.js actually calls. `eval` hand
// -implements the same compare-and-set semantics as SET_IF_MATCH_LUA so the
// store's calling contract can be exercised without a real Redis server.
function fakeRedis() {
  const store = new Map();
  return {
    isOpen: true,
    isReady: true,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      store.delete(key);
    },
    async eval(_script, { keys: [key], arguments: [expected, next] }) {
      const current = store.has(key) ? store.get(key) : false;
      if (current === expected || (current === false && expected === "")) {
        store.set(key, next);
        return 1;
      }
      return 0;
    },
  };
}

function botStub({ editFails, editError } = {}) {
  const edits = [];
  const sends = [];
  const deletes = [];
  const answers = [];
  return {
    edits,
    sends,
    deletes,
    answers,
    async editMessageText(text, options) {
      if (editFails) throw editError || new Error("edit failed");
      edits.push({ text, options });
    },
    async sendMessage(chatId, text, options) {
      sends.push({ chatId, text, options });
      return { message_id: 999 };
    },
    async deleteMessage(chatId, messageId) {
      deletes.push({ chatId, messageId });
    },
    async answerCallbackQuery(id, options) {
      answers.push({ id, options });
    },
  };
}

describe("activeMessageStore (compare-and-set pointer)", () => {
  test("getActiveMessage returns null when Redis is unavailable", async () => {
    const result = await getActiveMessage(1, { redis: null });
    assert.equal(result, null);
  });

  test("set then get round-trips through the fake client", async () => {
    const redis = fakeRedis();
    await setActiveMessage(42, 100, { redis });
    assert.equal(await getActiveMessage(42, { redis }), 100);
  });

  test("setActiveMessageIfUnchanged only succeeds when the stored value still matches", async () => {
    const redis = fakeRedis();
    assert.equal(await setActiveMessageIfUnchanged(7, 10, null, { redis }), true);
    assert.equal(await getActiveMessage(7, { redis }), 10);

    // A stale writer that read "10" earlier is still allowed to advance it...
    assert.equal(await setActiveMessageIfUnchanged(7, 11, 10, { redis }), true);
    // ...but a second stale writer that also thought the value was still "10" is rejected.
    assert.equal(await setActiveMessageIfUnchanged(7, 999, 10, { redis }), false);
    assert.equal(await getActiveMessage(7, { redis }), 11);
  });

  test("clearActiveMessage removes the pointer", async () => {
    const redis = fakeRedis();
    await setActiveMessage(3, 5, { redis });
    await clearActiveMessage(3, { redis });
    assert.equal(await getActiveMessage(3, { redis }), null);
  });
});

describe("messageManager.renderInterface", () => {
  test("edits the given message in place when editing succeeds", async () => {
    const bot = botStub();
    const result = await renderInterface(bot, {
      chatId: 1,
      text: "hello",
      options: { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "x", callback_data: "x" }]] } },
      messageId: 50,
    });
    assert.deepEqual(result, { messageId: 50, edited: true, sent: false });
    assert.equal(bot.sends.length, 0);
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].options.chat_id, 1);
    assert.equal(bot.edits[0].options.message_id, 50);
    assert.equal(bot.edits[0].options.parse_mode, "HTML");
  });

  test("treats 'message is not modified' as a successful, unchanged edit", async () => {
    const bot = botStub({ editFails: true, editError: new Error("ETELEGRAM: 400 Bad Request: message is not modified") });
    const result = await renderInterface(bot, { chatId: 1, text: "same", messageId: 50 });
    assert.equal(result.edited, true);
    assert.equal(result.unchanged, true);
    assert.equal(bot.sends.length, 0);
  });

  test("'message is not modified' on a merely tracked message still answers the user with a send", async () => {
    // Without an explicit messageId the target may be far out of view, so no edit means no visible response.
    setActiveMessageClientForTests(fakeRedis());
    try {
      await setActiveMessage(1, 50);
      const bot = botStub({ editFails: true, editError: new Error("ETELEGRAM: 400 Bad Request: message is not modified") });
      const result = await renderInterface(bot, { chatId: 1, text: "same" });
      assert.equal(result.sent, true);
      assert.equal(bot.sends.length, 1);
      assert.equal(await getActiveMessage(1), 999, "the pointer follows the message the user can see");
    } finally {
      clearActiveMessageClientForTests();
    }
  });

  test("isNotModifiedError recognizes the Telegram error text", () => {
    assert.equal(isNotModifiedError(new Error("message is not modified: foo")), true);
    assert.equal(isNotModifiedError(new Error("message to edit not found")), false);
    assert.equal(isNotModifiedError(null), false);
  });

  test("falls back to sendMessage when editing is impossible (e.g. the target is a photo)", async () => {
    const bot = botStub({ editFails: true, editError: new Error("ETELEGRAM: 400 Bad Request: there is no text in the message to edit") });
    const result = await renderInterface(bot, { chatId: 1, text: "fresh screen", messageId: 50 });
    assert.deepEqual(result, { messageId: 999, edited: false, sent: true });
    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.equal(bot.sends[0].text, "fresh screen");
  });

  test("sends fresh when no message is tracked and no messageId is given", async () => {
    const bot = botStub();
    const result = await renderInterface(bot, { chatId: 2, text: "menu" });
    assert.deepEqual(result, { messageId: 999, edited: false, sent: true });
    assert.equal(bot.edits.length, 0);
  });

  test("requires bot, chatId and text", async () => {
    await assert.rejects(() => renderInterface({}, { chatId: 1, text: "x" }), TypeError);
    await assert.rejects(() => renderInterface(botStub(), { text: "x" }), TypeError);
    await assert.rejects(() => renderInterface(botStub(), { chatId: 1 }), TypeError);
  });
});

describe("messageManager.answerCallback", () => {
  test("calls through and reports success", async () => {
    const bot = botStub();
    const ok = await answerCallback(bot, "q1", { text: "done" });
    assert.equal(ok, true);
    assert.deepEqual(bot.answers[0], { id: "q1", options: { text: "done" } });
  });

  test("swallows errors (e.g. an already-answered or expired query) instead of throwing", async () => {
    const bot = {
      async answerCallbackQuery() {
        throw new Error("query is too old");
      },
    };
    const ok = await answerCallback(bot, "q1");
    assert.equal(ok, false);
  });

  test("no-ops without a queryId", async () => {
    const bot = botStub();
    assert.equal(await answerCallback(bot, undefined), false);
    assert.equal(bot.answers.length, 0);
  });
});

describe("messageManager.safeDeleteUserMessage", () => {
  test("does nothing unless allow:true is passed explicitly", async () => {
    const bot = botStub();
    const result = await safeDeleteUserMessage(bot, 1, 5);
    assert.equal(result, false);
    assert.equal(bot.deletes.length, 0);
  });

  test("deletes when explicitly allowed", async () => {
    const bot = botStub();
    const result = await safeDeleteUserMessage(bot, 1, 5, { allow: true });
    assert.equal(result, true);
    assert.deepEqual(bot.deletes[0], { chatId: 1, messageId: 5 });
  });

  test("swallows delete errors (e.g. already deleted) and reports false", async () => {
    const bot = {
      async deleteMessage() {
        throw new Error("message to delete not found");
      },
    };
    const result = await safeDeleteUserMessage(bot, 1, 5, { allow: true });
    assert.equal(result, false);
  });
});

describe("updateStatusMessage", () => {
  const CANT_EDIT = "ETELEGRAM: 400 Bad Request: message can't be edited";
  const NOT_MODIFIED = "ETELEGRAM: 400 Bad Request: message is not modified: specified new message content";

  function statusBot({ editError, sendError } = {}) {
    const calls = [];
    return {
      calls,
      async editMessageText(text, options) {
        calls.push({ kind: "edit", text, options });
        if (editError) throw new Error(editError);
      },
      async sendMessage(chatId, text, options) {
        calls.push({ kind: "send", chatId, text, options });
        if (sendError) throw new Error(sendError);
        return { message_id: 200 };
      },
    };
  }

  test("edits the given message and sends nothing", async () => {
    const bot = statusBot();
    const result = await updateStatusMessage(bot, { chatId: 1, messageId: 7, text: "done", options: { parse_mode: "HTML" } });
    assert.deepEqual(result, { messageId: 7, delivered: true, edited: true, sent: false });
    assert.deepEqual(bot.calls, [{ kind: "edit", text: "done", options: { parse_mode: "HTML", chat_id: 1, message_id: 7 } }]);
  });

  test("'not modified' is delivered, not a reason to send a copy", async () => {
    const bot = statusBot({ editError: NOT_MODIFIED });
    const result = await updateStatusMessage(bot, { chatId: 1, messageId: 7, text: "done" });
    assert.equal(result.delivered, true);
    assert.equal(bot.calls.filter((call) => call.kind === "send").length, 0);
  });

  test("a refused edit sends one new message and reports its id", async () => {
    const bot = statusBot({ editError: CANT_EDIT });
    const result = await updateStatusMessage(bot, { chatId: 1, messageId: 7, text: "done" });
    assert.deepEqual(result, { messageId: 200, delivered: true, edited: false, sent: true });
  });

  test("with no message to edit it sends", async () => {
    const bot = statusBot();
    const result = await updateStatusMessage(bot, { chatId: 1, text: "done" });
    assert.equal(result.sent, true);
    assert.equal(bot.calls.length, 1);
  });

  test("fallback: false never adds a message", async () => {
    const bot = statusBot({ editError: CANT_EDIT });
    const result = await updateStatusMessage(bot, { chatId: 1, messageId: 7, text: "done", fallback: false });
    assert.deepEqual(result, { messageId: 7, delivered: false, edited: false, sent: false });
    assert.equal(bot.calls.filter((call) => call.kind === "send").length, 0);
  });

  test("never throws when Telegram refuses both the edit and the send", async () => {
    const bot = statusBot({ editError: CANT_EDIT, sendError: "ETELEGRAM: 403 Forbidden: bot was blocked by the user" });
    const result = await updateStatusMessage(bot, { chatId: 1, messageId: 7, text: "done" });
    assert.deepEqual(result, { messageId: 7, delivered: false, edited: false, sent: false });
  });
});
