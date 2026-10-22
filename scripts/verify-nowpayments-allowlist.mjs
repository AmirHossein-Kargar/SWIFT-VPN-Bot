#!/usr/bin/env node
/**
 * Read-only check of the customer payment allowlist against the REAL merchant account.
 *
 *   NOWPAYMENTS_API_KEY=... node scripts/verify-nowpayments-allowlist.mjs
 *
 * Only GET requests are made (status, currencies, merchant/coins, full-currencies, min-amount, estimate).
 * Nothing is created, paid or changed, and the API key is never printed. For every allowlisted entry it reports whether
 * the account really accepts it right now and which provider-side network label and minimum the API exposes.
 * "network (provider)" is informational: /merchant/coins carries no network field, so the label shown to customers
 * is ours and must be compared with the provider value by a human.
 */
import { PAYMENT_ALLOWLIST, resolvePaymentAllowlist } from "../services/nowpayments/allowlist.js";
import { readNowPaymentsConfig } from "../services/nowpayments/money.js";
import { createNowPaymentsClient } from "../services/nowpayments/nowpaymentsClient.js";
import { parseMinAmount } from "../services/nowpayments/minAmount.js";

const config = readNowPaymentsConfig(process.env, { allowWithoutCallback: true });
if (!config) {
  console.error("NOWPAYMENTS_API_KEY is not set; nothing to verify.");
  process.exit(2);
}
const client = createNowPaymentsClient({ apiKey: config.apiKey, baseURL: config.baseURL });
const list = (body) => (Array.isArray(body) ? body : body?.currencies || body?.selectedCurrencies || []);
const code = (item) => String(typeof item === "object" ? item?.code || item?.currency : item || "").trim().toLowerCase();
const settled = async (promise) => { try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error: `${error?.code || error?.name || "error"}${error?.status ? ` HTTP ${error.status}` : ""}` }; } };

const [status, active, merchant, full] = await Promise.all([
  settled(client.getStatus()),
  settled(client.getCurrencies()),
  settled(client.getMerchantCoins()),
  settled(client.getFullCurrencies()),
]);
console.log(`API status: ${status.ok ? JSON.stringify(status.value.data) : status.error}`);
if (!merchant.ok) {
  console.error(`/merchant/coins failed (${merchant.error}); the bot would fail closed and offer NO crypto option.`);
  process.exit(1);
}
const activeSet = new Set(active.ok ? list(active.value.data).map(code) : []);
const merchantSet = new Set(list(merchant.value.data).map(code));
const fullByCode = new Map((full.ok ? list(full.value.data) : []).filter((x) => x && typeof x === "object").map((x) => [code(x), x]));

console.log(`allowlist has ${PAYMENT_ALLOWLIST.length} entries; ${resolvePaymentAllowlist().length} after NOWPAYMENTS_ENABLED_CURRENCIES\n`);
const rows = [];
for (const entry of resolvePaymentAllowlist()) {
  const meta = fullByCode.get(entry.payCurrency);
  const enabled = merchantSet.has(entry.payCurrency);
  const ask = (currencyTo) => settled(client.getMinAmount({ currencyFrom: entry.payCurrency, currencyTo, fiatEquivalent: config.priceCurrency, isFixedRate: config.isFixedRate, isFeePaidByUser: config.isFeePaidByUser }));
  // Same query the bot sends, plus the variants that could disagree with it.
  const min = enabled ? await ask(config.minAmountCurrencyTo || entry.payCurrency) : null;
  const omitted = enabled ? await ask(undefined) : null;
  const parsed = min?.ok ? parseMinAmount(min.value.data, entry.payCurrency) : null;
  const parsedOmitted = omitted?.ok ? parseMinAmount(omitted.value.data, entry.payCurrency) : null;
  const differs = parsed && parsedOmitted && Math.abs(parsed.minFiatEquivalent - parsedOmitted.minFiatEquivalent) > 0.01 * parsed.minFiatEquivalent;
  rows.push({
    code: entry.payCurrency,
    shown: `${entry.ticker}/${entry.network}`,
    "in /currencies": active.ok ? activeSet.has(entry.payCurrency) : "unknown",
    "in /merchant/coins": merchantSet.has(entry.payCurrency),
    "provider ticker": meta?.ticker ?? "n/a",
    "network (provider)": meta?.network ?? "n/a",
    "min (crypto)": parsed?.minCryptoAmount ?? (min ? `err ${min.ok ? "unparsed" : min.error}` : "n/a"),
    [`min (${config.priceCurrency})`]: parsed?.minFiatEquivalent ?? "n/a",
    "to (provider)": parsed?.currencyTo ?? "n/a",
    [`min no currency_to`]: parsedOmitted ? parsedOmitted.minFiatEquivalent : omitted ? `err ${omitted.ok ? "unparsed" : omitted.error}` : "n/a",
    "pair differs": differs ? "YES: set NOWPAYMENTS_MIN_AMOUNT_CURRENCY_TO" : "no",
    offered: merchantSet.has(entry.payCurrency) && (!active.ok || activeSet.has(entry.payCurrency)),
  });
}
console.table(rows);
const dropped = rows.filter((row) => !row.offered).map((row) => row.code);
console.log(dropped.length ? `NOT offered to customers right now: ${dropped.join(", ")}` : "Every allowlisted entry is offered.");
