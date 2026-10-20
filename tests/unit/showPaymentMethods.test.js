import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import showPaymentMethods, { HOOSH_PAY_BUTTON, NOWPAYMENTS_BUTTON } from "../../handlers/message/showPaymentMethods.js";

function botStub({ editFails, editError } = {}) {
  const edits = [];
  const sends = [];
  const deletes = [];
  return {
    edits,
    sends,
    deletes,
    async editMessageText(text, options) {
      if (editFails) throw editError || new Error("edit failed");
      edits.push({ text, options });
    },
    async sendMessage(chatId, text, options) {
      sends.push({ chatId, text, options });
      return { message_id: 9001 };
    },
    async deleteMessage(chatId, messageId) {
      deletes.push({ chatId, messageId });
    },
  };
}

function sessionSpy() {
  const calls = [];
  return { calls, setSession: async (chatId, data) => { calls.push({ chatId, data }); } };
}

const KEYBOARD = [
  [{ text: HOOSH_PAY_BUTTON, callback_data: "pay_hoosh" }],
  [{ text: NOWPAYMENTS_BUTTON, callback_data: "pay_nowpayments" }],
  [{ text: "🔙 بازگشت", callback_data: "back_to_home" }],
];

describe("showPaymentMethods: entry via reply-keyboard or back_to_topup (no messageId)", () => {
  test("sends a fresh message and initializes the session exactly as before this change", async () => {
    const bot = botStub();
    const session = sessionSpy();
    const result = await showPaymentMethods(bot, 1, { setSession: session.setSession });

    assert.equal(bot.edits.length, 0);
    assert.equal(bot.deletes.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.match(bot.sends[0].text, /💰 افزایش موجودی کیف پول/);
    assert.match(bot.sends[0].text, /لطفاً روش پرداخت را انتخاب کنید/);
    assert.deepEqual(bot.sends[0].options.reply_markup.inline_keyboard, KEYBOARD);
    assert.equal(bot.sends[0].options.parse_mode, "HTML");

    assert.deepEqual(session.calls, [{ chatId: 1, data: { step: "waiting_for_payment_method", messageId: 9001 } }]);
    assert.equal(result.message_id, 9001);
  });
});

describe("showPaymentMethods: topup_from_profile (messageId given)", () => {
  test("successful edit: no new message is sent, and the existing message id is stored in the payment session", async () => {
    const bot = botStub();
    const session = sessionSpy();
    const result = await showPaymentMethods(bot, 1, { messageId: 55, setSession: session.setSession });

    assert.equal(bot.sends.length, 0);
    assert.equal(bot.deletes.length, 0);
    assert.equal(bot.edits.length, 1);
    assert.equal(bot.edits[0].options.chat_id, 1);
    assert.equal(bot.edits[0].options.message_id, 55);
    assert.deepEqual(bot.edits[0].options.reply_markup.inline_keyboard, KEYBOARD);
    assert.equal(bot.edits[0].options.parse_mode, "HTML");
    assert.match(bot.edits[0].text, /💰 افزایش موجودی کیف پول/);

    assert.deepEqual(session.calls, [{ chatId: 1, data: { step: "waiting_for_payment_method", messageId: 55 } }]);
    assert.equal(result.message_id, 55);
  });

  test("failed edit: a replacement message is sent, the stale profile message is cleaned up, and the replacement id is stored", async () => {
    const bot = botStub({ editFails: true, editError: new Error("message to edit not found") });
    const session = sessionSpy();
    const result = await showPaymentMethods(bot, 1, { messageId: 55, setSession: session.setSession });

    assert.equal(bot.edits.length, 0);
    assert.equal(bot.sends.length, 1);
    assert.deepEqual(bot.sends[0].options.reply_markup.inline_keyboard, KEYBOARD);
    assert.deepEqual(bot.deletes, [{ chatId: 1, messageId: 55 }]);

    assert.deepEqual(session.calls, [{ chatId: 1, data: { step: "waiting_for_payment_method", messageId: 9001 } }]);
    assert.equal(result.message_id, 9001);
  });

  test("the stale-message delete never runs before the replacement is confirmed sent", async () => {
    // Guards against a regression that deletes the old screen unconditionally
    // (the pre-migration behavior) rather than only on a confirmed fallback.
    const order = [];
    const bot = {
      async editMessageText() { throw new Error("edit failed"); },
      async sendMessage(...args) { order.push("send"); return { message_id: 9001 }; },
      async deleteMessage() { order.push("delete"); },
    };
    await showPaymentMethods(bot, 1, { messageId: 55, setSession: async () => {} });
    assert.deepEqual(order, ["send", "delete"]);
  });
});

describe("architectural guard: the payment flow never imports the shared Message Manager", () => {
  test("no payment handler or payment service references services/messaging/*", () => {
    const paymentSources = [
      "paymentHandlers/handleBankRecipt.js",
      "paymentHandlers/handleTrxAmount.js",
      "paymentHandlers/payBank.js",
      "paymentHandlers/payHoosh.js",
      "paymentHandlers/payNowPayments.js",
      "paymentHandlers/payTrx.js",
      "paymentHandlers/promptForReceipt.js",
      "handlers/message/showPaymentMethods.js",
      "services/hooshpay/createHooshInvoice.js",
      "services/hooshpay/fulfillHooshOrder.js",
      "services/hooshpay/hooshpayClient.js",
      "services/hooshpay/hooshpayRecoveryCron.js",
      "services/hooshpay/paymentValidation.js",
      "services/hooshpay/verifyHooshPayment.js",
      "services/hooshpay/verifyLock.js",
      "services/hooshpay/verifySignature.js",
      "services/nowpayments/applyStatus.js",
      "services/nowpayments/catalog.js",
      "services/nowpayments/constants.js",
      "services/nowpayments/createInvoice.js",
      "services/nowpayments/exchangeRate.js",
      "services/nowpayments/ipnHandler.js",
      "services/nowpayments/labels.js",
      "services/nowpayments/money.js",
      "services/nowpayments/notify.js",
      "services/nowpayments/nowpaymentsClient.js",
      "services/nowpayments/recovery.js",
      "services/nowpayments/signature.js",
      "services/payments/confirmBankPayment.js",
      "services/payments/invoiceCleanup.js",
      "services/payments/status.js",
    ].map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).join("\n");

    // Matches an actual import/require of the shared messaging module (any
    // number of "../" segments, as used from within services/*), not prose
    // in a comment explaining why it must stay out — showPaymentMethods.js
    // itself documents that rationale, so a bare substring check would
    // false-positive on its own warning.
    const importsSharedMessaging = /\b(?:from|require\()\s*["'][^"']*\/messaging\/(?:messageManager|activeMessageStore)\.js["']/.test(paymentSources);
    assert.equal(importsSharedMessaging, false);
  });
});
