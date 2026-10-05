import { test, describe } from "node:test";
import assert from "node:assert/strict";
import User from "../../models/User.js";
import ensureTelegramUser from "../../services/users/ensureTelegramUser.js";
import cleanupLegacyPhoneData, {
  LEGACY_PHONE_PATHS,
} from "../../services/migrations/cleanupLegacyPhoneData.js";

describe("Telegram-ID identity and obsolete phone-data cleanup", () => {
  test("the current user schema has no phone field", () => {
    assert.equal(User.schema.path("phoneNumber"), undefined);
    assert.equal(User.schema.path("phone"), undefined);
    assert.equal(User.schema.path("mobile"), undefined);
    assert.equal(User.schema.path("services").schema.path("phoneNumber"), undefined);
  });

  test("new/updated user records use Telegram ID and never persist contact data", async () => {
    const calls = [];
    const userModel = {
      async findOneAndUpdate(filter, update, options) {
        calls.push({ filter, update, options });
        return { telegramId: "701", referralCode: "SWIFT-701" };
      },
    };
    const telegramUser = {
      id: 701,
      first_name: "Arman",
      last_name: "Test",
      username: "armantest",
      phone_number: "09016405926",
    };

    const user = await ensureTelegramUser(telegramUser, {
      userModel,
      now: new Date("2026-10-05T12:00:00.000Z"),
    });

    assert.equal(user.telegramId, "701");
    assert.deepEqual(calls[0].filter, { telegramId: "701" });
    assert.equal(calls[0].options.upsert, true);
    assert.deepEqual(Object.keys(calls[0].update.$set).sort(), [
      "firstName",
      "lastActivityAt",
      "lastName",
      "username",
    ]);
    assert.equal(Object.keys(calls[0].update.$setOnInsert).includes("phoneNumber"), false);
    assert.equal(Object.keys(calls[0].update.$setOnInsert).includes("phone_number"), false);
    assert.equal("phoneNumber" in user, false);
  });

  test("the idempotent migration unsets legacy aliases from every user/payment collection", async () => {
    const calls = [];
    const names = ["User", "BankInvoice", "CryptoInvoice", "HooshPayInvoice", "WalletPurchase"];
    const models = names.map((name) => ({
      modelName: name,
      collection: {
        collectionName: name.toLowerCase(),
        async updateMany(filter, update) {
          calls.push({ name, filter, update });
          return { acknowledged: true, matchedCount: 3, modifiedCount: 2 };
        },
      },
    }));

    const results = await cleanupLegacyPhoneData(models);

    assert.equal(calls.length, names.length + 2);
    assert.deepEqual(calls.filter(({ update }) => !Object.keys(update.$unset).some((path) => path.includes("$[]"))).map(({ name }) => name), names);
    const embeddedCalls = calls.filter(({ update }) => Object.keys(update.$unset).some((path) => path.includes("$[]")));
    assert.deepEqual(embeddedCalls.map(({ name }) => name), ["User", "HooshPayInvoice"]);
    assert.deepEqual(Object.keys(calls[0].update.$unset).sort(), [...LEGACY_PHONE_PATHS].sort());
    assert.deepEqual(
      Object.keys(embeddedCalls[0].update.$unset).sort(),
      LEGACY_PHONE_PATHS.map((path) => `services.$[].${path}`).sort()
    );
    assert.deepEqual(
      Object.keys(embeddedCalls[1].update.$unset).sort(),
      LEGACY_PHONE_PATHS.map((path) => `webhookLog.$[].payload.${path}`).sort()
    );
    assert.ok(calls.every(({ filter }) => filter.$or.length === LEGACY_PHONE_PATHS.length));
    assert.equal(results.modifiedDocuments, 14);
    assert.ok(results.collections.some(({ collection }) => collection === "user.services"));
    assert.ok(results.collections.some(({ collection }) => collection === "hooshpayinvoice.webhookLog.payload"));
  });
});
