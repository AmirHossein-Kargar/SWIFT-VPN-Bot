/**
 * Telegram "🧪 تست ماک" entry points: every callback is re-authorized on the
 * server, the reply-keyboard entry refuses non-admins, and runs honour the
 * server-side MOCK_TESTS_ENABLED gate. Runs without MongoDB (report history
 * falls back to memory; queries fail fast instead of buffering).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { makeBotStub } from "../helpers/db.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
delete process.env.MOCK_TESTS_ENABLED;
mongoose.set("bufferCommands", false);

const { handleAdminPanelCallbacks, handleMockTestEntry } = await import("../../handlers/admin/panel.js");
const { resetMockRunnerForTests } = await import("../../services/mockTests/runner.js");
const ADMIN = 424242;

function query(data, { chatId = 555, chatType = "private", userId = ADMIN } = {}) {
  return { id: `q_${Math.random().toString(36).slice(2)}`, message: { chat: { id: chatId, type: chatType }, message_id: 42 }, from: { id: userId }, data };
}
const rendered = (bot) => bot.sent.filter((entry) => entry.kind === "edit" || entry.kind === "message");
const quiet = async (fn) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { [console.log, console.warn, console.error] = saved; }
};

beforeEach(() => resetMockRunnerForTests());

describe("authorization", () => {
  for (const data of ["adm:mock", "adm:mockrun:all", "adm:mockrun:purchase", "adm:mockrep"]) {
    test(`${data} is denied to non-admins`, async () => {
      process.env.MOCK_TESTS_ENABLED = "true";
      const bot = makeBotStub();
      await handleAdminPanelCallbacks(bot, query(data, { userId: 111 }));
      assert.ok(bot.sent.some((entry) => entry.kind === "answer" && /دسترسی مدیر تأیید نشد/.test(entry.opts?.text || "")));
      assert.equal(rendered(bot).length, 0, "nothing rendered or executed");
      delete process.env.MOCK_TESTS_ENABLED;
    });
  }

  test("the reply-keyboard entry refuses non-admins and group chats", async () => {
    const bot = makeBotStub();
    assert.equal(await handleMockTestEntry(bot, { chat: { id: 111, type: "private" }, from: { id: 111 } }), false);
    assert.equal(await handleMockTestEntry(bot, { chat: { id: -100, type: "supergroup" }, from: { id: ADMIN } }), false);
    assert.equal(rendered(bot).length, 0);
  });
});

describe("admin flow", () => {
  test("the main menu offers the mock-test entry", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query("adm:home"));
    assert.ok(JSON.stringify(rendered(bot)).includes("adm:mock"));
  });

  test("disabled server: the screen says so and offers no run buttons", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query("adm:mock"));
    const screen = rendered(bot).at(-1);
    assert.match(screen.text, /تست ماک/);
    assert.match(screen.text, /غیرفعال/);
    assert.ok(!JSON.stringify(screen.opts?.reply_markup || {}).includes("adm:mockrun"));
  });

  test("enabled server without a reachable audit log: the run is refused, never reported as passed", async () => {
    process.env.MOCK_TESTS_ENABLED = "true";
    try {
      const bot = makeBotStub();
      // Every run is recorded in the admin audit log first; without MongoDB that
      // write fails, so the run must be refused (successful runs: tests/unit/mockTests.test.js).
      await quiet(() => handleAdminPanelCallbacks(bot, query("adm:mockrun:all")));
      const refused = rendered(bot).at(-1);
      assert.match(refused.text, /❌/);
      assert.ok(!/PASS/.test(refused.text), "no fabricated result when the audit log cannot record the run");
    } finally {
      delete process.env.MOCK_TESTS_ENABLED;
    }
  });

  test("the entry screen lists all four scenarios", async () => {
    const bot = makeBotStub();
    await handleMockTestEntry(bot, { chat: { id: ADMIN, type: "private" }, from: { id: ADMIN } });
    const screen = rendered(bot).at(-1);
    for (const title of ["خرید اشتراک VPN", "شارژ کیف پول با ارز دیجیتال", "شارژ کارت به کارت", "سرویس تست"]) {
      assert.ok(screen.text.includes(title), title);
    }
  });
});
