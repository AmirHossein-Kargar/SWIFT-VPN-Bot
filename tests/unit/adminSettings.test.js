import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242";

const { getSettingsOverview } = await import("../../services/admin/settings.js");

const SECRETS = {
  BOT_TOKEN: "123456:secret-bot-token-value",
  HOOSHPAY_API_KEY: "hooshpay-secret-key-value",
  HOOSHPAY_WEBHOOK_SECRET: "hooshpay-webhook-secret-value",
  NOWPAYMENTS_API_KEY: "nowpayments-secret-api-key",
  NOWPAYMENTS_IPN_SECRET: "nowpayments-ipn-secret-value",
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://shop.example.com/api/nowpayments/ipn",
  VPN_API_KEY: "wizard-vpn-secret-key",
  WIZARD_API_URL: "https://panel.internal.example/api?token=leak",
  TRX_WALLET: "TXyzSecretWalletAddress0000000000",
  MONGO_URL: "mongodb://user:password@host/db",
  SUPPORT_CONTACT: "@swift_support",
  GROUP_ID: "-1001234567890",
  WEBHOOK_BASE_URL: "https://shop.example.com",
  NODE_ENV: "production",
};

describe("settings overview", () => {
  test("never returns a raw environment value — only booleans and non-sensitive constants", () => {
    const overview = getSettingsOverview({ actorId: "424242", env: SECRETS });
    const serialized = JSON.stringify(overview);
    for (const [name, value] of Object.entries(SECRETS)) {
      if (name === "NODE_ENV") continue;
      assert.equal(serialized.includes(value), false, `${name} leaked`);
    }
    assert.equal(overview.payments.hooshpay.apiKey, true);
    assert.equal(overview.payments.nowpayments.ipnVerification, true);
    assert.equal(overview.vpn.wizardApiKey, true);
    assert.equal(overview.telegram.botToken, true);
    assert.equal(overview.application.environment, "production");
  });

  test("reports missing configuration as false instead of failing", () => {
    const overview = getSettingsOverview({ actorId: "424242", env: {} });
    assert.equal(overview.payments.hooshpay.apiKey, false);
    assert.equal(overview.payments.nowpayments.valid, false);
    assert.equal(overview.telegram.botToken, false);
    assert.equal(overview.features.mockTests, false);
    assert.equal(overview.application.environment, "development");
  });

  test("requires an admin actor", () => {
    assert.throws(() => getSettingsOverview({ actorId: "111", env: {} }));
  });
});
