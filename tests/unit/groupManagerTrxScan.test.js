/**
 * Regression: the admin group's "🔍 اسکن ولت TRX" command used to send a
 * "در حال اسکن..." loading message and then a SEPARATE result message,
 * leaving both permanently in the chat instead of one edited screen.
 */
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import trxScanner from "../../services/trxWalletScanner.js";
import { isAdminUser } from "../../utils/auth.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";

const { handleGroupMessage } = await import("../../handlers/admin/groupManager.js");

function botStub() {
  const edits = [];
  const sends = [];
  let nextId = 1;
  return {
    edits,
    sends,
    async sendMessage(chatId, text, options) {
      const message_id = nextId++;
      sends.push({ chatId, text, options, message_id });
      return { message_id };
    },
    async editMessageText(text, options) {
      edits.push({ text, options });
      return true;
    },
  };
}

const groupMsg = (text) => ({ message_id: 1, chat: { id: -100777, type: "supergroup" }, from: { id: 9001 }, text });

afterEach(() => mock.restoreAll());

describe("handleTrxScan: single-message UX", () => {
  test("a successful scan edits the loading message into the result — never a second message", async () => {
    mock.method(trxScanner, "manualScan", async () => {});
    const bot = botStub();

    await handleGroupMessage(bot, groupMsg("🔍 اسکن ولت TRX"));

    assert.equal(bot.sends.length, 1, "exactly one message is sent — the loading screen");
    const loadingId = bot.sends[0].message_id;
    assert.equal(bot.edits.length, 1, "the result is an edit, not a second message");
    assert.equal(bot.edits[0].options.message_id, loadingId);
    assert.match(bot.edits[0].text, /موفقیت/);
  });

  test("a failed scan edits the loading message into the error — never a second message", async () => {
    mock.method(trxScanner, "manualScan", async () => { throw new Error("provider unreachable"); });
    const bot = botStub();

    await handleGroupMessage(bot, groupMsg("🔍 اسکن ولت TRX"));

    assert.equal(bot.sends.length, 1);
    const loadingId = bot.sends[0].message_id;
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].options.message_id, loadingId);
    assert.match(bot.edits[0].text, /خطا/);
  });

  test("sanity: the admin allowlist used by this suite is configured", () => {
    assert.equal(isAdminUser(9001), true);
  });
});
