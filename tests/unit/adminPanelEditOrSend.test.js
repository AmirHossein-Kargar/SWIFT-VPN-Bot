/**
 * Focused regression tests for handlers/admin/panel.js's editOrSend() —
 * specifically the stale-message cleanup fix: a replacement must be sent
 * and confirmed successful before the obsolete message is ever deleted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242,424243";
process.env.GROUP_ID = "";

const { editOrSend } = await import("../../handlers/admin/panel.js");

function botStub({ editFails, editError, sendFails, sendError, deleteFails, deleteError, includeDelete = true } = {}) {
  const edits = [];
  const sends = [];
  const deletes = [];
  const bot = {
    edits,
    sends,
    deletes,
    async editMessageText(text, options) {
      if (editFails) throw editError || new Error("edit failed");
      edits.push({ text, options });
      return { message_id: options.message_id };
    },
    async sendMessage(chatId, text, options) {
      if (sendFails) throw sendError || new Error("send failed");
      sends.push({ chatId, text, options });
      return { message_id: 9001 };
    },
  };
  if (includeDelete) {
    bot.deleteMessage = async (chatId, messageId) => {
      if (deleteFails) throw deleteError || new Error("delete failed");
      deletes.push({ chatId, messageId });
    };
  }
  return bot;
}

const KEYBOARD = { inline_keyboard: [[{ text: "🏠 خانه", callback_data: "adm:home" }]] };

describe("editOrSend: successful edit", () => {
  test("edits in place; no send, no delete", async () => {
    const bot = botStub();
    await editOrSend(bot, 1, 55, "panel text", KEYBOARD);

    assert.equal(bot.sends.length, 0);
    assert.equal(bot.deletes.length, 0);
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].options.chat_id, 1);
    assert.equal(bot.edits[0].options.message_id, 55);
    assert.deepEqual(bot.edits[0].options.reply_markup, KEYBOARD);
    assert.equal(bot.edits[0].options.parse_mode, "HTML");
    assert.equal(bot.edits[0].text, "panel text");
  });
});

describe("editOrSend: failed edit with a successful replacement", () => {
  test("sends a replacement, then deletes the obsolete message", async () => {
    const bot = botStub({ editFails: true, editError: new Error("message to edit not found") });
    await editOrSend(bot, 1, 55, "panel text", KEYBOARD);

    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.deepEqual(bot.sends[0].options.reply_markup, KEYBOARD);
    assert.deepEqual(bot.deletes, [{ chatId: 1, messageId: 55 }]);
  });

  test("the delete never runs before the replacement send is confirmed", async () => {
    const order = [];
    const bot = {
      async editMessageText() { throw new Error("edit failed"); },
      async sendMessage() { order.push("send"); return { message_id: 9001 }; },
      async deleteMessage() { order.push("delete"); },
    };
    await editOrSend(bot, 1, 55, "panel text", KEYBOARD);
    assert.deepEqual(order, ["send", "delete"]);
  });

  test("no messageId to begin with (e.g. first-entry screens like screenMockTests): sends, attempts no delete", async () => {
    const bot = botStub({ editFails: true, editError: new Error("message_id_invalid") });
    await editOrSend(bot, 1, null, "panel text", KEYBOARD);

    assert.equal(bot.sends.length, 1);
    assert.equal(bot.deletes.length, 0);
  });
});

describe("editOrSend: replacement send fails", () => {
  test("does not attempt to delete the old message when the replacement could not be sent", async () => {
    const bot = botStub({
      editFails: true,
      editError: new Error("message to edit not found"),
      sendFails: true,
      sendError: new Error("chat not found"),
    });
    await assert.doesNotReject(() => editOrSend(bot, 1, 55, "panel text", KEYBOARD));
    assert.equal(bot.sends.length, 0); // nothing recorded — sendMessage itself threw
    assert.equal(bot.deletes.length, 0);
  });
});

describe("editOrSend: deletion failure is handled safely", () => {
  test("a failed delete (e.g. already gone) does not throw and does not mask the successful replacement", async () => {
    const bot = botStub({
      editFails: true,
      editError: new Error("message to edit not found"),
      deleteFails: true,
      deleteError: new Error("message to delete not found"),
    });
    await assert.doesNotReject(() => editOrSend(bot, 1, 55, "panel text", KEYBOARD));
    assert.equal(bot.sends.length, 1); // the replacement still went out
    assert.equal(bot.deletes.length, 0); // delete was attempted and swallowed, not recorded as succeeded
  });

  test("a bot stub without deleteMessage at all (as used elsewhere in this test suite) never throws", async () => {
    const bot = botStub({ editFails: true, editError: new Error("edit failed"), includeDelete: false });
    await assert.doesNotReject(() => editOrSend(bot, 1, 55, "panel text", KEYBOARD));
    assert.equal(bot.sends.length, 1);
  });
});
