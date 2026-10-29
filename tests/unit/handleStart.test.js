import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderWelcome } from "../../handlers/message/handleStart.js";
import { WELCOME_MESSAGE } from "../../messages/staticMessages.js";

function botStub({ editFails, editError, editReplyMarkupFails } = {}) {
  const edits = [];
  const sends = [];
  const deletes = [];
  const editReplyMarkups = [];
  let nextMessageId = 1000;
  return {
    edits,
    sends,
    deletes,
    editReplyMarkups,
    async editMessageText(text, options) {
      if (editFails) throw editError || new Error("edit failed");
      edits.push({ text, options });
    },
    async editMessageReplyMarkup(reply_markup, options) {
      if (editReplyMarkupFails) throw new Error("edit reply markup failed");
      editReplyMarkups.push({ reply_markup, options });
    },
    async sendMessage(chatId, text, options) {
      const message_id = nextMessageId++;
      sends.push({ chatId, text, options, message_id });
      return { message_id };
    },
    async deleteMessage(chatId, messageId) {
      deletes.push({ chatId, messageId });
    },
  };
}

describe("handleStart.renderWelcome", () => {
  test("first-ever /start in a private chat: exactly one message, no delete, keyboard attached by edit", async () => {
    const chatId = 1;
    // activeMessageStore.js falls back to "no tracked message" whenever Redis
    // is unavailable (as in this unit-test process), which exercises exactly
    // the "no active message yet" branch under test here.
    const bot = botStub();
    const result = await renderWelcome(bot, { chatId, userId: 42, chatType: "private" });

    assert.equal(bot.deletes.length, 0, "must never delete a bot message");
    assert.equal(bot.sends.length, 1, "exactly one message is sent");
    assert.equal(bot.sends[0].text, WELCOME_MESSAGE);
    assert.deepEqual(bot.sends[0].options, { reply_markup: { remove_keyboard: true } });
    assert.equal(bot.editReplyMarkups.length, 1, "the inline menu is attached to the same message via an edit");
    assert.equal(bot.editReplyMarkups[0].options.message_id, bot.sends[0].message_id);
    assert.ok(bot.editReplyMarkups[0].reply_markup.inline_keyboard.length > 0);
    assert.equal(result.messageId, bot.sends[0].message_id);
  });

  test("non-private chats skip the legacy-keyboard clear and just edit-or-send", async () => {
    const bot = botStub();
    const result = await renderWelcome(bot, { chatId: 3, userId: 42, chatType: "group" });
    assert.equal(bot.deletes.length, 0);
    assert.equal(bot.editReplyMarkups.length, 0, "no keyboard-removal dance for group chats");
    assert.ok(result.messageId != null);
  });

  test("a failed keyboard-attach edit (e.g. a flaky Telegram API call) never throws or sends a second message", async () => {
    const bot = botStub({ editReplyMarkupFails: true });
    await assert.doesNotReject(() => renderWelcome(bot, { chatId: 4, userId: 42, chatType: "private" }));
    assert.equal(bot.sends.length, 1, "still only the one welcome message");
    assert.equal(bot.deletes.length, 0);
  });
});
