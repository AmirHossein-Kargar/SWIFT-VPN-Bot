import { NowPaymentsFlowError } from "./money.js";
import { getUsdtTomanQuote } from "../pricing/gheymatClient.js";

/**
 * Toman per 1 USD for a NOWPayments USD invoice.
 * The rate is the live Gheymat USDT/IRT buy price. That API labels IRT as
 * toman, so the value is not divided by 10. There is no static fallback.
 */
export async function resolveTomanPerFiat({ priceCurrency = "usd", env = process.env, transport, now } = {}) {
  if (priceCurrency !== "usd") throw new NowPaymentsFlowError("rate_unavailable");
  try {
    const quote = await getUsdtTomanQuote({ env, transport, now });
    if (!Number.isFinite(quote?.tomanPerUsdt) || quote.tomanPerUsdt <= 0) throw new NowPaymentsFlowError("invalid_rate");
    return { tomanPerFiat: quote.tomanPerUsdt, source: "gheymat", quoteAt: quote.createdAt };
  } catch (error) {
    if (error instanceof NowPaymentsFlowError) throw error;
    throw new NowPaymentsFlowError("rate_unavailable");
  }
}
