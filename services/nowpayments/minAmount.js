import { NowPaymentsFlowError } from "./money.js";
import { buildQueryPath } from "./nowpaymentsClient.js";
import { logQuoteFailure } from "../pricing/quoteLog.js";

/**
 * Minimum payment for one pay currency, from GET /v1/min-amount.
 *
 * The official reference documents a PAIR: `currency_from` is the payin currency and
 * `currency_to` the outcome currency. It does not document `currency_to` as optional
 * (only an older third-party OpenAPI mirror does), so it is always sent: the
 * configured outcome currency (NOWPAYMENTS_MIN_AMOUNT_CURRENCY_TO) for accounts that
 * auto-convert, otherwise the pay currency itself (the default same-coin payout).
 * `fiat_equivalent` is the documented way to get the same minimum in the invoice's
 * price currency, which is what the customer's Toman amount is converted to.
 * `is_fixed_rate` / `is_fee_paid_by_user` must mirror the invoice flags because the
 * documentation says minimums can differ per flow.
 */
export function parseMinAmount(body, expectedPayCurrency) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const currencyFrom = String(body.currency_from || "").trim().toLowerCase();
  if (expectedPayCurrency && currencyFrom && currencyFrom !== expectedPayCurrency) return null;
  const minAmount = Number(body.min_amount);
  if (!Number.isFinite(minAmount) || minAmount <= 0) return null;
  const fiatEquivalent = body.fiat_equivalent != null && body.fiat_equivalent !== "" ? Number(body.fiat_equivalent) : null;
  const currencyTo = String(body.currency_to || "").trim().toLowerCase() || null;
  return {
    currencyTo,
    minCryptoAmount: Number(minAmount.toFixed(8)),
    minFiatEquivalent: Number.isFinite(fiatEquivalent) && fiatEquivalent > 0
      ? Number(fiatEquivalent.toFixed(8))
      : null,
  };
}

/** Never throws anything but a NowPaymentsFlowError with a distinguishable code. */
export async function requestMinAmount({ call, config, payCurrency }) {
  const currencyTo = config.minAmountCurrencyTo || payCurrency;
  let response;
  try {
    response = await call({
      method: "GET",
      path: buildQueryPath("/min-amount", {
        currency_from: payCurrency,
        currency_to: currencyTo,
        fiat_equivalent: config.priceCurrency,
        is_fixed_rate: config.isFixedRate,
        is_fee_paid_by_user: config.isFeePaidByUser,
      }),
    });
  } catch (error) {
    logQuoteFailure("nowpayments_min_amount", error, { payCurrency });
    throw new NowPaymentsFlowError("min_amount_unavailable");
  }
  if (!response || response.status !== 200) {
    logQuoteFailure("nowpayments_min_amount", {
      code: "http_error",
      status: response?.status,
      providerCode: response?.providerCode,
      message: response?.providerMessage,
    }, { payCurrency });
    throw new NowPaymentsFlowError("min_amount_unavailable");
  }
  const parsed = parseMinAmount(response.data, payCurrency);
  // A minimum for a different outcome pair than the one asked for must not be used.
  if (parsed && parsed.currencyTo && parsed.currencyTo !== currencyTo) {
    logQuoteFailure("nowpayments_min_amount_parse", {
      code: "pair_mismatch",
      status: 200,
      message: "min-amount response is for another outcome currency",
    }, { payCurrency, requested: currencyTo, returned: parsed.currencyTo });
    throw new NowPaymentsFlowError("min_amount_unavailable");
  }
  if (!parsed) {
    logQuoteFailure("nowpayments_min_amount_parse", {
      code: "malformed_min_amount",
      status: 200,
      message: "min-amount response was not usable",
    }, { payCurrency });
    throw new NowPaymentsFlowError("min_amount_unavailable");
  }
  return parsed;
}

/**
 * Smallest invoice price, in cents, that is >= the provider's fiat minimum, plus an
 * optional operator-chosen safety margin (percent) for rate movement.
 */
export function minimumPriceCents(minFiatEquivalent, marginPercent = 0) {
  const fiat = Number(minFiatEquivalent);
  const margin = Number(marginPercent) || 0;
  if (!Number.isFinite(fiat) || fiat <= 0 || !Number.isFinite(margin) || margin < 0) return null;
  // toFixed(6) first: 3.13 * 100 is 313.00000000000006 and must not become 314.
  const cents = Math.ceil(Number((fiat * 100 * (1 + margin / 100)).toFixed(6)));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Smallest Toman amount whose conversion reaches `minPriceCents` at this rate. */
export function minimumTomanForCents(minPriceCents, tomanPerFiat) {
  if (!Number.isSafeInteger(minPriceCents) || minPriceCents <= 0) return null;
  if (!Number.isFinite(tomanPerFiat) || tomanPerFiat <= 0) return null;
  let toman = Math.ceil((minPriceCents * tomanPerFiat) / 100);
  // Guard against float drift: tomanToFiatCents rounds, so confirm and nudge.
  while (Math.round((toman * 100) / tomanPerFiat) < minPriceCents) toman += 1;
  return Number.isSafeInteger(toman) ? toman : null;
}

/**
 * Throws `below_min_amount` (carrying `minToman`) when the invoice price is under
 * the provider minimum, and `min_amount_unavailable` when there is nothing to
 * compare against. Equal to the minimum is accepted.
 */
export function assertMeetsMinimum({ priceAmountCents, minInfo, tomanPerFiat, marginPercent = 0 }) {
  const minCents = minimumPriceCents(minInfo?.minFiatEquivalent, marginPercent);
  if (minCents == null) throw new NowPaymentsFlowError("min_amount_unavailable");
  if (priceAmountCents < minCents) {
    const error = new NowPaymentsFlowError("below_min_amount");
    error.minToman = minimumTomanForCents(minCents, tomanPerFiat);
    error.minPriceCents = minCents;
    throw error;
  }
  return minCents;
}
