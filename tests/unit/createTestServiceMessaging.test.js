/**
 * Single-message-UX regression: tapping "🎁 سرویس تست" must edit the chat's
 * existing screen through every status transition — never a throwaway "⏳"
 * placeholder, never a deleted message, never a second text message for the
 * same click. The QR-code/link delivery (sendPhoto) is a durable fulfillment
 * message and is intentionally exempt (see services/messaging/messageManager.js).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import createTestService from "../../services/createTestService.js";
import { createMockDataset } from "../../services/mockTests/memoryStore.js";
import { createFakeWizard } from "../../services/mockTests/fakes.js";

function botStub() {
  const calls = [];
  let nextId = 1000;
  return {
    calls,
    async sendMessage(chatId, text, opts) {
      const message_id = nextId++;
      calls.push({ kind: "send", chatId, text, opts, message_id });
      return { message_id };
    },
    async editMessageText(text, opts) {
      calls.push({ kind: "edit", text, opts });
      return true;
    },
    async deleteMessage(chatId, messageId) {
      calls.push({ kind: "delete", chatId, messageId });
    },
    async sendPhoto(chatId, photo, opts) {
      const message_id = nextId++;
      calls.push({ kind: "photo", chatId, photo, opts, message_id });
      return { message_id };
    },
  };
}

const msgFor = (userId) => ({ chat: { id: Number(userId), type: "private" }, from: { id: Number(userId) } });

describe("createTestService: single-message UX", () => {
  test("given a messageId, the whole flow edits that one message: no placeholder, no delete, the result is folded into it", async () => {
    const ds = createMockDataset();
    const panel = createFakeWizard();
    const bot = botStub();
    const userId = "900001";
    await ds.users.create({ telegramId: userId });

    await createTestService(bot, msgFor(userId), { userModel: ds.users, createApi: panel.createTest, messageId: 42 });

    assert.equal(bot.calls.filter((c) => c.kind === "send").length, 0, "no placeholder or extra text message was sent");
    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0, "no bot message was deleted");
    const edits = bot.calls.filter((c) => c.kind === "edit");
    assert.ok(edits.length >= 1, "at least the loading state was rendered");
    assert.ok(edits.every((c) => c.opts.message_id === 42), "every edit targets the message the button was tapped on");
    assert.match(edits.at(-1).text, /ساخته شد/);
    assert.equal(bot.calls.filter((c) => c.kind === "photo").length, 1, "the QR/link delivery is still its own durable message");
  });

  test("already received: edits the given message instead of sending a new one", async () => {
    const ds = createMockDataset();
    const userId = "900002";
    await ds.users.create({ telegramId: userId, hasReceivedTest: true, testServiceStatus: "completed" });
    const bot = botStub();

    await createTestService(bot, msgFor(userId), { userModel: ds.users, messageId: 77 });

    assert.equal(bot.calls.filter((c) => c.kind === "send").length, 0);
    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0);
    const edit = bot.calls.find((c) => c.kind === "edit");
    assert.equal(edit.opts.message_id, 77);
    assert.match(edit.text, /قبلاً/);
  });

  test("a request already in review: edits in place, never a new message", async () => {
    const ds = createMockDataset();
    const userId = "900003";
    await ds.users.create({ telegramId: userId, testServiceStatus: "manual_review" });
    const bot = botStub();

    await createTestService(bot, msgFor(userId), { userModel: ds.users, messageId: 88 });

    assert.equal(bot.calls.filter((c) => c.kind === "send").length, 0);
    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0);
    const edit = bot.calls.find((c) => c.kind === "edit");
    assert.equal(edit.opts.message_id, 88);
    assert.match(edit.text, /در حال بررسی/);
  });

  test("no messageId given (legacy text-button tap): sends exactly one message, then edits that same message for every later transition — never a delete", async () => {
    const ds = createMockDataset();
    const panel = createFakeWizard();
    const bot = botStub();
    const userId = "900004";
    await ds.users.create({ telegramId: userId });

    await createTestService(bot, msgFor(userId), { userModel: ds.users, createApi: panel.createTest });

    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0, "no delete, even without a tracked messageId");
    const sends = bot.calls.filter((c) => c.kind === "send");
    assert.equal(sends.length, 1, "exactly one text message is ever sent — the loading screen, later edited in place");
    const edits = bot.calls.filter((c) => c.kind === "edit");
    assert.ok(edits.length >= 1);
    assert.ok(edits.every((c) => c.opts.message_id === sends[0].message_id), "every edit targets the one message that was sent");
  });

  test("ambiguous panel result: edits the message in place instead of deleting it", async () => {
    const ds = createMockDataset();
    const panel = createFakeWizard(["timeout"]);
    const bot = botStub();
    const userId = "900005";
    await ds.users.create({ telegramId: userId });

    await createTestService(bot, msgFor(userId), { userModel: ds.users, createApi: panel.createTest, messageId: 55 });

    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0);
    assert.equal(bot.calls.filter((c) => c.kind === "send").length, 0);
    const finalEdit = bot.calls.filter((c) => c.kind === "edit").at(-1);
    assert.equal(finalEdit.opts.message_id, 55);
    assert.match(finalEdit.text, /مشخص نیست/);
  });

  test("a definitive panel failure: edits the message in place and restores eligibility", async () => {
    const ds = createMockDataset();
    const panel = createFakeWizard(["refuse"]);
    const bot = botStub();
    const userId = "900006";
    await ds.users.create({ telegramId: userId });

    await createTestService(bot, msgFor(userId), { userModel: ds.users, createApi: panel.createTest, messageId: 66 });

    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0);
    const finalEdit = bot.calls.filter((c) => c.kind === "edit").at(-1);
    assert.equal(finalEdit.opts.message_id, 66);
    assert.match(finalEdit.text, /انجام نشد/);
    assert.equal(ds.users.peek({ telegramId: userId }).hasReceivedTest, false, "eligibility is restored after a definitive failure");
  });

  test("Telegram's 'message is not modified' is not an edit failure: no duplicate message is sent", async () => {
    const ds = createMockDataset();
    const panel = createFakeWizard();
    const bot = botStub();
    bot.editMessageText = async () => { throw new Error("ETELEGRAM: 400 Bad Request: message is not modified: specified new message content"); };
    const userId = "900010";
    await ds.users.create({ telegramId: userId, hasReceivedTest: true });

    await createTestService(bot, msgFor(userId), { userModel: ds.users, createApi: panel.createTest, messageId: 42 });

    assert.equal(bot.calls.filter((c) => c.kind === "send").length, 0);
  });

  test("editMessageText failing (e.g. a deleted/too-old message) falls back to one fresh send, never throws", async () => {
    const ds = createMockDataset();
    const panel = createFakeWizard();
    const userId = "900007";
    await ds.users.create({ telegramId: userId });
    const bot = botStub();
    bot.editMessageText = async () => { throw new Error("message to edit not found"); };

    await assert.doesNotReject(() =>
      createTestService(bot, msgFor(userId), { userModel: ds.users, createApi: panel.createTest, messageId: 999 })
    );
    assert.equal(bot.calls.filter((c) => c.kind === "delete").length, 0, "still never deletes, even on an edit failure");
  });
});
