import { normalizePayCurrency } from "./money.js";

/**
 * The ONLY crypto choices a customer can pay with, in display order.
 *
 * This is the single place to edit. Rules:
 *  - at most MAX_PAYMENT_CHOICES entries;
 *  - `payCurrency` is the exact NOWPayments code sent as `pay_currency`
 *    (lowercase). A token on a different network is a different code and a
 *    different entry (usdttrc20 is not usdtbsc);
 *  - an entry is only ever offered when the merchant account also has it
 *    enabled right now (GET /v1/merchant/coins). Listing a code here does not
 *    make it available; it only makes it eligible;
 *  - `network` is the label customers see. The provider does not expose a
 *    network name in /merchant/coins, so this label is ours and must be
 *    checked with `node scripts/verify-nowpayments-allowlist.mjs` against the
 *    live account before a new entry is trusted.
 *
 * NOWPAYMENTS_ENABLED_CURRENCIES (comma separated codes) may only NARROW this
 * list, e.g. to switch off one network without a deploy. It can never add a
 * currency that is not listed below.
 */
export const MAX_PAYMENT_CHOICES = 10;

export const PAYMENT_ALLOWLIST = Object.freeze([
  Object.freeze({ payCurrency: "usdttrc20", ticker: "USDT", network: "TRC20" }),
  Object.freeze({ payCurrency: "usdtbsc", ticker: "USDT", network: "BEP20" }),
  Object.freeze({ payCurrency: "usdtton", ticker: "USDT", network: "TON" }),
  Object.freeze({ payCurrency: "usdtsol", ticker: "USDT", network: "SOL" }),
  Object.freeze({ payCurrency: "usdtmatic", ticker: "USDT", network: "POLYGON" }),
  Object.freeze({ payCurrency: "trx", ticker: "TRX", network: "TRX" }),
  Object.freeze({ payCurrency: "ton", ticker: "TON", network: "TON" }),
  Object.freeze({ payCurrency: "ltc", ticker: "LTC", network: "LTC" }),
  Object.freeze({ payCurrency: "btc", ticker: "BTC", network: "BTC" }),
  Object.freeze({ payCurrency: "bnbbsc", ticker: "BNB", network: "BEP20" }),
]);

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_PAYMENT_CHOICES) return false;
  const codes = new Set();
  const pairs = new Set();
  for (const entry of entries) {
    const code = normalizePayCurrency(entry?.payCurrency);
    if (!code || code !== entry.payCurrency) return false;
    if (!/^[A-Z0-9]{2,10}$/.test(entry.ticker || "") || !/^[A-Z0-9]{2,12}$/.test(entry.network || "")) return false;
    const pair = `${entry.ticker}:${entry.network}`;
    if (codes.has(code) || pairs.has(pair)) return false;
    codes.add(code);
    pairs.add(pair);
  }
  return true;
}

/**
 * The effective allowlist. Returns [] (never "everything") when the list or the
 * narrowing variable is unusable, so callers fail closed.
 */
export function resolvePaymentAllowlist(env = process.env, entries = PAYMENT_ALLOWLIST) {
  if (!validateEntries(entries)) return [];
  const raw = String(env?.NOWPAYMENTS_ENABLED_CURRENCIES ?? "").trim();
  if (!raw) return [...entries];
  const wanted = new Set(raw.split(",").map((item) => normalizePayCurrency(item)).filter(Boolean));
  return entries.filter((entry) => wanted.has(entry.payCurrency));
}

export function allowlistEntryFor(payCurrency, env = process.env, entries = PAYMENT_ALLOWLIST) {
  const code = normalizePayCurrency(payCurrency);
  if (!code) return null;
  return resolvePaymentAllowlist(env, entries).find((entry) => entry.payCurrency === code) || null;
}
