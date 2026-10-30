/**
 * After /start, button taps edit the existing message in place. A failed edit
 * never ends in silence, and every callback query is acknowledged exactly once
 * whether or not its handler succeeds.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSessionClient } from "../helpers/fakeSupport.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";

const { default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js");
const { renderWelcome } = await import("../../handlers/message/handleStart.js");
const { CHOOSE_OPTION_MESSAGE, GENERIC_ERROR_MESSAGE } = await import("../../messages/staticMessages.js");
const { resetCallbackGuardForTests } = await import("../../utils/callbackGuard.js");
const sessionStore = await import("../../config/sessionStore.js");

const USER = 1001;
const NOT_MODIFIED = "ETELEGRAM: 400 Bad Request: message is not modified: specified new message content and reply markup are exactly the same";
const CANT_EDIT = "ETELEGRAM: 400 Bad Request: message can't be edited";

function botStub({ editError, sendError } = {}) {
  const edits = [];
  const sends = [];
  const answers = [];
  let nextMessageId = 700;
  return {
    edits,
    sends,
    answers,
    async editMessageText(text, options) {
      edits.push({ text, options });
      if (editError) throw new Error(editError);
    },
    async sendMessage(chatId, text, options) {
      sends.push({ chatId, text, options });
      if (sendError) throw new Error(sendError);
      return { message_id: nextMessageId++ };
    },
    async deleteMessage() {},
    async answerCallbackQuery(id, options) {
      answers.push({ id, options });
    },
  };
}

const tap = (data, { messageId = 77, userId = USER, chatId = userId, chatType = "private" } = {}) => ({
  id: `q-${data}`,
  from: { id: userId },
  data,
  message: { message_id: messageId, chat: { id: chatId, type: chatType } },
});

beforeEach(() => { resetCallbackGuardForTests(); sessionStore.setSessionClientForTests(makeSessionClient()); });
afterEach(() => sessionStore.clearSessionClientForTests());

describe("after /start, navigation edits the existing message", () => {
  test("a button on the /start message edits that message and sends nothing new", async () => {
    const bot = botStub();
    const { messageId } = await renderWelcome(bot, { chatId: USER, userId: USER, chatType: "private" });
    const sendsAfterStart = bot.sends.length;

    await handleCallbackQuery(bot, tap("menu:home", { messageId }));

    assert.equal(bot.sends.length, sendsAfterStart, "navigation must not add a message");
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].text, CHOOSE_OPTION_MESSAGE);
    assert.equal(bot.edits[0].options.message_id, messageId);
    assert.ok(bot.edits[0].options.reply_markup.inline_keyboard.length > 0);
  });

  test("the next button keeps editing that same message", async () => {
    const bot = botStub();
    await handleCallbackQuery(bot, tap("menu:guide"));
    await handleCallbackQuery(bot, tap("menu:home"));

    assert.deepEqual(bot.edits.map((edit) => edit.options.message_id), [77, 77]);
    assert.equal(bot.sends.length, 0);
  });
});

describe("a failed edit never leaves the user without a response", () => {
  test("shared helper path: a refused edit is replaced by one fresh message with the menu", async () => {
    const bot = botStub({ editError: CANT_EDIT });
    await handleCallbackQuery(bot, tap("menu:home"));

    assert.equal(bot.sends.length, 1);
    assert.equal(bot.sends[0].text, CHOOSE_OPTION_MESSAGE);
    assert.ok(bot.sends[0].options.reply_markup.inline_keyboard.length > 0);
  });

  test("direct editMessageText path: a refused edit tells the user something went wrong", async () => {
    const bot = botStub({ editError: CANT_EDIT });
    await assert.rejects(() => handleCallbackQuery(bot, tap("alert_discount_code_disabled")), /can't be edited/);

    assert.deepEqual(bot.sends.map((send) => [send.chatId, send.text]), [[USER, GENERIC_ERROR_MESSAGE]]);
  });

  test("'not modified' on the tapped message is not a failure: the screen is already right", async () => {
    const bot = botStub({ editError: NOT_MODIFIED });
    await handleCallbackQuery(bot, tap("alert_discount_code_disabled"));

    assert.equal(bot.sends.length, 0, "a double tap must not produce an error message");
    assert.equal(bot.answers.length, 1);
  });

  test("money and provisioning callbacks get no generic 'try again'", async () => {
    // Sensitive callbacks report their own outcomes; "try again" after an unknown result could mean a second purchase.
    const bot = botStub({ editError: CANT_EDIT, sendError: "ETELEGRAM: 403 Forbidden" });
    const admin = tap("send_config_to_user_5", { userId: 9001, chatId: -100777, chatType: "supergroup" });

    await assert.rejects(() => handleCallbackQuery(bot, admin), /403/);

    assert.equal(bot.sends.filter((send) => send.text === GENERIC_ERROR_MESSAGE).length, 0);
    assert.equal(bot.answers.length, 1);
  });
});

describe("callback queries are always acknowledged", () => {
  test("exactly once when the handler fails, and the failure still reaches bot.js for logging", async () => {
    const bot = botStub({ editError: CANT_EDIT });
    await assert.rejects(() => handleCallbackQuery(bot, tap("alert_discount_code_disabled")));

    assert.deepEqual(bot.answers.map((answer) => answer.id), ["q-alert_discount_code_disabled"]);
  });

  test("even when the failure notice cannot be delivered either", async () => {
    const bot = botStub({ editError: CANT_EDIT, sendError: "ETELEGRAM: 403 Forbidden: bot was blocked by the user" });
    await assert.rejects(() => handleCallbackQuery(bot, tap("alert_discount_code_disabled")), /can't be edited/);

    assert.equal(bot.answers.length, 1);
  });

  test("exactly once on the normal path", async () => {
    const bot = botStub();
    await handleCallbackQuery(bot, tap("menu:home"));
    assert.equal(bot.answers.length, 1);
  });

  test("the acknowledgement is not lost when Telegram itself refuses it", async () => {
    const bot = botStub({ editError: CANT_EDIT });
    bot.answerCallbackQuery = async () => { throw new Error("ETELEGRAM: 400 Bad Request: query is too old"); };
    await assert.rejects(() => handleCallbackQuery(bot, tap("alert_discount_code_disabled")), /can't be edited/);
    assert.equal(bot.sends.length, 1, "the user is still told, even with an expired query");
  });
});
