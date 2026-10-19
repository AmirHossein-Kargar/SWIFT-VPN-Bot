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

export function normalizePayCurrency(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(cleaned)) return null;
  return cleaned;
}

function parseBoolEnv(raw, defaultValue = false) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

export function readNowPaymentsConfig(env = process.env, { allowWithoutCallback = false } = {}) {
  const apiKey = env.NOWPAYMENTS_API_KEY?.trim() || "";
  const ipnSecret = env.NOWPAYMENTS_IPN_SECRET?.trim() || "";
  const explicitCallback = env.NOWPAYMENTS_IPN_CALLBACK_URL?.trim() || "";
  const webhookBase = env.WEBHOOK_BASE_URL?.trim() || "";
  const callback = explicitCallback || (webhookBase ? `${webhookBase.replace(/\/+$/, "")}/api/nowpayments/ipn` : "");
  if (!apiKey) return null;
  if (!allowWithoutCallback && (!ipnSecret || !callback)) return null;
  if (env.NOWPAYMENTS_PUBLIC_KEY?.trim() && env.NOWPAYMENTS_PUBLIC_KEY.trim() === apiKey) {
    throw new NowPaymentsFlowError("not_configured");
  }
  const priceCurrency = (env.NOWPAYMENTS_PRICE_CURRENCY?.trim() || DEFAULT_PRICE_CURRENCY).toLowerCase();
  if (!SUPPORTED_PRICE_CURRENCIES.includes(priceCurrency)) throw new NowPaymentsFlowError("not_configured");
  const baseURL = (env.NOWPAYMENTS_API_BASE_URL?.trim() || "https://api.nowpayments.io/v1").replace(/\/+$/, "");
  requireHttpsUrl(baseURL);
  if (callback) requireHttpsUrl(callback);
  const configuredPayCurrency = env.NOWPAYMENTS_PAY_CURRENCY?.trim()
    ? normalizePayCurrency(env.NOWPAYMENTS_PAY_CURRENCY)
    : TRON_PAY_CURRENCY;
  if (!configuredPayCurrency) throw new NowPaymentsFlowError("not_configured");

  const email = env.NOWPAYMENTS_EMAIL?.trim() || "";
  const password = env.NOWPAYMENTS_PASSWORD?.trim() || "";
  const rawCatalogTtl = Number(env.NOWPAYMENTS_CATALOG_TTL_SECONDS || 300);
  const catalogTtlMs = Number.isFinite(rawCatalogTtl) && rawCatalogTtl >= 30 && rawCatalogTtl <= 3600
    ? Math.trunc(rawCatalogTtl * 1000)
    : 300_000;

  return {
    apiKey,
    ipnSecret,
    baseURL,
    priceCurrency,
    callbackUrl: callback,
    payCurrency: configuredPayCurrency,
    email,
    password,
    hasCustodyAuth: Boolean(email && password),
    catalogTtlMs,
    isFixedRate: parseBoolEnv(env.NOWPAYMENTS_FIXED_RATE, false),
    isFeePaidByUser: parseBoolEnv(env.NOWPAYMENTS_FEE_PAID_BY_USER, false),
  };
}

export function currenciesIncludeAsset(body, ticker = TRON_PAY_CURRENCY) {
  const normalizedTicker = normalizePayCurrency(ticker);
  if (!normalizedTicker) return false;
  const list = Array.isArray(body) ? body
    : Array.isArray(body?.currencies) ? body.currencies
    : Array.isArray(body?.selectedCurrencies) ? body.selectedCurrencies
    : null;
  if (!list) return false;
  return list.some((item) => {
    if (typeof item === "string") return item.trim().toLowerCase() === normalizedTicker;
    if (item && typeof item === "object") {
      const code = String(item.code || item.currency || "").trim().toLowerCase();
      if (item.enable === false) return false;
      return code === normalizedTicker;
    }
    return false;
  });
}

export function currenciesIncludeTron(body, ticker = TRON_PAY_CURRENCY) {
  return currenciesIncludeAsset(body, ticker);
}

export function buildInvoiceRequest({
  orderId,
  priceAmountCents,
  priceCurrency,
  payCurrency,
  ipnCallbackUrl,
  description,
  isFixedRate,
  isFeePaidByUser,
  successUrl,
  cancelUrl,
}) {
  const priceAmount = centsToPriceAmount(priceAmountCents);
  const normalizedPayCurrency = normalizePayCurrency(payCurrency);
  if (!orderId || priceAmount == null || !priceCurrency || !normalizedPayCurrency || !ipnCallbackUrl) {
    throw new NowPaymentsFlowError("not_configured");
  }
  const payload = {
    price_amount: priceAmount,
    price_currency: priceCurrency,
    pay_currency: normalizedPayCurrency,
    ipn_callback_url: ipnCallbackUrl,
    order_id: orderId,
    order_description: String(description || "SWIFT VPN wallet top-up").slice(0, 250),
  };
  if (typeof isFixedRate === "boolean" && isFixedRate) payload.is_fixed_rate = true;
  if (typeof isFeePaidByUser === "boolean" && isFeePaidByUser) payload.is_fee_paid_by_user = true;
  if (successUrl) payload.success_url = String(successUrl);
  if (cancelUrl) payload.cancel_url = String(cancelUrl);
  return payload;
}

export function buildDirectPaymentRequest({
  orderId,
  priceAmountCents,
  priceCurrency,
  payCurrency,
  payAmount,
  ipnCallbackUrl,
  description,
  isFixedRate,
  isFeePaidByUser,
}) {
  const priceAmount = centsToPriceAmount(priceAmountCents);
  const normalizedPayCurrency = normalizePayCurrency(payCurrency);
  if (!orderId || priceAmount == null || !priceCurrency || !normalizedPayCurrency || !ipnCallbackUrl) {
    throw new NowPaymentsFlowError("not_configured");
  }
  const payload = {
    price_amount: priceAmount,
    price_currency: priceCurrency,
    pay_currency: normalizedPayCurrency,
    ipn_callback_url: ipnCallbackUrl,
    order_id: orderId,
    order_description: String(description || "SWIFT VPN wallet top-up").slice(0, 250),
  };
  if (payAmount != null && Number.isFinite(Number(payAmount)) && Number(payAmount) > 0) {
    payload.pay_amount = Number(payAmount);
  }
  if (typeof isFixedRate === "boolean") payload.is_fixed_rate = isFixedRate;
  if (typeof isFeePaidByUser === "boolean") payload.is_fee_paid_by_user = isFeePaidByUser;
  return payload;
}

export function buildInvoicePaymentRequest({ iid, payCurrency, purchaseId, orderDescription, customerEmail }) {
  const normalizedPayCurrency = normalizePayCurrency(payCurrency);
  if (!iid || !normalizedPayCurrency) {
    throw new NowPaymentsFlowError("not_configured");
  }
  const payload = {
    iid: String(iid).trim(),
    pay_currency: normalizedPayCurrency,
  };
  if (purchaseId) payload.purchase_id = String(purchaseId).trim();
  if (orderDescription) payload.order_description = String(orderDescription).slice(0, 250);
  if (customerEmail) payload.customer_email = String(customerEmail).trim();
  return payload;
}

const DECIMAL_SCALE = 12;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

export function toScaledBigInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "number"
    ? (Number.isFinite(value) ? value.toFixed(DECIMAL_SCALE) : "")
    : String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const paddedFrac = (fracPart + "0".repeat(DECIMAL_SCALE)).slice(0, DECIMAL_SCALE);
  const scaled = BigInt(wholePart) * DECIMAL_FACTOR + BigInt(paddedFrac || "0");
  return negative ? -scaled : scaled;
}

export function compareDecimalAmounts(a, b) {
  const left = toScaledBigInt(a);
  const right = toScaledBigInt(b);
  if (left === null || right === null) return null;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

export function formatCryptoAmount(value, maxDecimals = 8) {
  const num = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  const precision = Number.isInteger(maxDecimals) && maxDecimals >= 0 && maxDecimals <= 12 ? maxDecimals : 8;
  return num.toFixed(precision).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
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
