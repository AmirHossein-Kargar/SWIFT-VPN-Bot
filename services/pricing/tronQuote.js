import { NowPaymentsFlowError, centsToPriceAmount, readNowPaymentsConfig, tomanToFiatCents } from "../nowpayments/money.js";
import { createNowPaymentsRequest } from "../nowpayments/nowpaymentsClient.js";
import { getUsdtTomanQuote, gheymatCacheTtlMs, gheymatMaxAgeMs } from "./gheymatClient.js";
import { logQuoteFailure } from "./quoteLog.js";

const estimateCache = new Map();
let estimatePending = new Map();

function formatTrx(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const text = number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return text === "0" ? null : text;
}

export function formatTrxAmount(value) {
  return formatTrx(value);
}

function parseEstimate(body, { amount, currencyFrom, currencyTo }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed" };
  if (String(body.currency_from || "").toLowerCase() !== currencyFrom) return { ok: false, reason: "currency_from" };
  if (String(body.currency_to || "").toLowerCase() !== currencyTo) return { ok: false, reason: "currency_to" };
  const estimated = Number(body.estimated_amount);
  if (!Number.isFinite(estimated) || estimated <= 0) return { ok: false, reason: "estimated_amount" };
  if (body.amount_from == null || body.amount_from === "") return { ok: false, reason: "amount_from" };
  const amountFrom = Number(body.amount_from);
  const tolerance = Math.max(0.01, Number(amount) * 0.01);
  if (!Number.isFinite(amountFrom) || Math.abs(amountFrom - Number(amount)) > tolerance) {
    return { ok: false, reason: "amount_from" };
  }
  return { ok: true, trx: estimated };
}

async function estimatedTrx({ amount, currencyFrom, request, cacheKey, ttlMs, nowMs }) {
  const cached = estimateCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.amount;
  if (estimatePending.has(cacheKey)) return estimatePending.get(cacheKey);
  const pending = (async () => {
    const path = `/estimate?amount=${encodeURIComponent(amount)}&currency_from=${encodeURIComponent(currencyFrom)}&currency_to=trx`;
    let response;
    try {
      response = await request({ method: "GET", path });
    } catch (error) {
      logQuoteFailure("nowpayments_estimate", error, { currencyFrom, currencyTo: "trx" });
      return null;
    }
    if (!response || response.status !== 200) {
      logQuoteFailure("nowpayments_estimate", {
        code: "http_error",
        status: response?.status,
        providerCode: response?.providerCode,
        message: response?.providerMessage,
      }, { currencyFrom, currencyTo: "trx" });
      return null;
    }
    const parsed = parseEstimate(response.data, { amount, currencyFrom, currencyTo: "trx" });
    if (!parsed.ok) {
      logQuoteFailure("nowpayments_estimate_parse", {
        code: parsed.reason,
        status: 200,
        message: "estimate response was not usable",
      });
      return null;
    }
    estimateCache.set(cacheKey, { amount: parsed.trx, expiresAt: Date.now() + ttlMs });
    return parsed.trx;
  })().finally(() => {
    estimatePending.delete(cacheKey);
  });
  estimatePending.set(cacheKey, pending);
  return pending;
}

function configPresence(env) {
  return {
    apiKey: env.NOWPAYMENTS_API_KEY?.trim() ? "present" : "absent",
    ipnSecret: env.NOWPAYMENTS_IPN_SECRET?.trim() ? "present" : "absent",
    callback: (env.NOWPAYMENTS_IPN_CALLBACK_URL?.trim() || env.WEBHOOK_BASE_URL?.trim()) ? "present" : "absent",
  };
}

/**
 * Toman top-up quote.
 * Gheymat supplies USDT/IRT. NOWPayments GET /v1/estimate is optional and only
 * supplies a pre-invoice TRX estimate. The hosted POST /v1/invoice determines
 * the payable amount, so a failed estimate must not block confirmation.
 */
export async function quoteTronTopUp({
  amountToman,
  env = process.env,
  now = new Date(),
  usdtQuote = getUsdtTomanQuote,
  request,
} = {}) {
  let config;
  try {
    config = readNowPaymentsConfig(env);
  } catch (error) {
    logQuoteFailure("nowpayments_config", error, configPresence(env));
    throw error;
  }
  if (!config) {
    logQuoteFailure("nowpayments_config", { code: "not_configured", message: "missing api key, ipn secret, or callback" }, configPresence(env));
    throw new NowPaymentsFlowError("not_configured");
  }
  if (!Number.isSafeInteger(amountToman) || amountToman <= 0) throw new NowPaymentsFlowError("invalid_amount");
  let fiat;
  try {
    fiat = await usdtQuote({ env, now });
  } catch (error) {
    logQuoteFailure("gheymat_usdt_irt", error);
    throw new NowPaymentsFlowError("rate_unavailable");
  }
  const priceAmountCents = tomanToFiatCents(amountToman, fiat?.tomanPerUsdt);
  const priceAmount = centsToPriceAmount(priceAmountCents);
  if (priceAmount == null || priceAmount === amountToman) {
    logQuoteFailure("toman_to_fiat", { code: "invalid_rate", message: "toman amount could not be converted to a positive fiat invoice amount" });
    throw new NowPaymentsFlowError("invalid_rate");
  }
  const call = request || createNowPaymentsRequest({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  const estimated = await estimatedTrx({
    amount: priceAmount,
    currencyFrom: config.priceCurrency,
    request: call,
    cacheKey: `${config.priceCurrency}:${fiat.tomanPerUsdt}:${priceAmount}`,
    ttlMs: gheymatCacheTtlMs(env),
    nowMs: now.getTime(),
  });
  const tomanPerTrx = estimated ? amountToman / estimated : null;
  return {
    amountToman,
    tomanPerUsdt: fiat.tomanPerUsdt,
    priceAmountCents,
    priceCurrency: config.priceCurrency,
    estimatedTrx: estimated,
    tomanPerTrx: Number.isFinite(tomanPerTrx) && tomanPerTrx > 0 ? tomanPerTrx : null,
    estimateAvailable: estimated != null,
    quoteAt: fiat.createdAt,
    confirmedAt: now.toISOString(),
    source: "gheymat",
    maxAgeMs: gheymatMaxAgeMs(env),
  };
}

export function quoteSnapshotIsFresh(snapshot, now = new Date(), env = process.env) {
  const quoteAt = Date.parse(snapshot?.quoteAt);
  const confirmedAt = Date.parse(snapshot?.confirmedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(quoteAt) || !Number.isFinite(confirmedAt)) return false;
  if (quoteAt > nowMs + 5 * 60_000 || nowMs - quoteAt > gheymatMaxAgeMs(env)) return false;
  if (nowMs - confirmedAt > gheymatCacheTtlMs(env)) return false;
  return Number.isFinite(snapshot.tomanPerUsdt) && snapshot.tomanPerUsdt > 0
    && Number.isSafeInteger(snapshot.amountToman) && snapshot.amountToman > 0;
}

export function resetTronQuoteCacheForTests() {
  estimateCache.clear();
  estimatePending = new Map();
}
