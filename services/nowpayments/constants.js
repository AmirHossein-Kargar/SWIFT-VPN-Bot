/**
 * NOWPayments identifiers verified from the official docs, not guessed.
 *
 * Native TRON is listed as TRX on https://nowpayments.io/supported-coins
 * and as the lowercase ticker "trx" in the API and IPN examples:
 * https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description
 * https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup
 *
 * USDT on TRON is a different asset (`usdttrc20`) and is not this payment method.
 * The invoice API authenticates with `x-api-key` only. The public key is not
 * accepted as a substitute.
 */
export const TRON_PAY_CURRENCY = "trx";
export const DEFAULT_PRICE_CURRENCY = "usd";
export const SUPPORTED_PRICE_CURRENCIES = Object.freeze(["usd", "eur"]);
export const SUCCESS_PAYMENT_STATUS = "finished";
export const KNOWN_PAYMENT_STATUSES = Object.freeze([
  "waiting",
  "pending",
  "confirming",
  "confirmed",
  "sending",
  "partially_paid",
  "finished",
  "failed",
  "expired",
  "refunded",
]);
export const NON_CREDIT_STATUSES = Object.freeze(
  KNOWN_PAYMENT_STATUSES.filter((status) => status !== SUCCESS_PAYMENT_STATUS),
);
