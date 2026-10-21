import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ADMINS = "424242";
delete process.env.SUPPORT_CONTACT;

const { isAdminBanned, refuseIfBlocked, BLOCKED_NOTICE } = await import("../../services/users/accessGate.js");

function makeBot() {
  const calls = [];
  return {
    calls,
    async sendMessage(chatId, text) { calls.push({ kind: "send", chatId, text }); },
    async answerCallbackQuery(id, options) { calls.push({ kind: "answer", id, options }); },
  };
}

const userModel = (doc) => ({
  findOne() { return { select() { return this; }, async lean() { return doc; } }; },
});

describe("blocked-user access gate", () => {
  test("only admin-initiated blocks count; a 'user blocked the bot' system flag does not lock anyone out", () => {
    assert.equal(isAdminBanned({ isBanned: true, blockedBy: "424242" }), true);
    assert.equal(isAdminBanned({ isBanned: true, blockedBy: "system" }), false);
    assert.equal(isAdminBanned({ isBanned: false, blockedBy: "424242" }), false);
    assert.equal(isAdminBanned(null), false);
  });

  test("a blocked user's message is refused with a notice", async () => {
    const bot = makeBot();
    const refused = await refuseIfBlocked({ bot, userId: 5001, chatType: "private", user: { isBanned: true, blockedBy: "424242" }, chatId: 5001 });
    assert.equal(refused, true);
    assert.deepEqual(bot.calls, [{ kind: "send", chatId: 5001, text: BLOCKED_NOTICE }]);
  });

  test("a blocked user's button press is refused with an alert, not a new message", async () => {
    const bot = makeBot();
    const refused = await refuseIfBlocked({ bot, userId: 5001, chatType: "private", query: { id: "cb1" }, userModel: userModel({ isBanned: true, blockedBy: "424242" }) });
    assert.equal(refused, true);
    assert.equal(bot.calls[0].kind, "answer");
    assert.equal(bot.calls[0].options.show_alert, true);
  });

  test("silent refusal (photo/video handlers) stops processing without a duplicate notice", async () => {
    const bot = makeBot();
    const refused = await refuseIfBlocked({ bot, userId: 5001, chatType: "private", silent: true, userModel: userModel({ isBanned: true, blockedBy: "424242" }) });
    assert.equal(refused, true);
    assert.equal(bot.calls.length, 0);
  });

  test("admins, group chats, unblocked users and lookup failures are never refused", async () => {
    const bot = makeBot();
    assert.equal(await refuseIfBlocked({ bot, userId: 424242, chatType: "private", user: { isBanned: true, blockedBy: "1" }, chatId: 1 }), false, "admins");
    assert.equal(await refuseIfBlocked({ bot, userId: 5001, chatType: "supergroup", user: { isBanned: true, blockedBy: "1" }, chatId: 1 }), false, "group chats");
    assert.equal(await refuseIfBlocked({ bot, userId: 5001, chatType: "private", user: { isBanned: false }, chatId: 1 }), false, "unblocked");
    const broken = { findOne() { return { select() { return this; }, async lean() { throw new Error("db down"); } }; } };
    assert.equal(await refuseIfBlocked({ bot, userId: 5001, chatType: "private", userModel: broken, chatId: 1 }), false, "fails open");
    assert.equal(bot.calls.length, 0);
  });

  test("bot.js gates every user-facing entry point, and payment webhooks are not routed through it", () => {
    const source = readFileSync(new URL("../../bot.js", import.meta.url), "utf8");
    assert.equal((source.match(/refuseIfBlocked\(/g) || []).length, 4, "message, callback_query, photo, video");
    const server = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
    assert.equal(server.includes("refuseIfBlocked"), false, "webhook crediting must keep working for blocked users");
  });
});
