import { DEFAULT_PRICE_CURRENCY, SUPPORTED_PRICE_CURRENCIES, TRON_PAY_CURRENCY } from "./constants.js";

export class NowPaymentsFlowError extends Error {
  constructor(code) {
    super(code);
    this.name = "NowPaymentsFlowError";
    this.code = code;
  }
}

export function fiatToCents(value) {
  const number = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const cents = Math.round((number + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function tomanToFiatCents(amountToman, tomanPerFiat) {
  if (!Number.isSafeInteger(amountToman) || amountToman <= 0) return null;
  if (!Number.isFinite(tomanPerFiat) || tomanPerFiat <= 0) return null;
  const cents = Math.round((amountToman * 100) / tomanPerFiat);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function centsToPriceAmount(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return Number((cents / 100).toFixed(2));
}

export function formatFiatFromCents(cents) {
  const whole = Math.trunc(cents / 100).toLocaleString("en-US");
  const fraction = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function requireHttpsUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new NowPaymentsFlowError("not_configured");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new NowPaymentsFlowError("not_configured");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) {
    throw new NowPaymentsFlowError("not_configured");
  }
  if (!name) return parsed.toString().replace(/\/+$/, "");
  return parsed.toString();
}

export function readNowPaymentsConfig(env = process.env) {
  const apiKey = env.NOWPAYMENTS_API_KEY?.trim() || "";
  const ipnSecret = env.NOWPAYMENTS_IPN_SECRET?.trim() || "";
  const explicitCallback = env.NOWPAYMENTS_IPN_CALLBACK_URL?.trim() || "";
  const webhookBase = env.WEBHOOK_BASE_URL?.trim() || "";
  const callback = explicitCallback || (webhookBase ? `${webhookBase.replace(/\/+$/, "")}/api/nowpayments/ipn` : "");
  if (!apiKey || !ipnSecret || !callback) return null;
  if (env.NOWPAYMENTS_PUBLIC_KEY?.trim() && env.NOWPAYMENTS_PUBLIC_KEY.trim() === apiKey) {
    throw new NowPaymentsFlowError("not_configured");
  }
  const priceCurrency = (env.NOWPAYMENTS_PRICE_CURRENCY?.trim() || DEFAULT_PRICE_CURRENCY).toLowerCase();
  if (!SUPPORTED_PRICE_CURRENCIES.includes(priceCurrency)) throw new NowPaymentsFlowError("not_configured");
  const baseURL = (env.NOWPAYMENTS_API_BASE_URL?.trim() || "https://api.nowpayments.io/v1").replace(/\/+$/, "");
  requireHttpsUrl(baseURL);
  requireHttpsUrl(callback);
  return {
    apiKey,
    ipnSecret,
    baseURL,
    priceCurrency,
    callbackUrl: callback,
    payCurrency: TRON_PAY_CURRENCY,
  };
}

export function currenciesIncludeTron(body, ticker = TRON_PAY_CURRENCY) {
  const list = Array.isArray(body) ? body
    : Array.isArray(body?.currencies) ? body.currencies
    : Array.isArray(body?.selectedCurrencies) ? body.selectedCurrencies
    : null;
  if (!list) return false;
  return list.some((item) => String(item).trim().toLowerCase() === ticker);
}

export function buildInvoiceRequest({ orderId, priceAmountCents, priceCurrency, payCurrency, ipnCallbackUrl, description }) {
  const priceAmount = centsToPriceAmount(priceAmountCents);
  if (!orderId || priceAmount == null || !priceCurrency || !payCurrency || !ipnCallbackUrl) {
    throw new NowPaymentsFlowError("not_configured");
  }
  return {
    price_amount: priceAmount,
    price_currency: priceCurrency,
    pay_currency: payCurrency,
    ipn_callback_url: ipnCallbackUrl,
    order_id: orderId,
    order_description: String(description || "SWIFT VPN wallet top-up").slice(0, 250),
  };
}

export function invoiceUrlIsTrusted(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:"
    && !parsed.username
    && !parsed.password
    && (host === "nowpayments.io" || host.endsWith(".nowpayments.io"));
}

export function coversCryptoAmount(actuallyPaid, payAmount) {
  const paid = Number(actuallyPaid);
  const expected = Number(payAmount);
  if (!Number.isFinite(paid) || !Number.isFinite(expected) || expected <= 0 || paid < 0) return false;
  return paid + 1e-8 >= expected;
}
