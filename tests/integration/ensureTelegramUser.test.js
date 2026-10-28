/**
 * Per-message account upsert against a REAL MongoDB.
 *
 * ensureTelegramUser() runs for every private message. It returns a lean,
 * projected record (just what the access gate reads) instead of a hydrated
 * document with the whole services array. These tests pin what must not change:
 * registration data, referral-code stability, and admin bans still being seen.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let User, ensureTelegramUser, isAdminBanned, refuseIfBlocked;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ ensureTelegramUser } = await import("../../services/users/ensureTelegramUser.js"));
  ({ isAdminBanned, refuseIfBlocked } = await import("../../services/users/accessGate.js"));
}

describe("ensureTelegramUser", () => {
  before(async () => { if (dbAvailable) await User.deleteMany({}); });
  after(async () => { if (dbAvailable) await disconnectTestDB(); });

  skip("registers a new account and returns only the access-gate fields", async () => {
    const account = await ensureTelegramUser({ id: 7001, first_name: "Mina", last_name: "K", username: "mina" });
    assert.equal(account.telegramId, "7001");
    assert.equal(account.isBanned, false);
    assert.equal(account.services, undefined);
    assert.equal(account.balance, undefined);
    assert.equal(typeof account.save, "undefined", "a plain record, not a hydrated document");

    const stored = await User.findOne({ telegramId: "7001" }).lean();
    assert.equal(stored.firstName, "Mina");
    assert.equal(stored.lastName, "K");
    assert.equal(stored.username, "mina");
    assert.match(stored.referralCode, /^SWIFT-[0-9A-F]{8}$/);
    assert.equal(stored.balance, 0);
    assert.ok(stored.createdAt instanceof Date && stored.lastActivityAt instanceof Date);
  });

  skip("a returning account keeps its referral code and balance, and profile changes are applied", async () => {
    const before = await User.findOne({ telegramId: "7001" }).lean();
    await User.updateOne({ telegramId: "7001" }, { $set: { balance: 55_000 } });
    await ensureTelegramUser({ id: 7001, first_name: "Mina2", username: "mina_new" });
    const after = await User.findOne({ telegramId: "7001" }).lean();
    assert.equal(after.referralCode, before.referralCode);
    assert.equal(after.balance, 55_000);
    assert.equal(after.firstName, "Mina2");
    assert.equal(after.lastName, "K", "an absent name never erases a stored one");
    assert.equal(after.username, "mina_new");
    assert.equal(await User.countDocuments({ telegramId: "7001" }), 1);
  });

  skip("an admin ban is visible on the returned record and is refused by the access gate", async () => {
    await User.updateOne({ telegramId: "7001" }, { $set: { isBanned: true, blockedBy: "8000" } });
    const account = await ensureTelegramUser({ id: 7001, first_name: "Mina2" });
    assert.equal(isAdminBanned(account), true);
    const sent = [];
    const refused = await refuseIfBlocked({ bot: { sendMessage: async (...args) => { sent.push(args); } }, userId: 7001, chatType: "private", user: account, chatId: 7001 });
    assert.equal(refused, true);
    assert.equal(sent.length, 1);
  });

  skip("a system block (the user blocked the bot) is not treated as a ban", async () => {
    await User.updateOne({ telegramId: "7001" }, { $set: { isBanned: true, blockedBy: "system" } });
    const account = await ensureTelegramUser({ id: 7001 });
    assert.equal(isAdminBanned(account), false);
  });

  skip("heavy accounts: the services array is neither returned nor modified", async () => {
    const services = Array.from({ length: 150 }, (_, i) => ({ username: `svc-${i}`, sub_link: "https://example.invalid/" + "x".repeat(200) }));
    await User.collection.insertOne({ telegramId: "7002", balance: 10, services, isBanned: false, createdAt: new Date() });
    const account = await ensureTelegramUser({ id: 7002, first_name: "Heavy" });
    assert.equal(account.services, undefined);
    const stored = await User.findOne({ telegramId: "7002" }).lean();
    assert.equal(stored.services.length, 150);
    assert.equal(stored.firstName, "Heavy");
  });

  skip("rejects an invalid Telegram user without touching the database", async () => {
    const count = await User.countDocuments({});
    await assert.rejects(() => ensureTelegramUser({ id: "abc" }), TypeError);
    await assert.rejects(() => ensureTelegramUser(null), TypeError);
    assert.equal(await User.countDocuments({}), count);
  });
});
