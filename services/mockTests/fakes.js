/**
 * Deterministic test adapters for every external side effect touched by the
 * mock scenarios. None of them perform I/O: they record calls so scenarios can
 * assert how often a non-idempotent provider operation was attempted.
 *
 * Identifiers are visibly synthetic (`mock_…`, `MOCK…`, `.invalid` hosts) so a
 * value that ever leaked into a log or report could not be mistaken for a real
 * customer, invoice, or subscription.
 */
import { createHmac, randomBytes } from "node:crypto";
import { WizardApiError } from "../../api/wizardApi.js";
import { canonicalPayload } from "../hooshpay/verifySignature.js";

/** Reserved Telegram-ID range for mock users (never issued by Telegram). */
export const MOCK_USER_ID_BASE = 990_000_000_000_000;
export const MOCK_HOST = "mock-tests.invalid";
export const MOCK_BASE_URL = `https://${MOCK_HOST}`;

export function mockUserId(n) {
  return String(MOCK_USER_ID_BASE + Number(n));
}

export function isMockUserId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= MOCK_USER_ID_BASE && id < MOCK_USER_ID_BASE + 1_000_000;
}

export function mockId(prefix) {
  return `mock_${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Records every Telegram call; never talks to Telegram. */
export function createFakeBot() {
  const calls = [];
  let nextMessageId = 1;
  const record = (method) => async (chatId, ...args) => {
    calls.push({ method, chatId: String(chatId), args });
    return { message_id: nextMessageId++, chat: { id: chatId } };
  };
  return {
    calls,
    sendMessage: record("sendMessage"),
    sendPhoto: record("sendPhoto"),
    deleteMessage: record("deleteMessage"),
    editMessageText: async (text, options) => { calls.push({ method: "editMessageText", chatId: String(options?.chat_id), args: [text] }); return true; },
    answerCallbackQuery: async () => true,
    to(chatId) { return calls.filter((call) => call.chatId === String(chatId)); },
    textsTo(chatId) {
      return calls.filter((call) => call.chatId === String(chatId))
        .map((call) => (call.method === "sendPhoto" ? String(call.args[1]?.caption || "") : String(call.args[0] || "")));
    },
  };
}

/**
 * WizardXray adapter. `plan` is a queue of outcomes consumed per create call;
 * when it runs out, calls succeed.
 *   success   → valid provisioning response
 *   reject    → definitive provider rejection (non-ambiguous WizardApiError)
 *   timeout   → ambiguous transport failure (request may have been applied)
 *   malformed → ok:true but an unusable body (also ambiguous)
 */
export function createFakeWizard(plan = []) {
  const queue = [...plan];
  const calls = [];
  let serial = 0;
  const respond = (operation, args) => {
    calls.push({ operation, args });
    const outcome = queue.length ? queue.shift() : "success";
    if (outcome === "reject") {
      throw new WizardApiError(operation, { status: 402, code: "provider_insufficient_balance", ambiguous: false });
    }
    if (outcome === "timeout") {
      throw new WizardApiError(operation, { code: "timeout", ambiguous: true });
    }
    if (outcome === "malformed") return { ok: true, result: { note: "unexpected" } };
    serial += 1;
    const username = `mock_svc_${serial}_${randomBytes(3).toString("hex")}`;
    return {
      ok: true,
      result: {
        username,
        hash: `MOCKHASH${serial}${randomBytes(4).toString("hex")}`,
        sub_link: `${MOCK_BASE_URL}/sub/${username}`,
        tak_links: [`vless://${username}@${MOCK_HOST}:443?security=tls#mock`],
      },
    };
  };
  return {
    calls,
    createCalls: () => calls.filter((call) => call.operation === "service creation").length,
    testCalls: () => calls.filter((call) => call.operation === "test service creation").length,
    async create(gig, days, test = 0) { return respond("service creation", [gig, days, test]); },
    async createTest() { return respond("test service creation", []); },
  };
}

/** Provider data fed through the real catalog builder. */
export const MOCK_NOWPAYMENTS_CURRENCIES = Object.freeze([
  { code: "trx", ticker: "trx", network: "trx", name: "TRON", enable: true, priority: 1 },
  { code: "usdttrc20", ticker: "usdt", network: "trx", name: "Tether USD (TRC20)", enable: true, priority: 2 },
  { code: "usdterc20", ticker: "usdt", network: "eth", name: "Tether USD (ERC20)", enable: true, priority: 3 },
  { code: "ton", ticker: "ton", network: "ton", name: "Toncoin", enable: true, priority: 4 },
]);

export function mockNowPaymentsEnv(ipnSecret) {
  return {
    NOWPAYMENTS_API_KEY: "mock-api-key-not-a-real-credential",
    NOWPAYMENTS_IPN_SECRET: ipnSecret,
    NOWPAYMENTS_API_BASE_URL: "https://mock-nowpayments.invalid/v1",
    WEBHOOK_BASE_URL: MOCK_BASE_URL,
    NOWPAYMENTS_PRICE_CURRENCY: "usd",
  };
}

/**
 * NOWPayments transport. `invoiceOutcomes` is a queue for POST /invoice:
 * ok | http500 | http400 | throw (transport error).
 */
export function createFakeNowPayments({ invoiceOutcomes = [], payAmount = null } = {}) {
  const queue = [...invoiceOutcomes];
  const calls = [];
  let serial = 0;
  async function request({ method, path, data }) {
    calls.push({ method, path, data: data ? { ...data } : null });
    if (method === "GET" && path === "/currencies") {
      return { status: 200, data: { currencies: MOCK_NOWPAYMENTS_CURRENCIES.map((entry) => entry.code) } };
    }
    if (method === "POST" && path === "/invoice") {
      const outcome = queue.length ? queue.shift() : "ok";
      if (outcome === "throw") {
        const error = new Error("mock transport timeout");
        error.ambiguous = true;
        throw error;
      }
      if (outcome === "http500") return { status: 502, data: null, providerMessage: "mock upstream error" };
      if (outcome === "http400") return { status: 400, data: null, providerCode: "MOCK_REJECTED", providerMessage: "mock rejection" };
      serial += 1;
      const id = `MOCKINV${serial}${randomBytes(4).toString("hex")}`;
      return {
        status: 200,
        data: {
          id,
          order_id: data.order_id,
          // invoiceUrlIsTrusted() only accepts the provider host; this URL is
          // never opened and the iid is visibly synthetic.
          invoice_url: `https://nowpayments.io/payment/?iid=${id}`,
          price_amount: data.price_amount,
          price_currency: data.price_currency,
          pay_currency: data.pay_currency,
          pay_amount: payAmount ?? Number((Number(data.price_amount) * 4).toFixed(6)),
        },
      };
    }
    return { status: 404, data: null };
  }
  return { calls, request, invoiceCalls: () => calls.filter((call) => call.path === "/invoice").length };
}

/** A complete NOWPayments IPN body for a stored invoice. */
export function nowPaymentsIpn(invoice, { status = "finished", paymentId, actuallyPaid, priceAmount } = {}) {
  return {
    payment_id: paymentId,
    invoice_id: invoice.invoiceId,
    order_id: invoice.orderId,
    payment_status: status,
    price_amount: priceAmount ?? Number((invoice.priceAmountCents / 100).toFixed(2)),
    price_currency: invoice.priceCurrency,
    pay_currency: invoice.payCurrency,
    pay_amount: invoice.payAmount,
    actually_paid: actuallyPaid ?? (status === "finished" ? invoice.payAmount : 0),
    pay_address: "MOCK-ADDRESS-NOT-ON-CHAIN",
    outcome_amount: null,
    outcome_currency: null,
  };
}

/** HooshPay client adapter (createInvoice / cancelInvoice). */
export function createFakeHooshPay({ outcomes = [] } = {}) {
  const queue = [...outcomes];
  const calls = [];
  let serial = 0;
  return {
    calls,
    async createInvoice(params) {
      calls.push({ operation: "create", params: { ...params } });
      const outcome = queue.length ? queue.shift() : "ok";
      if (outcome === "timeout") {
        const error = new Error("mock HooshPay timeout");
        error.ambiguous = true;
        throw error;
      }
      if (outcome === "reject") throw new Error("mock HooshPay rejection");
      serial += 1;
      return {
        uid: `MOCKHP${serial}${randomBytes(4).toString("hex")}`,
        payment_url: `${MOCK_BASE_URL}/hooshpay/pay/${serial}`,
        amount: params.amount,
        fee_mode: "buyer",
        card: { card_number: "0000-MOCK-0000-0000", holder_name: "MOCK", bank_name: "MOCK BANK" },
      };
    },
    async cancelInvoice(uid) {
      calls.push({ operation: "cancel", params: { uid } });
      return { ok: true };
    },
  };
}

/** Sign a HooshPay webhook body exactly as the gateway does (ksort + HMAC-SHA256). */
export function signHooshPayload(payload, secret) {
  return createHmac("sha256", secret).update(canonicalPayload(payload), "utf8").digest("hex");
}

export function mockSecret() {
  return `mock-secret-${randomBytes(24).toString("hex")}`;
}

export default {
  MOCK_USER_ID_BASE, MOCK_BASE_URL, mockUserId, isMockUserId, mockId, mockSecret,
  createFakeBot, createFakeWizard, createFakeNowPayments, createFakeHooshPay,
  mockNowPaymentsEnv, nowPaymentsIpn, signHooshPayload,
};
