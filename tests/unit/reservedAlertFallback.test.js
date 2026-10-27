/**
 * Reserved-order admin alert (outbox) when the message it should EDIT no longer exists.
 *
 * Once an alert has been delivered its Telegram message id is stored and later alerts for the same order EDIT that message.
 * If the admins delete it, Telegram answers "message to edit not found" and a plain retry can never succeed. Only those
 * well-identified "target message is gone / not editable" errors may fall back to sending a replacement; every other
 * failure (network, rate limit, permissions, bad chat, formatting) keeps the existing backoff-and-retry behaviour.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";
import { makeBotStub } from "../helpers/db.js";
import { notifyReservedOrder, isReplaceableEditError } from "../../services/buyService/reservedAlerts.js";

const GROUP = "-100200300";

async function parkedWithDeliveredAlert({ messageId = 41 } = {}) {
  const models = makeFakeWalletModels([]);
  await models.purchaseModel.create({
    purchaseId: "alert-1", telegramId: "7001", planId: "mini", planName: "Mini", gig: 5, days: 7, amount: 25_000,
    status: "awaiting_provider", walletDebitStatus: "reserved", awaitingProviderSince: new Date(),
    // Pending again after an earlier alert was delivered as `messageId` (e.g. the provider was still short on a retry).
    adminAlertPending: true, adminAlertAttempts: 0, adminAlertClaimedAt: null, adminAlertNextAt: null,
    adminAlertedAt: new Date(Date.now() - 60_000), adminAlertMessageId: messageId,
  });
  return models;
}
const stored = (models) => models.purchases.get("alert-1");
const telegramError = (description, { status = 400, viaMessage = false } = {}) => {
  const error = new Error(viaMessage ? `ETELEGRAM: ${status} ${description}` : description);
  error.response = { statusCode: status, body: { ok: false, error_code: status, description } };
  return error;
};
function botWhoseEditFails(error) {
  const bot = makeBotStub();
  bot.editMessageText = async () => { bot.sent.push({ kind: "edit-attempt" }); throw error; };
  return bot;
}
const messages = (bot) => bot.sent.filter((entry) => entry.kind === "message");

describe("isReplaceableEditError", () => {
  test("accepts only the well-identified 'target message is gone or cannot be edited' errors", () => {
    for (const description of ["Bad Request: message to edit not found", "Bad Request: message can't be edited", "Bad Request: MESSAGE_ID_INVALID"]) {
      assert.equal(isReplaceableEditError(telegramError(description)), true, description);
      assert.equal(isReplaceableEditError(telegramError(description, { viaMessage: true })), true, `${description} (message only)`);
    }
  });

  test("rejects network, rate-limit, permission, chat, formatting and unknown errors", () => {
    const rejected = [
      telegramError("Too Many Requests: retry after 5", { status: 429 }),
      telegramError("Forbidden: bot was kicked from the supergroup chat", { status: 403 }),
      telegramError("Forbidden: bot is not a member of the supergroup chat", { status: 403 }),
      telegramError("Bad Request: chat not found"),
      telegramError("Bad Request: can't parse entities: Unsupported start tag"),
      telegramError("Bad Request: message is not modified"),
      telegramError("Bad Gateway", { status: 502 }),
      Object.assign(new Error("connect ETIMEDOUT 149.154.167.220:443"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("EFATAL: Error: read ECONNRESET"), { code: "EFATAL" }),
      new Error("message to edit not found"), // right words but not a Telegram API error: no response, no ETELEGRAM prefix
      telegramError("Bad Request: message to edit not found", { status: 500 }), // a 5xx is never a "gone" answer
      null,
      undefined,
    ];
    for (const error of rejected) assert.equal(isReplaceableEditError(error), false, String(error?.message ?? error));
  });
});

describe("notifyReservedOrder with a stored message id", () => {
  for (const [name, description] of [["deleted", "Bad Request: message to edit not found"], ["not editable", "Bad Request: message can't be edited"]]) {
    test(`a ${name} original is replaced by ONE new message whose id is persisted`, async () => {
      const models = await parkedWithDeliveredAlert({ messageId: 41 });
      const bot = botWhoseEditFails(telegramError(description));
      assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), true);

      assert.equal(bot.sent.filter((e) => e.kind === "edit-attempt").length, 1, "the edit was tried first");
      assert.equal(messages(bot).length, 1, "exactly one replacement message");
      assert.equal(String(messages(bot)[0].chatId), GROUP);
      assert.match(messages(bot)[0].text, /alert-1/);
      const row = stored(models);
      // The stub returns message_id = number of recorded calls, so the replacement is the 2nd call (edit attempt, then send).
      assert.equal(row.adminAlertMessageId, bot.sent.length, "the replacement's message id is stored");
      assert.notEqual(row.adminAlertMessageId, 41, "the dead id 41 is gone");
      assert.equal(row.adminAlertPending, false);
      assert.equal(row.adminAlertAttempts, 0);
      assert.ok(row.adminAlertedAt > new Date(Date.now() - 5_000), "delivery is re-stamped");
      assert.ok(!row.adminAlertClaimedAt, "the outbox claim is released");

      // Idempotent: nothing is pending any more, so a repeat sends nothing.
      assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), false);
      assert.equal(messages(bot).length, 1);
    });
  }

  test("the same recovery works when the Telegram description only appears in error.message", async () => {
    const models = await parkedWithDeliveredAlert();
    const bot = makeBotStub();
    bot.editMessageText = async () => { throw new Error("ETELEGRAM: 400 Bad Request: message to edit not found"); };
    assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), true);
    assert.equal(messages(bot).length, 1);
  });

  test("a failed replacement send keeps the order pending with backoff and the OLD id, then recovers", async () => {
    const models = await parkedWithDeliveredAlert({ messageId: 41 });
    const bot = botWhoseEditFails(telegramError("Bad Request: message to edit not found"));
    bot.sendMessage = async () => { throw telegramError("Forbidden: bot was kicked from the supergroup chat", { status: 403 }); };
    assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), false);
    let row = stored(models);
    assert.equal(row.adminAlertPending, true);
    assert.equal(row.adminAlertMessageId, 41, "nothing was replaced, so the stored id is unchanged");
    assert.equal(row.adminAlertAttempts, 1);
    assert.ok(row.adminAlertNextAt > new Date(), "the existing exponential backoff applies");
    assert.ok(!row.adminAlertClaimedAt);

    // Permissions fixed: the next attempt (backoff elapsed) sends the replacement.
    row.adminAlertNextAt = null;
    const healed = botWhoseEditFails(telegramError("Bad Request: message to edit not found"));
    assert.equal(await notifyReservedOrder(healed, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), true);
    assert.equal(messages(healed).length, 1);
    assert.equal(stored(models).adminAlertPending, false);
  });

  const unrelated = [
    ["a network timeout", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["a connection reset", Object.assign(new Error("EFATAL: read ECONNRESET"), { code: "EFATAL" })],
    ["rate limiting", telegramError("Too Many Requests: retry after 5", { status: 429 })],
    ["the bot being removed from the group", telegramError("Forbidden: bot was kicked from the supergroup chat", { status: 403 })],
    ["a chat that cannot be found", telegramError("Bad Request: chat not found")],
    ["a formatting error", telegramError("Bad Request: can't parse entities: Unsupported start tag")],
    ["a server error", telegramError("Bad Gateway", { status: 502 })],
  ];
  for (const [name, error] of unrelated) {
    test(`${name}: keeps the existing retry behaviour and sends NO replacement`, async () => {
      const models = await parkedWithDeliveredAlert({ messageId: 41 });
      const bot = botWhoseEditFails(error);
      assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), false);
      assert.equal(messages(bot).length, 0, "no replacement message");
      const row = stored(models);
      assert.equal(row.adminAlertPending, true);
      assert.equal(row.adminAlertMessageId, 41);
      assert.equal(row.adminAlertAttempts, 1);
      assert.ok(row.adminAlertNextAt > new Date(), "backoff is scheduled");
      assert.ok(!row.adminAlertClaimedAt, "claim released for the next attempt");
    });
  }

  test("'message is not modified' is still treated as delivered, with the same id and no replacement", async () => {
    const models = await parkedWithDeliveredAlert({ messageId: 41 });
    const bot = botWhoseEditFails(telegramError("Bad Request: message is not modified"));
    assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), true);
    assert.equal(messages(bot).length, 0);
    assert.equal(stored(models).adminAlertMessageId, 41);
    assert.equal(stored(models).adminAlertPending, false);
  });

  test("no stored id: the first alert is a plain send (fallback code is not involved)", async () => {
    const models = await parkedWithDeliveredAlert({ messageId: null });
    const bot = makeBotStub();
    assert.equal(await notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP }), true);
    assert.equal(messages(bot).length, 1);
    assert.equal(bot.sent.filter((e) => e.kind === "edit-attempt").length, 0);
  });

  test("concurrent attempts on a deleted original still produce a single replacement", async () => {
    const models = await parkedWithDeliveredAlert({ messageId: 41 });
    const bot = botWhoseEditFails(telegramError("Bad Request: message to edit not found"));
    const results = await Promise.all([1, 2, 3, 4].map(() => notifyReservedOrder(bot, "alert-1", { purchaseModel: models.purchaseModel, groupId: GROUP })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(messages(bot).length, 1);
  });
});
