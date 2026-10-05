import { test, describe } from "node:test";
import assert from "node:assert/strict";
import keyboard from "../../keyboards/mainKeyboard.js";
import {
  deleteIncomingPrivateMessage,
  editOrSendUiMessage,
  isPrivateUserCallback,
  renderUiScreen,
} from "../../utils/telegramUi.js";
import handleCallbackQuery from "../../handlers/handleCallbackQuery.js";
import orderService from "../../services/buyService/orderService.js";
import User from "../../models/User.js";

function makeBot({ editError } = {}) {
  const calls = [];
  return {
    calls,
    async answerCallbackQuery(id, options = {}) {
      calls.push({ method: "answerCallbackQuery", id, options });
      return true;
    },
    async editMessageText(text, options) {
      calls.push({ method: "editMessageText", text, options });
      if (editError) throw editError;
      return { message_id: options.message_id };
    },
    async sendMessage(chatId, text, options) {
      calls.push({ method: "sendMessage", chatId, text, options });
      return { message_id: 99 };
    },
    async deleteMessage(chatId, messageId) {
      calls.push({ method: "deleteMessage", chatId, messageId });
      return true;
    },
    async editMessageReplyMarkup(replyMarkup, options) {
      calls.push({ method: "editMessageReplyMarkup", replyMarkup, options });
      return true;
    },
  };
}

describe("private Telegram UI navigation", () => {
  test("main menu uses inline callbacks, not a reply keyboard", () => {
    const markup = keyboard.reply_markup;
    assert.equal(markup.keyboard, undefined);
    const buttons = markup.inline_keyboard.flat();
    for (const action of [
      "home_buy_service",
      "home_my_services",
      "home_topup",
      "home_test_service",
      "home_profile",
      "home_guide",
      "home_support",
    ]) {
      assert.ok(buttons.some((button) => button.callback_data === action), `missing ${action}`);
    }
  });

  test("callback identity must match the private chat owner", () => {
    assert.equal(isPrivateUserCallback({ message: { chat: { id: 701, type: "private" } }, from: { id: 701 } }), true);
    assert.equal(isPrivateUserCallback({ message: { chat: { id: 701, type: "private" } }, from: { id: 702 } }), false);
    assert.equal(isPrivateUserCallback({ message: { chat: { id: -1001, type: "supergroup" } }, from: { id: 701 } }), false);
  });

  test("private incoming messages are deleted best-effort; group messages are untouched", async () => {
    const bot = makeBot();
    const privateMessage = {
      message_id: 12,
      chat: { id: 701, type: "private" },
      from: { id: 701 },
      text: "💰 افزایش موجودی",
    };
    assert.equal(await deleteIncomingPrivateMessage(bot, privateMessage), true);
    assert.deepEqual(bot.calls[0], { method: "deleteMessage", chatId: 701, messageId: 12 });

    assert.equal(await deleteIncomingPrivateMessage(bot, {
      ...privateMessage,
      chat: { id: -1001, type: "supergroup" },
    }), false);
    assert.equal(await deleteIncomingPrivateMessage(bot, {
      ...privateMessage,
      from: { id: 702 },
    }), false);
    assert.equal(bot.calls.length, 1, "only the caller's own private message is deleted");
  });

  test("Telegram deletion errors never block message processing", async () => {
    const bot = {
      async deleteMessage() { throw new Error("message cannot be deleted"); },
    };
    assert.equal(await deleteIncomingPrivateMessage(bot, {
      message_id: 13,
      chat: { id: 701, type: "private" },
      from: { id: 701 },
    }), false);
  });

  test("screen renderer edits the existing UI message instead of sending another", async () => {
    const bot = makeBot();
    const result = await renderUiScreen(
      bot,
      701,
      41,
      "💰 افزایش موجودی کیف پول",
      { reply_markup: { inline_keyboard: [[{ text: "بازگشت", callback_data: "back_to_home" }]] } }
    );

    assert.equal(result.message_id, 41);
    assert.equal(bot.calls.filter((call) => call.method === "editMessageText").length, 1);
    assert.equal(bot.calls.filter((call) => call.method === "sendMessage").length, 0);
  });

  test("renderer replaces an uneditable message once and removes the stale UI", async () => {
    const bot = makeBot({ editError: new Error("message to edit not found") });
    const result = await editOrSendUiMessage(bot, 701, 41, "صفحه جدید", { reply_markup: { inline_keyboard: [] } });
    assert.equal(result.message_id, 99);
    assert.ok(bot.calls.some((call) => call.method === "sendMessage"));
    assert.ok(bot.calls.some((call) => call.method === "deleteMessage" && call.messageId === 41));
  });

  test("purchase wrapper forwards the existing UI message ID into status rendering", async () => {
    const bot = makeBot();
    await orderService(bot, 701, 701, { price: 0, gig: 0, days: 0 }, { messageId: 61 });

    const edits = bot.calls.filter((call) => call.method === "editMessageText");
    assert.equal(edits.length, 2);
    assert.equal(edits[0].options.message_id, 61);
    assert.match(edits[0].text, /سفارش شما در حال ثبت است/);
    assert.match(edits[1].text, /پلن نامعتبر/);
    assert.equal(bot.calls.filter((call) => call.method === "sendMessage").length, 0);
  });

  test("home payment navigation edits the callback's existing bot message", async () => {
    const bot = makeBot();
    await handleCallbackQuery(bot, {
      id: "callback-private-topup",
      data: "home_topup",
      message: { chat: { id: 711, type: "private" }, message_id: 57 },
      from: { id: 711 },
    });

    const edits = bot.calls.filter((call) => call.method === "editMessageText");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].options.message_id, 57);
    assert.match(edits[0].text, /افزایش موجودی/);
    assert.equal(bot.calls.filter((call) => call.method === "sendMessage").length, 0);
  });

  test("a crafted private service callback cannot access a service owned by someone else", async () => {
    const bot = makeBot();
    const originalFindOne = User.findOne;
    let ownershipFilter;
    User.findOne = (filter) => {
      ownershipFilter = filter;
      return { lean: async () => null };
    };

    try {
      await handleCallbackQuery(bot, {
        id: "callback-forged-service",
        data: "show_service_victim-service",
        message: { chat: { id: 712, type: "private" }, message_id: 59 },
        from: { id: 712 },
      });
    } finally {
      User.findOne = originalFindOne;
    }

    assert.deepEqual(ownershipFilter, {
      telegramId: "712",
      "services.username": "victim-service",
    });
    assert.ok(bot.calls.some((call) => call.method === "answerCallbackQuery" && call.options.show_alert));
    assert.equal(bot.calls.some((call) => call.method === "editMessageText" || call.method === "sendMessage"), false);
  });

  test("a copied group callback cannot open another user's profile", async () => {
    const bot = makeBot();
    await handleCallbackQuery(bot, {
      id: "callback-forged-profile",
      data: "home_profile",
      message: { chat: { id: -100200, type: "supergroup" }, message_id: 58 },
      from: { id: 712 },
    });

    assert.ok(bot.calls.some((call) => call.method === "answerCallbackQuery" && call.options.show_alert));
    assert.equal(bot.calls.some((call) => call.method === "editMessageText" || call.method === "sendMessage"), false);
  });
});
