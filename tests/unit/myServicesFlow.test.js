import { test, describe } from "node:test";
import assert from "node:assert/strict";
import sendServiceSelectionMenu from "../../services/manageServices/sendServiceSelectionMenu.js";
import { sendDetailsMessage } from "../../services/manageServices/showServiceDetails.js";

function botStub({ editFails, editError } = {}) {
  const edits = [];
  const sends = [];
  const deletes = [];
  return {
    edits,
    sends,
    deletes,
    async editMessageText(text, options) {
      if (editFails) throw editError || new Error("edit failed");
      edits.push({ text, options });
    },
    async sendMessage(chatId, text, options) {
      sends.push({ chatId, text, options });
      return { message_id: 9001 };
    },
    async deleteMessage(chatId, messageId) {
      deletes.push({ chatId, messageId });
    },
  };
}

function userModelStub(user) {
  return { async findOne() { return user; } };
}

describe("sendServiceSelectionMenu (entry / my_services_from_profile)", () => {
  test("no services + no messageId: sends the exact empty-state text fresh, as before migration", async () => {
    const bot = botStub();
    await sendServiceSelectionMenu(bot, 1, 42, { userModel: userModelStub(null) });
    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.equal(bot.sends[0].text, "⚠️ شما هیچ سرویسی ندارید.");
  });

  test("no services + messageId (from my_services_from_profile): edits the profile screen in place instead of delete+resend", async () => {
    const bot = botStub();
    await sendServiceSelectionMenu(bot, 1, 42, { messageId: 55, userModel: userModelStub({ services: [] }) });
    assert.equal(bot.sends.length, 0);
    assert.equal(bot.deletes.length, 0); // no more delete-then-send for this entry point
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].options.message_id, 55);
    assert.equal(bot.edits[0].text, "⚠️ شما هیچ سرویسی ندارید.");
  });

  test("has services + messageId: edits in place, preserving show_service_<username> callback identifiers", async () => {
    const bot = botStub();
    const user = { services: [{ username: "alice-1" }, { username: "bob-2" }] };
    await sendServiceSelectionMenu(bot, 1, 42, { messageId: 55, userModel: userModelStub(user) });
    assert.equal(bot.sends.length, 0);
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].text, "📌 یکی از اشتراک‌های زیر را انتخاب کنید:");
    assert.deepEqual(bot.edits[0].options.reply_markup.inline_keyboard, [
      [{ text: "alice-1", callback_data: "show_service_alice-1" }],
      [{ text: "bob-2", callback_data: "show_service_bob-2" }],
    ]);
  });

  test("has services + no messageId (📦 سرویس‌های من text button): sends fresh, exactly as before migration", async () => {
    const bot = botStub();
    const user = { services: [{ username: "alice-1" }] };
    await sendServiceSelectionMenu(bot, 1, 42, { userModel: userModelStub(user) });
    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
  });

  test("falls back to a fresh send when the tracked message can no longer be edited", async () => {
    const bot = botStub({ editFails: true });
    const user = { services: [{ username: "alice-1" }] };
    await sendServiceSelectionMenu(bot, 1, 42, { messageId: 55, userModel: userModelStub(user) });
    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
  });
});

describe("sendDetailsMessage (service details: entry, refresh, QR-return fallback)", () => {
  test("refresh/entry: edits the existing details screen in place, no delete", async () => {
    const bot = botStub();
    const result = await sendDetailsMessage(bot, 1, 55, "details text", "svc-1", "active");
    assert.equal(bot.sends.length, 0);
    assert.equal(bot.deletes.length, 0);
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].options.message_id, 55);
    assert.equal(bot.edits[0].text, "details text");
  });

  test("returning from the QR-code photo: editing is impossible, so it sends fresh AND cleans up the stale photo", async () => {
    // This is exactly the failure editMessageText raises for a photo message.
    const bot = botStub({ editFails: true, editError: new Error("ETELEGRAM: 400 Bad Request: there is no text in the message to edit") });
    await sendDetailsMessage(bot, 1, 55, "details text", "svc-1", "active");
    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.deepEqual(bot.deletes, [{ chatId: 1, messageId: 55 }]);
  });

  test("no prior messageId at all: sends fresh and attempts no deletion", async () => {
    const bot = botStub();
    await sendDetailsMessage(bot, 1, undefined, "details text", "svc-1", "active");
    assert.equal(bot.sends.length, 1);
    assert.equal(bot.deletes.length, 0);
  });

  test("'message is not modified' (re-tapping refresh with no change): treated as a successful edit, no fallback, no delete", async () => {
    const bot = botStub({ editFails: true, editError: new Error("message is not modified: foo") });
    await sendDetailsMessage(bot, 1, 55, "details text", "svc-1", "active");
    assert.equal(bot.sends.length, 0);
    assert.equal(bot.deletes.length, 0);
  });

  test("preserves the exact button set for an active (non-limited) service", async () => {
    const bot = botStub();
    await sendDetailsMessage(bot, 1, 55, "m", "svc-1", "active");
    const rows = bot.edits[0].options.reply_markup.inline_keyboard;
    assert.deepEqual(rows.flat().map((b) => b.callback_data || b.url), [
      "https://t.me/swift_shield/9",
      "change_link_svc-1",
      "extend_service_svc-1",
      "extend_data_svc-1",
      "delete_service_svc-1",
      "qrcode_svc-1",
      "deactivate_service_svc-1",
      "show_service_svc-1",
      "buy_service_back_to_main",
    ]);
  });

  test("preserves the exact (narrower) button set for a limited service", async () => {
    const bot = botStub();
    await sendDetailsMessage(bot, 1, 55, "m", "svc-1", "limited");
    const rows = bot.edits[0].options.reply_markup.inline_keyboard;
    // No "change link" and no activate/deactivate toggle while limited — unchanged from before this migration.
    assert.deepEqual(rows.flat().map((b) => b.callback_data || b.url), [
      "https://t.me/swift_shield/9",
      "extend_service_svc-1",
      "extend_data_svc-1",
      "delete_service_svc-1",
      "qrcode_svc-1",
      "show_service_svc-1",
      "buy_service_back_to_main",
    ]);
  });
});
