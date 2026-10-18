import axios from "axios";

/**
 * Gheymat price client.
 *
 * Documented query:
 * GET https://backend.gheymat.online/api/prices?base_currency=USDT&quote_currency=IRT&price_source=GHEYMAT
 *
 * The live Currency schema and the USDT-IRT response label quote symbol IRT as
 * "Toman" / «تومان». buy_price is therefore toman per 1 USDT, not rials.
 * A rial-labeled quote is converted with 1 toman = 10 rials. A toman-labeled
 * quote is never divided by 10.
 *
 * TRX is not in the documented Currency enum, so this client does not invent a
 * TRX query.
 */
export class GheymatQuoteError extends Error {
  constructor(code) {
    super(code);
    this.name = "GheymatQuoteError";
    this.code = code;
  }
}

const cache = { quote: null, expiresAt: 0, pending: null };

function positivePrice(value) {
  const number = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

export function gheymatCacheTtlMs(env = process.env) {
  const raw = env.GHEYMAT_CACHE_TTL_SECONDS?.trim();
  const seconds = raw ? Number(raw) : 600;
  if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600) return 600_000;
  return seconds * 1000;
}

export function gheymatMaxAgeMs(env = process.env) {
  const raw = env.GHEYMAT_MAX_QUOTE_AGE_SECONDS?.trim();
  const seconds = raw ? Number(raw) : 900;
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 3600) return 900_000;
  return seconds * 1000;
}

function quoteUnit(row) {
  if (row?.quote_currency?.symbol !== "IRT" || row?.base_currency?.symbol !== "USDT" || row?.symbol !== "USDT-IRT") {
    throw new GheymatQuoteError("unit_mismatch");
  }
  const english = String(row.quote_currency?.en || "").trim().toLowerCase();
  const persian = String(row.quote_currency?.fa || "");
  if (english === "toman" || persian.includes("تومان")) return { divisor: 1, unit: "toman" };
  if (english === "rial" || english === "irr" || persian.includes("ریال")) return { divisor: 10, unit: "rial" };
  throw new GheymatQuoteError("unit_mismatch");
}

export function parseGheymatUsdtIrt(body, { now = new Date(), maxAgeMs = 900_000 } = {}) {
  const rows = Array.isArray(body?.data) ? body.data : null;
  if (!rows || rows.length === 0) throw new GheymatQuoteError("stale");
  const row = rows.find((item) => item?.symbol === "USDT-IRT" && item?.price_source?.symbol === "GHEYMAT");
  if (!row) throw new GheymatQuoteError("malformed");
  if (row.is_up_to_date !== true) throw new GheymatQuoteError("stale");
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt)) throw new GheymatQuoteError("stale");
  const nowMs = now.getTime();
  if (createdAt > nowMs + 5 * 60_000 || nowMs - createdAt > maxAgeMs) throw new GheymatQuoteError("stale");

  const unit = quoteUnit(row);
  const buy = positivePrice(row.buy_price);
  const sell = positivePrice(row.sell_price);
  if (buy == null || sell == null) throw new GheymatQuoteError("malformed");
  const tomanBuy = buy / unit.divisor;
  const tomanSell = sell / unit.divisor;
  if (tomanBuy < 1_000 || tomanBuy > 100_000_000 || tomanSell < 1_000 || tomanSell > 100_000_000) {
    throw new GheymatQuoteError("malformed");
  }
  if (Math.max(tomanBuy, tomanSell) / Math.min(tomanBuy, tomanSell) > 1.2) {
    throw new GheymatQuoteError("inconsistent");
  }
  return {
    symbol: "USDT-IRT",
    unit: unit.unit,
    tomanPerUsdt: tomanBuy,
    buyPriceToman: tomanBuy,
    sellPriceToman: tomanSell,
    createdAt: new Date(createdAt).toISOString(),
    source: "gheymat",
  };
}

function httpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new GheymatQuoteError("not_configured");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new GheymatQuoteError("not_configured");
  }
  return parsed.origin;
}

async function requestOnce(transport, options) {
  try {
    return await transport(options);
  } catch (error) {
    const wrapped = new GheymatQuoteError("unavailable");
    if (Number.isInteger(error?.response?.status)) wrapped.status = error.response.status;
    wrapped.message = error?.code === "ECONNABORTED" ? "timeout" : (error?.code || "connection_failed");
    throw wrapped;
  }
}

export async function fetchUsdtTomanQuote({
  transport = axios.request,
  env = process.env,
  now = new Date(),
  maxAgeMs = gheymatMaxAgeMs(env),
} = {}) {
  const origin = httpsOrigin(env.GHEYMAT_API_BASE_URL?.trim() || "https://backend.gheymat.online");
  const headers = { Accept: "application/json" };
  const token = env.GHEYMAT_API_TOKEN?.trim();
  if (token) headers["x-api-token"] = token;
  const url = `${origin}/api/prices?base_currency=USDT&quote_currency=IRT&price_source=GHEYMAT&only_updated=1`;
  let response = await requestOnce(transport, { method: "GET", url, headers, timeout: 8_000 });
  if (response?.status >= 500 || response?.status === 429) {
    response = await requestOnce(transport, { method: "GET", url, headers, timeout: 8_000 });
  }
  if (!response || response.status !== 200) {
    const error = new GheymatQuoteError("unavailable");
    if (Number.isInteger(response?.status)) error.status = response.status;
    const providerCode = response?.data?.code ?? response?.data?.error;
    if (providerCode != null) error.providerCode = String(providerCode).slice(0, 80);
    throw error;
  }
  return parseGheymatUsdtIrt(response.data, { now, maxAgeMs });
}

export async function getUsdtTomanQuote(options = {}) {
  const nowMs = (options.now || new Date()).getTime();
  if (!options.force && cache.quote && cache.expiresAt > nowMs) return cache.quote;
  if (cache.pending) return cache.pending;
  cache.pending = fetchUsdtTomanQuote(options).then((quote) => {
    cache.quote = quote;
    cache.expiresAt = Date.now() + gheymatCacheTtlMs(options.env);
    return quote;
  }).finally(() => {
    cache.pending = null;
  });
  return cache.pending;
}

export function resetGheymatCacheForTests() {
  cache.quote = null;
  cache.expiresAt = 0;
  cache.pending = null;
}
