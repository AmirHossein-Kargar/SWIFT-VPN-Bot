import axios from "axios";

const TIMEOUT_MS = 8_000;

async function getFromCoinMarketCap(apiKey) {
  const response = await axios.get(
    "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest",
    {
      params: { symbol: "TRX", convert: "USD" },
      headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": apiKey },
      timeout: TIMEOUT_MS,
    }
  );
  return Number(response.data?.data?.TRX?.quote?.USD?.price);
}

async function getFromBinance() {
  const response = await axios.get("https://api.binance.com/api/v3/ticker/price", {
    params: { symbol: "TRXUSDT" },
    timeout: TIMEOUT_MS,
  });
  return Number(response.data?.price);
}

/** Return a live USD-per-TRX quote; never substitute a stale hardcoded price. */
export async function TRXPrice() {
  const apiKey = process.env.CMC_API_KEY?.trim();
  if (apiKey) {
    try {
      const price = await getFromCoinMarketCap(apiKey);
      if (Number.isFinite(price) && price > 0) return price;
    } catch { /* use the independent public market quote below */ }
  }

  try {
    const price = await getFromBinance();
    if (Number.isFinite(price) && price > 0) return price;
  } catch { /* surfaced as a generic rate-provider error */ }
  throw new Error("No live TRX/USD quote is available");
}

export default TRXPrice;
