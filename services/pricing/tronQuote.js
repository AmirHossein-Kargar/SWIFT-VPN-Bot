import {
  NowPaymentsFlowError,
  centsToPriceAmount,
  compareDecimalAmounts,
  formatCryptoAmount,
  normalizePayCurrency,
  readNowPaymentsConfig,
  tomanToFiatCents,
} from "../nowpayments/money.js";
import { createNowPaymentsRequest } from "../nowpayments/nowpaymentsClient.js";
import { assertMeetsMinimum, requestMinAmount } from "../nowpayments/minAmount.js";
import { fetchNowPaymentsCatalog, validateCatalogSelection } from "../nowpayments/catalog.js";
import { getSellablePlanById, getSellablePlans } from "../plans.js";
import { getUsdtTomanQuote, gheymatCacheTtlMs, gheymatMaxAgeMs } from "./gheymatClient.js";
import { logQuoteFailure } from "./quoteLog.js";
import { makeRoom, pruneExpired } from "../../utils/boundedMap.js";

// One entry per distinct (rate, amount, currency): amounts are user-entered, so the cache is capped.
const ESTIMATE_CACHE_MAX = 500;
const estimateCache = new Map();
let estimatePending = new Map();

function formatTrx(value, precision = 6) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const decimals = Number.isInteger(precision) && precision >= 0 && precision <= 12 ? precision : 6;
  const text = number.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return text === "0" ? null : text;
}

export function formatTrxAmount(value, precision = 6) {
  return formatTrx(value, precision);
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
  return { ok: true, amount: estimated };
}

async function estimatedCrypto({ amount, currencyFrom, currencyTo, request, cacheKey, ttlMs, nowMs }) {
  const cached = estimateCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.amount;
  if (estimatePending.has(cacheKey)) return estimatePending.get(cacheKey);
  const pending = (async () => {
    const path = `/estimate?amount=${encodeURIComponent(amount)}&currency_from=${encodeURIComponent(currencyFrom)}&currency_to=${encodeURIComponent(currencyTo)}`;
    let response;
    try {
      response = await request({ method: "GET", path });
    } catch (error) {
      logQuoteFailure("nowpayments_estimate", error, { currencyFrom, currencyTo });
      return null;
    }
    if (!response || response.status !== 200) {
      logQuoteFailure("nowpayments_estimate", {
        code: "http_error",
        status: response?.status,
        providerCode: response?.providerCode,
        message: response?.providerMessage,
      }, { currencyFrom, currencyTo });
      return null;
    }
    const parsed = parseEstimate(response.data, { amount, currencyFrom, currencyTo });
    if (!parsed.ok) {
      logQuoteFailure("nowpayments_estimate_parse", {
        code: parsed.reason,
        status: 200,
        message: "estimate response was not usable",
      });
      return null;
    }
    // Eviction order is the time of the last write (hits do not refresh it). A re-set
    // key keeps its old Map position, so drop it first: a just-refreshed entry must
    // not be the next one evicted, and replacing a key must not evict an unrelated one.
    estimateCache.delete(cacheKey);
    if (estimateCache.size >= ESTIMATE_CACHE_MAX) {
      pruneExpired(estimateCache, (entry) => entry.expiresAt <= Date.now());
      makeRoom(estimateCache, ESTIMATE_CACHE_MAX);
    }
    estimateCache.set(cacheKey, { amount: parsed.amount, expiresAt: Date.now() + ttlMs });
    return parsed.amount;
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
 * Toman top-up / plan quote.
 * Gheymat supplies USDT/IRT (Toman). NOWPayments GET /v1/estimate supplies the
 * crypto estimate for the selected asset/network (`payCurrency`, default `trx`).
 * When `enforceMinAmount` or `requireEstimate` is enabled, minimum amounts and
 * live estimates are strictly enforced.
 */
export async function quoteTronTopUp({
  amountToman,
  payCurrency: requestedPayCurrency = null,
  ticker: requestedTicker = null,
  network: requestedNetwork = null,
  currencyPrecision = 6,
  planId = null,
  enforceMinAmount = true,
  requireEstimate = false,
  catalogMinAmount = null,
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

  const targetPayCurrency = requestedPayCurrency
    ? normalizePayCurrency(requestedPayCurrency)
    : config.payCurrency;
  if (!targetPayCurrency) {
    throw new NowPaymentsFlowError("currency_unavailable");
  }
  const targetTicker = String(requestedTicker || targetPayCurrency).trim().toUpperCase();
  const targetNetwork = String(requestedNetwork || targetTicker).trim().toUpperCase();
  const targetPrecision = Number.isInteger(currencyPrecision) && currencyPrecision >= 0 && currencyPrecision <= 12
    ? currencyPrecision
    : 6;

  const nowDate = now instanceof Date ? now : new Date(typeof now === "function" ? now() : Number(now));
  let fiat;
  try {
    fiat = await usdtQuote({ env, now: nowDate });
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

  let minAmountInfo = null;
  if (enforceMinAmount) {
    // Fail closed: without an established provider minimum no quote is issued,
    // so no invoice can be created for an amount nobody has checked.
    minAmountInfo = await requestMinAmount({ call, config, payCurrency: targetPayCurrency });
    assertMeetsMinimum({ priceAmountCents, minInfo: minAmountInfo, tomanPerFiat: fiat.tomanPerUsdt, marginPercent: config.minAmountMarginPercent });
  } else if (Number.isFinite(Number(catalogMinAmount)) && Number(catalogMinAmount) > 0) {
    minAmountInfo = {
      minCryptoAmount: Number(Number(catalogMinAmount).toFixed(8)),
      minFiatEquivalent: null,
    };
  }

  const estimated = await estimatedCrypto({
    amount: priceAmount,
    currencyFrom: config.priceCurrency,
    currencyTo: targetPayCurrency,
    request: call,
    cacheKey: `${config.priceCurrency}:${targetPayCurrency}:${fiat.tomanPerUsdt}:${priceAmount}`,
    ttlMs: gheymatCacheTtlMs(env),
    nowMs: nowDate.getTime(),
  });

  if (requireEstimate && estimated == null) {
    throw new NowPaymentsFlowError("estimate_unavailable");
  }

  if (minAmountInfo?.minCryptoAmount != null && estimated != null) {
    const cmp = compareDecimalAmounts(estimated, minAmountInfo.minCryptoAmount);
    if (cmp !== null && cmp < 0) {
      throw new NowPaymentsFlowError("below_min_amount");
    }
  }

  const tomanPerCrypto = estimated ? amountToman / estimated : null;
  const confirmedAt = nowDate.toISOString();
  const maxAgeMs = gheymatMaxAgeMs(env);
  const quoteExpiresAt = new Date(nowDate.getTime() + gheymatCacheTtlMs(env)).toISOString();

  const quoteSnapshot = Object.freeze({
    planId: planId ? String(planId) : null,
    amountToman,
    gheymatQuote: Object.freeze({
      value: fiat.tomanPerUsdt,
      unit: fiat.unit || "toman",
      source: "gheymat",
      quoteAt: fiat.createdAt,
    }),
    priceCurrency: config.priceCurrency,
    priceAmountCents,
    finalPriceAmount: priceAmount,
    selectedAsset: Object.freeze({
      payCurrency: targetPayCurrency,
      ticker: targetTicker,
      network: targetNetwork,
      currencyPrecision: targetPrecision,
    }),
    estimate: estimated != null
      ? Object.freeze({
          estimatedAmount: estimated,
          estimatedDisplay: formatCryptoAmount(estimated, targetPrecision),
          estimateAt: confirmedAt,
        })
      : null,
    minAmount: minAmountInfo ? Object.freeze({ ...minAmountInfo }) : null,
    feePolicy: Object.freeze({
      isFixedRate: Boolean(config.isFixedRate),
      isFeePaidByUser: Boolean(config.isFeePaidByUser),
    }),
    quoteAt: fiat.createdAt,
    confirmedAt,
    quoteExpiresAt,
  });

  return {
    amountToman,
    planId: planId ? String(planId) : null,
    tomanPerUsdt: fiat.tomanPerUsdt,
    priceAmountCents,
    priceAmountUsd: priceAmount,
    priceCurrency: config.priceCurrency,
    payCurrency: targetPayCurrency,
    ticker: targetTicker,
    network: targetNetwork,
    currencyPrecision: targetPrecision,
    estimatedAmount: estimated,
    estimatedCryptoDisplay: estimated != null ? formatCryptoAmount(estimated, targetPrecision) : null,
    estimatedTrx: estimated,
    tomanPerCrypto: Number.isFinite(tomanPerCrypto) && tomanPerCrypto > 0 ? tomanPerCrypto : null,
    tomanPerTrx: Number.isFinite(tomanPerCrypto) && tomanPerCrypto > 0 ? tomanPerCrypto : null,
    estimateAvailable: estimated != null,
    minAmount: minAmountInfo,
    feePolicy: {
      isFixedRate: Boolean(config.isFixedRate),
      isFeePaidByUser: Boolean(config.isFeePaidByUser),
    },
    quoteAt: fiat.createdAt,
    confirmedAt,
    quoteExpiresAt,
    source: "gheymat",
    maxAgeMs,
    quoteSnapshot,
  };
}

async function findSellablePlanByDurationAndVolume(durationDays, gig) {
  if (!Number.isSafeInteger(durationDays) || !Number.isSafeInteger(gig)) return null;
  return (await getSellablePlans({ durationDays, requireDatabase: true })).find((plan) => plan.gig === gig) || null;
}

/**
 * Quote a dynamic cryptocurrency payment for either a wallet top-up or a VPN plan,
 * validating the selected currency & network against the live NOWPayments catalog
 * and enforcing NOWPayments minimum payment amounts and live estimates.
 */
export async function quoteCryptoPayment({
  amountToman = null,
  planSelection = null,
  payCurrency = null,
  ticker = null,
  network = null,
  catalog: providedCatalog = null,
  enforceMinAmount = true,
  requireEstimate = true,
  env = process.env,
  now = new Date(),
  usdtQuote = getUsdtTomanQuote,
  request,
} = {}) {
  let resolvedAmountToman = amountToman;
  let resolvedPlanId = null;

  if (planSelection) {
    const plan = typeof planSelection === "string"
      ? await getSellablePlanById(planSelection, { requireDatabase: true })
      : await getSellablePlanById(planSelection.planId || planSelection.id, { requireDatabase: true })
        || await findSellablePlanByDurationAndVolume(
          Number(planSelection.durationDays ?? planSelection.days),
          Number(planSelection.gig ?? planSelection.trafficGb),
        );
    if (!plan) {
      throw new NowPaymentsFlowError("invalid_plan");
    }
    resolvedAmountToman = plan.sellingPrice ?? plan.price;
    resolvedPlanId = plan.id;
  }

  const nowDate = now instanceof Date ? now : new Date(typeof now === "function" ? now() : Number(now));
  const catalog = providedCatalog || await fetchNowPaymentsCatalog({
    env,
    request,
    now: () => nowDate.getTime(),
  });

  const asset = validateCatalogSelection(catalog, {
    payCurrency: payCurrency || (!ticker ? readNowPaymentsConfig(env)?.payCurrency : null),
    ticker,
    network,
  });

  return quoteTronTopUp({
    amountToman: resolvedAmountToman,
    payCurrency: asset.code,
    ticker: asset.ticker,
    network: asset.network,
    currencyPrecision: asset.networkPrecision ?? 6,
    planId: resolvedPlanId,
    enforceMinAmount,
    requireEstimate,
    catalogMinAmount: asset.minAmount,
    env,
    now: nowDate,
    usdtQuote,
    request,
  });
}

export function quoteSnapshotIsFresh(snapshot, now = new Date(), env = process.env) {
  const quoteAt = Date.parse(snapshot?.quoteAt);
  const confirmedAt = Date.parse(snapshot?.confirmedAt);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(quoteAt) || !Number.isFinite(confirmedAt)) return false;
  if (quoteAt > nowMs + 5 * 60_000 || nowMs - quoteAt > gheymatMaxAgeMs(env)) return false;
  if (nowMs - confirmedAt > gheymatCacheTtlMs(env)) return false;
  return Number.isFinite(snapshot.tomanPerUsdt) && snapshot.tomanPerUsdt > 0
    && Number.isSafeInteger(snapshot.amountToman) && snapshot.amountToman > 0;
}

export function tronQuoteCacheSizeForTests() {
  return estimateCache.size;
}

export function resetTronQuoteCacheForTests() {
  estimateCache.clear();
  estimatePending = new Map();
}
