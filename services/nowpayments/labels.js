/**
 * Display-only Persian names for well-known tickers. Availability always comes
 * from the live NOWPayments catalog; a ticker missing here is shown by its
 * ticker alone, never with an invented name.
 */
const PERSIAN_NAMES = Object.freeze({
  BTC: "بیت‌کوین",
  ETH: "اتریوم",
  LTC: "لایت‌کوین",
  TRX: "ترون",
  USDT: "تتر",
  USDC: "یو‌اس‌دی‌کوین",
  TON: "تون‌کوین",
  SOL: "سولانا",
  DOGE: "دوج‌کوین",
  BNB: "بایننس‌کوین",
  XRP: "ریپل",
  BCH: "بیت‌کوین کش",
  DASH: "دش",
  XMR: "مونرو",
  ADA: "کاردانو",
  MATIC: "پالیگان",
  DAI: "دای",
});

export const CURRENCY_PAGE_SIZE = 8;

export function persianCurrencyName(ticker) {
  return PERSIAN_NAMES[String(ticker || "").toUpperCase()] || null;
}

/** Button label: "🪙 بیت‌کوین · BTC" or "🪙 تتر · USDT (3 شبکه)". */
export function currencyGroupLabel(group) {
  const ticker = String(group.ticker).toUpperCase();
  const name = persianCurrencyName(ticker);
  const base = name ? `${name} · ${ticker}` : ticker;
  const suffix = group.requiresNetworkSelection
    ? ` (${group.networks.length} شبکه)`
    : "";
  return `🪙 ${base}${suffix}`;
}

export function networkLabel(ticker, network) {
  return `🌐 ${String(ticker).toUpperCase()} · شبکه ${String(network).toUpperCase()}`;
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
