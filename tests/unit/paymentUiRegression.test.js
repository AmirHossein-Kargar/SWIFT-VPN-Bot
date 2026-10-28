/**
 * Payment-UI and support-destination regressions.
 *
 * Two defects are locked down here:
 *
 *  1. A hardcoded support destination. `messages/supportContact.js` is the
 *     canonical, environment-driven support helper (SUPPORT_CONTACT) and is
 *     already used by bot.js, handlers/message/handleSupport.js and
 *     handlers/supportMessageHandler.js. The admin→user message in
 *     handlers/onMessage.js bypassed it with a literal `t.me` handle, so the
 *     deployed bot advertised a support account that operators could not
 *     configure — and `persianUiGuard` only polices supportContact.js, so the
 *     guard never saw it.
 *
 *  2. Payment-method button labels. The crypto entry point is a multi-asset
 *     NOWPayments flow (it has a currency/network picker), so asset-agnostic
 *     messages must not carry ₮ (the Tether glyph) or provider-internal names.
 *
 * These are static guards because the customer-facing strings are the
 * contract; the surrounding flows are covered by tronTopupFlow.test.js and
 * hooshpayHardening.test.js. Callback identifiers are asserted explicitly so a
 * future label change cannot silently break routing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import showPaymentMethods, {
  HOOSH_PAY_BUTTON,
  NOWPAYMENTS_BUTTON,
} from "../../handlers/message/showPaymentMethods.js";
import { getSupportContactUrl, getSupportDirectButton } from "../../messages/supportContact.js";

const read = (relPath) => readFileSync(new URL(`../../${relPath}`, import.meta.url), "utf8");

function botStub() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: 41 };
    },
    async editMessageText() {},
    async deleteMessage() {},
    async answerCallbackQuery() {},
  };
}

describe("payment-method labels", () => {
  // The exact wording is pinned in cryptoTopupFlow.test.js and
  // regressionBugs.test.js; this suite guards the properties around it.
  test("labels stay Persian and drop provider-internal names", () => {
    const PERSIAN = /[\u0600-\u06FF]/;
    for (const label of [HOOSH_PAY_BUTTON, NOWPAYMENTS_BUTTON]) {
      assert.match(label, PERSIAN, `label must be Persian: ${label}`);
    }
    // NOWPayments is a backend provider; it must not be part of the chooser
    // label the customer sees. (HooshPay stays out of the button too.)
    assert.doesNotMatch(NOWPAYMENTS_BUTTON, /NOWPayments/);
    assert.doesNotMatch(HOOSH_PAY_BUTTON, /HooshPay/);
  });

  test("the Tether glyph ₮ is gone from the multi-asset crypto flow", () => {
    // ₮ denotes Tether. The NOWPayments flow quotes and accepts many assets,
    // so an asset-agnostic message must not carry it. 🪙 is the glyph the
    // project already uses for crypto amounts and the currency picker.
    const source = read("paymentHandlers/payNowPayments.js");
    assert.doesNotMatch(source, /₮/);
    assert.doesNotMatch(read("handlers/message/showPaymentMethods.js"), /₮/);
  });

  test("the rendered keyboard uses those labels and the unchanged callbacks", async () => {
    const bot = botStub();
    await showPaymentMethods(bot, 77);
    const rows = bot.sent[0].options.reply_markup.inline_keyboard;

    assert.equal(rows[0][0].text, HOOSH_PAY_BUTTON);
    assert.equal(rows[0][0].callback_data, "pay_hoosh");
    assert.equal(rows[1][0].text, NOWPAYMENTS_BUTTON);
    assert.equal(rows[1][0].callback_data, "pay_nowpayments");
    assert.equal(rows[2][0].callback_data, "back_to_home");

    // The message itself stays Persian HTML.
    assert.equal(bot.sent[0].options.parse_mode, "HTML");
    assert.match(bot.sent[0].text, /افزایش موجودی کیف پول/);
  });
});

describe("every visible payment button routes to a real handler", () => {
  const routerSource = read("handlers/handleCallbackQuery.js");
  const exact = new Set([...routerSource.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...routerSource.matchAll(/startsWith\("([^"]+)"\)/g)].map((m) => m[1]);
  const isRouted = (id) => exact.has(id) || prefixes.some((prefix) => id.startsWith(prefix));

  test("the router fixture itself is sane", () => {
    assert.ok(exact.size > 20, `expected many routed callbacks, found ${exact.size}`);
    assert.ok(isRouted("pay_hoosh") && isRouted("pay_nowpayments"));
    // Negative control: a made-up id must not look routed.
    assert.equal(isRouted("definitely_not_a_real_callback"), false);
  });

  test("showPaymentMethods emits only routed callbacks", () => {
    const emitted = [...read("handlers/message/showPaymentMethods.js").matchAll(/callback_data:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(emitted.length >= 3, `expected the full method keyboard, found ${emitted.length}`);
    const unrouted = emitted.filter((id) => !isRouted(id));
    assert.deepEqual(unrouted, [], `unrouted callback_data: ${unrouted.join(", ")}`);
  });

  test("the crypto flow's picker/create/back buttons are all routed", () => {
    const emitted = [...read("paymentHandlers/payNowPayments.js").matchAll(/callback_data:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(emitted.includes("np_create") && emitted.includes("np_select_currency"));
    const unrouted = [...new Set(emitted)].filter((id) => !isRouted(id));
    assert.deepEqual(unrouted, [], `unrouted callback_data: ${unrouted.join(", ")}`);
  });
});

describe("support destination is configuration-driven, never hardcoded", () => {
  test("handlers/onMessage.js uses the canonical helper and has no t.me literal", () => {
    const source = read("handlers/onMessage.js");
    assert.match(source, /from "\.\.\/messages\/supportContact\.js"/);
    assert.match(source, /getSupportDirectButton\s*\(/);
    assert.doesNotMatch(source, /https?:\/\/t\.me\//, "no hardcoded Telegram link in onMessage.js");
    assert.doesNotMatch(source, /url:\s*["'`]https?:\/\//, "no hardcoded inline-button URL in onMessage.js");
  });

  test("the retired hardcoded support handle appears nowhere in source", () => {
    // Regression guard for the specific defect: the literal handle that used to
    // be baked into the admin→user keyboard.
    for (const relPath of [
      "handlers/onMessage.js",
      "handlers/message/handleSupport.js",
      "handlers/supportMessageHandler.js",
      "messages/supportContact.js",
      "paymentHandlers/payNowPayments.js",
      "handlers/message/showPaymentMethods.js",
      "bot.js",
    ]) {
      assert.doesNotMatch(read(relPath), /Swift_servicebot/i, `${relPath} hardcodes the support handle`);
    }
  });

  test("supportContact.js remains the single place a support URL is built", () => {
    const helper = read("messages/supportContact.js");
    assert.match(helper, /process\.env\.SUPPORT_CONTACT/);
    assert.match(helper, /https:\/\/t\.me\//);
  });

  test("unconfigured SUPPORT_CONTACT ⇒ no support button (fallback preserved)", () => {
    const previous = process.env.SUPPORT_CONTACT;
    try {
      delete process.env.SUPPORT_CONTACT;
      assert.equal(getSupportContactUrl(), null);
      assert.deepEqual(getSupportDirectButton(), []);

      process.env.SUPPORT_CONTACT = "@swift_support";
      const rows = getSupportDirectButton();
      assert.equal(rows.length, 1);
      assert.equal(rows[0][0].url, "https://t.me/swift_support");
      assert.match(rows[0][0].text, /[\u0600-\u06FF]/, "button label stays Persian");
    } finally {
      if (previous === undefined) delete process.env.SUPPORT_CONTACT;
      else process.env.SUPPORT_CONTACT = previous;
    }
  });
});
