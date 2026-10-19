/**
 * Display-only emoji for the preferred tickers. Availability always comes from
 * the merchant's NOWPayments catalog; every other ticker gets a neutral icon
 * and is shown by its ticker alone, never with an invented name.
 */
const TICKER_EMOJI = Object.freeze({
  USDT: "🟢",
  TON: "💎",
  TRX: "🔴",
  BTC: "🟡",
  LTC: "🟣",
  ETH: "🔷",
});

export const CURRENCY_PAGE_SIZE = 8;

/** Button label: "🟢 USDT". Each asset appears once; networks come on the next step. */
export function currencyGroupLabel(group) {
  const ticker = String(group.ticker).toUpperCase();
  return `${TICKER_EMOJI[ticker] || "🪙"} ${ticker}`;
}

export function networkLabel(ticker, network) {
  return `🌐 شبکه ${String(network).toUpperCase()}`;
}

/** One page of currency groups, with a clamped page index. */
export function paginateGroups(groups, page, pageSize = CURRENCY_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const current = Number.isInteger(page) ? Math.min(Math.max(page, 0), pages - 1) : 0;
  return {
    page: current,
    pages,
    items: groups.slice(current * pageSize, (current + 1) * pageSize),
  };
}
