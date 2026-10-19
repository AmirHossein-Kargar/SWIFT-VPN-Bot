import {
  NowPaymentsFlowError,
  normalizePayCurrency,
  readNowPaymentsConfig,
} from "./money.js";
import { createNowPaymentsClient } from "./nowpaymentsClient.js";
import { logQuoteFailure } from "../pricing/quoteLog.js";

const catalogCache = new Map();

export function resetNowPaymentsCatalogCacheForTests() {
  catalogCache.clear();
}

// Customers know "USDT on TRC20", while the provider's own network field for
// that asset is "trx". The code suffix after the ticker is the unambiguous
// label (usdttrc20 -> TRC20, usdtton -> TON); the provider network is only
// used when the code carries no suffix.
function normalizeNetworkCode(network, code, ticker) {
  const cleanCode = String(code || "").trim().toLowerCase();
  const cleanTicker = String(ticker || "").trim().toLowerCase();
  if (cleanTicker && cleanCode.startsWith(cleanTicker) && cleanCode.length > cleanTicker.length) {
    const suffix = cleanCode.slice(cleanTicker.length).replace(/^[-_]+/, "");
    if (suffix) return suffix.toUpperCase();
  }
  if (typeof network === "string" && network.trim()) {
    return network.trim().toUpperCase();
  }
  return (cleanTicker || cleanCode).toUpperCase();
}

/** Customer-facing order of the first menu; every other asset follows. */
export const PREFERRED_TICKERS = Object.freeze(["USDT", "TON", "TRX", "BTC", "LTC", "ETH"]);

function preferredRank(ticker) {
  const index = PREFERRED_TICKERS.indexOf(ticker);
  return index === -1 ? PREFERRED_TICKERS.length : index;
}

function normalizeTickerCode(ticker, code) {
  if (typeof ticker === "string" && ticker.trim()) {
    return ticker.trim().toUpperCase();
  }
  const cleanCode = String(code || "").trim().toLowerCase();
  const knownSuffixes = ["trc20", "erc20", "bsc", "bep20", "matic", "polygon", "sol", "ton", "arb", "arbitrum", "op", "optimism", "avaxc", "algo"];
  for (const suffix of knownSuffixes) {
    if (cleanCode.endsWith(suffix) && cleanCode.length > suffix.length) {
      return cleanCode.slice(0, cleanCode.length - suffix.length).replace(/[-_]+$/, "").toUpperCase();
    }
  }
  return cleanCode.toUpperCase();
}

export function normalizeCatalogAsset(entry, { fixedRateSet = new Set(), merchantSet = null } = {}) {
  if (typeof entry === "string") {
    const code = normalizePayCurrency(entry);
    if (!code) return null;
    if (merchantSet && merchantSet.size > 0 && !merchantSet.has(code)) return null;
    const ticker = normalizeTickerCode(null, code);
    const network = normalizeNetworkCode(null, code, ticker);
    return {
      id: null,
      code,
      name: code.toUpperCase(),
      ticker,
      network,
      enable: true,
      isMerchantEnabled: merchantSet ? merchantSet.has(code) : true,
      fixedRateSupported: fixedRateSet.has(code),
      smartContract: null,
      networkPrecision: null,
      extraIdExists: false,
      extraIdRegex: null,
      walletRegex: null,
      minAmount: null,
      isMaxLimit: false,
      priority: null,
      usdPrice: null,
    };
  }

  if (!entry || typeof entry !== "object") return null;
  if (entry.enable === false) return null;
  const code = normalizePayCurrency(entry.code || entry.currency);
  if (!code) return null;
  if (merchantSet && merchantSet.size > 0 && !merchantSet.has(code)) return null;

  const ticker = normalizeTickerCode(entry.ticker, code);
  const network = normalizeNetworkCode(entry.network, code, ticker);
  const precisionNum = Number(entry.network_precision ?? entry.networkPrecision);
  const minAmountNum = Number(entry.min_amount ?? entry.minAmount);
  const usdPriceNum = Number(entry.usd_price ?? entry.usdPrice);
  const priorityNum = Number(entry.priority);

  return {
    id: entry.id ?? null,
    code,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : code.toUpperCase(),
    ticker,
    network,
    enable: true,
    isMerchantEnabled: merchantSet ? merchantSet.has(code) : true,
    fixedRateSupported: fixedRateSet.has(code),
    smartContract: typeof entry.smart_contract === "string" && entry.smart_contract.trim()
      ? entry.smart_contract.trim()
      : null,
    networkPrecision: Number.isInteger(precisionNum) && precisionNum >= 0 && precisionNum <= 18
      ? precisionNum
      : null,
    extraIdExists: Boolean(entry.extra_id_exists ?? entry.extraIdExists),
    extraIdRegex: typeof entry.extra_id_regex === "string" ? entry.extra_id_regex : null,
    walletRegex: typeof entry.wallet_regex === "string" && entry.wallet_regex.trim()
      ? entry.wallet_regex.trim()
      : null,
    minAmount: Number.isFinite(minAmountNum) && minAmountNum > 0 ? minAmountNum : null,
    isMaxLimit: Boolean(entry.is_maxlimit ?? entry.isMaxLimit),
    priority: Number.isFinite(priorityNum) ? priorityNum : null,
    usdPrice: Number.isFinite(usdPriceNum) && usdPriceNum > 0 ? usdPriceNum : null,
  };
}

export function buildCatalogFromProviderData({
  fullCurrencies = null,
  currencies = null,
  merchantCoins = null,
  fixedRateCurrencies = null,
  fetchedAt = Date.now(),
  ttlMs = 300_000,
} = {}) {
  const activeSet = new Set();
  if (Array.isArray(currencies)) {
    for (const item of currencies) {
      const code = normalizePayCurrency(typeof item === "object" ? item?.code || item?.currency : item);
      if (code) activeSet.add(code);
    }
  }

  let merchantSet = null;
  if (Array.isArray(merchantCoins) && merchantCoins.length > 0) {
    merchantSet = new Set();
    for (const item of merchantCoins) {
      const code = normalizePayCurrency(typeof item === "object" ? item?.code || item?.currency : item);
      if (code) merchantSet.add(code);
    }
  }

  const fixedRateSet = new Set();
  if (Array.isArray(fixedRateCurrencies)) {
    for (const item of fixedRateCurrencies) {
      const code = normalizePayCurrency(typeof item === "object" ? item?.code || item?.currency : item);
      if (code) fixedRateSet.add(code);
    }
  }

  const rawEntries = Array.isArray(fullCurrencies) && fullCurrencies.length > 0
    ? fullCurrencies
    : Array.isArray(currencies)
      ? currencies
      : [];

  const assetsByCode = new Map();
  for (const raw of rawEntries) {
    const normalized = normalizeCatalogAsset(raw, { fixedRateSet, merchantSet });
    if (!normalized) continue;
    if (activeSet.size > 0 && !activeSet.has(normalized.code)) continue;
    assetsByCode.set(normalized.code, normalized);
  }

  const sorted = [...assetsByCode.values()].sort((a, b) => {
    if (a.priority != null && b.priority != null && a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.code.localeCompare(b.code);
  });
  // One option per ticker/network pair: aliases of the same pair collapse to
  // the first record, so no duplicate button can ever be rendered.
  const seenPairs = new Set();
  const assets = sorted.filter((asset) => {
    const pair = `${asset.ticker}:${asset.network}`;
    if (seenPairs.has(pair)) return false;
    seenPairs.add(pair);
    return true;
  });

  const groupsMap = new Map();
  for (const asset of assets) {
    const groupKey = asset.ticker;
    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        ticker: groupKey,
        name: asset.name,
        networks: [],
        requiresNetworkSelection: false,
        defaultPayCurrency: asset.code,
      });
    }
    const group = groupsMap.get(groupKey);
    group.networks.push({
      payCurrency: asset.code,
      network: asset.network,
      name: asset.name,
      extraIdExists: asset.extraIdExists,
      networkPrecision: asset.networkPrecision,
      fixedRateSupported: asset.fixedRateSupported,
      minAmount: asset.minAmount,
    });
    group.requiresNetworkSelection = group.networks.length > 1;
  }

  const groups = [...groupsMap.values()]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => preferredRank(a.group.ticker) - preferredRank(b.group.ticker) || a.index - b.index)
    .map(({ group }) => group);

  return {
    assets,
    groups,
    byCode: Object.fromEntries(assets.map((asset) => [asset.code, asset])),
    fetchedAt,
    expiresAt: fetchedAt + ttlMs,
  };
}

function extractCurrencyArray(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.currencies)) return body.currencies;
  if (Array.isArray(body?.selectedCurrencies)) return body.selectedCurrencies;
  if (Array.isArray(body?.fixedRateCurrencies)) return body.fixedRateCurrencies;
  return null;
}

export async function fetchNowPaymentsCatalog({
  env = process.env,
  request: injectedRequest = null,
  client: injectedClient = null,
  forceRefresh = false,
  includeExtendedMetadata = true,
  now = Date.now,
} = {}) {
  const config = readNowPaymentsConfig(env, { allowWithoutCallback: true });
  if (!config) throw new NowPaymentsFlowError("not_configured");

  const currentNow = typeof now === "function" ? now() : Number(now);
  const cacheKey = `${config.baseURL}:${config.apiKey.slice(-6)}:${includeExtendedMetadata ? "full" : "basic"}`;

  if (!forceRefresh) {
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > currentNow && cached.assets.length > 0) {
      return cached;
    }
    if (cached && cached.expiresAt <= currentNow) {
      catalogCache.delete(cacheKey);
    }
  }

  const client = injectedClient || createNowPaymentsClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    email: config.email,
    password: config.password,
    request: injectedRequest,
    now,
  });

  let currencies = null;
  let fullCurrencies = null;
  let merchantCoins = null;
  let fixedRateCurrencies = null;

  const currenciesRes = await client.getCurrencies();
  currencies = extractCurrencyArray(currenciesRes?.data);
  if (!Array.isArray(currencies) || currencies.length === 0) {
    throw new NowPaymentsFlowError("currency_unavailable");
  }

  if (includeExtendedMetadata) {
    const [fullRes, merchantRes, fixedRes] = await Promise.allSettled([
      client.getFullCurrencies(),
      client.getMerchantCoins(),
      client.getCurrencies({ fixedRate: true }),
    ]);

    if (fullRes.status === "fulfilled") {
      const parsed = extractCurrencyArray(fullRes.value?.data);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
        fullCurrencies = parsed;
      }
    }
    // Merchant availability is mandatory: without it the global currency list
    // would offer coins this account cannot actually accept. Fail closed.
    if (merchantRes.status === "fulfilled") {
      const parsed = extractCurrencyArray(merchantRes.value?.data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        merchantCoins = parsed;
      }
    }
    if (!merchantCoins) {
      logQuoteFailure("nowpayments_merchant_coins", merchantRes.status === "rejected"
        ? merchantRes.reason
        : { code: "empty_merchant_coins", status: merchantRes.value?.status, message: "merchant coin list unavailable" });
      throw new NowPaymentsFlowError("currency_unavailable");
    }
    if (fixedRes.status === "fulfilled") {
      const parsed = extractCurrencyArray(fixedRes.value?.data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        fixedRateCurrencies = parsed;
      }
    }
  }

  const catalog = buildCatalogFromProviderData({
    fullCurrencies,
    currencies,
    merchantCoins,
    fixedRateCurrencies,
    fetchedAt: currentNow,
    ttlMs: config.catalogTtlMs,
  });

  if (!catalog.assets.length) {
    throw new NowPaymentsFlowError("currency_unavailable");
  }

  catalogCache.set(cacheKey, catalog);
  return catalog;
}

export function validateCatalogSelection(catalog, { payCurrency, ticker, network } = {}) {
  if (!catalog || !Array.isArray(catalog.assets) || catalog.assets.length === 0) {
    throw new NowPaymentsFlowError("currency_unavailable");
  }
  const currentPassCode = normalizePayCurrency(payCurrency);
  if (currentPassCode) {
    const asset = catalog.byCode?.[currentPassCode]
      || catalog.assets.find((item) => item.code === currentPassCode);
    if (!asset || !asset.enable) {
      throw new NowPaymentsFlowError("currency_unavailable");
    }
    if (network && String(network).trim().toUpperCase() !== asset.network.toUpperCase()) {
      throw new NowPaymentsFlowError("invalid_network_selection");
    }
    if (ticker && String(ticker).trim().toUpperCase() !== asset.ticker.toUpperCase()) {
      throw new NowPaymentsFlowError("invalid_currency_selection");
    }
    return asset;
  }

  if (ticker) {
    const cleanTicker = String(ticker).trim().toUpperCase();
    const matching = catalog.assets.filter((item) => item.ticker === cleanTicker && item.enable);
    if (!matching.length) {
      throw new NowPaymentsFlowError("currency_unavailable");
    }
    if (network) {
      const cleanNet = String(network).trim().toUpperCase();
      const netMatch = matching.find((item) => item.network === cleanNet);
      if (!netMatch) {
        throw new NowPaymentsFlowError("invalid_network_selection");
      }
      return netMatch;
    }
    if (matching.length > 1) {
      throw new NowPaymentsFlowError("network_selection_required");
    }
    return matching[0];
  }

  throw new NowPaymentsFlowError("currency_unavailable");
}
