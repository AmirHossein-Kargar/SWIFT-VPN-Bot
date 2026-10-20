import { test, describe } from "node:test";
import assert from "node:assert/strict";
import handleGuide, { guideButtons } from "../../handlers/message/handleGuide.js";
import { renderInterface } from "../../services/messaging/messageManager.js";

function botStub({ editFails } = {}) {
  const edits = [];
  const sends = [];
  return {
    edits,
    sends,
    async editMessageText(text, options) {
      if (editFails) throw new Error("message to edit not found");
      edits.push({ text, options });
    },
    async sendMessage(...args) {
      sends.push(args);
      return { message_id: 777 };
    },
  };
}

describe("guideButtons (shared with createTestService.js / purchaseLedger.js fulfillment messages)", () => {
  test("keeps the exact Android/iOS/Windows/purchase-guide URL buttons", () => {
    const flat = guideButtons.reply_markup.inline_keyboard.flat();
    assert.deepEqual(flat, [
      { text: "📲 اتصال در اندروید", url: "https://t.me/swift_shield/7" },
      { text: "📱 اتصال در آیفون", url: "https://t.me/swift_shield/6" },
      { text: "💻 اتصال در ویندوز", url: "https://t.me/swift_shield/8" },
      { text: "🛒 آموزش خرید از ربات", url: "https://t.me/swift_shield/6" },
    ]);
    // Every button is a plain URL button: Telegram opens the link client-side
    // and never fires a callback_query for it, so none of this can collide
    // with handleCallbackQuery.js's dispatch.
    for (const button of flat) {
      assert.equal(typeof button.url, "string");
      assert.equal(button.callback_data, undefined);
    }
  });
});

describe("handleGuide", () => {
  test("sends the exact approved guide copy with no active interface message tracked", async () => {
    const bot = botStub();
    await handleGuide(bot, 123);

    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    const [chatId, text, options] = bot.sends[0];
    assert.equal(chatId, 123);
    assert.match(text, /به بخش راهنمای ربات خوش آمدید/);
    assert.match(text, /آیفون، اندروید، ویندوز/);
    // renderInterface forwards reply_markup/parse_mode/disable_web_page_preview
    // explicitly (the latter two end up `undefined` here, which Telegram's
    // JSON transport drops exactly like an absent key) — what must be
    // byte-identical to the original guideButtons constant is reply_markup.
    assert.deepEqual(options.reply_markup, guideButtons.reply_markup);
    assert.equal(options.parse_mode, undefined);
  });

  test("falls back to a fresh send instead of throwing if editing is impossible", async () => {
    // Exercises the same path a stale/incompatible tracked message would
    // take (e.g. it was deleted, or is no longer a plain text message) —
    // handleGuide must still deliver the guide, never leave the user stuck.
    const bot = botStub({ editFails: true });
    await handleGuide(bot, 123);
    assert.equal(bot.sends.length, 1);
  });

  test("does not set parse_mode (the copy has no HTML and must render as plain text, as before)", async () => {
    const bot = botStub();
    await handleGuide(bot, 123);
    assert.equal(bot.sends[0][2].parse_mode, undefined);
  });
});

describe("guide content is identical whether rendered via edit or fresh send", () => {
  test("renderInterface produces the same text/keyboard on the edit path and the send-fallback path", async () => {
    const guideMessage = "📕 به بخش راهنمای ربات خوش آمدید";

    const editingBot = botStub();
    await renderInterface(editingBot, { chatId: 1, text: guideMessage, options: guideButtons, messageId: 50 });

    const sendingBot = botStub();
    await renderInterface(sendingBot, { chatId: 1, text: guideMessage, options: guideButtons });

    assert.equal(editingBot.edits[0].text, sendingBot.sends[0][1]);
    assert.deepEqual(editingBot.edits[0].options.reply_markup, sendingBot.sends[0][2].reply_markup);
  });
});
