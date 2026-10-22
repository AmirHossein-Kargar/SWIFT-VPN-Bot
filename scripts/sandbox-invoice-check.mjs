#!/usr/bin/env node
/**
 * Owner-run check of the hosted invoice page in the OFFICIAL NOWPayments SANDBOX. It cannot be run by CI or
 * against production: the base URL is fixed to the sandbox host and the production key is refused.
 *
 *   1. Create a sandbox account at https://account-sandbox.nowpayments.io and enable the coin under test.
 *   2. NOWPAYMENTS_SANDBOX_API_KEY=<sandbox key> node scripts/sandbox-invoice-check.mjs [pay_currency] [usd|eur]
 *   3. Open BOTH printed URLs in a browser and record whether each page renders (the page is a JavaScript app, so an HTTP
 *      200 below only proves the URL answers, not that the page renders).
 *
 * It creates exactly two SANDBOX invoices (no IPN URL, no funds): one at half the provider minimum and one at three
 * times it, using the same /min-amount query and invoice fields as the bot. The key is never printed.
 */
import axios from "axios";
import { buildQueryPath } from "../services/nowpayments/nowpaymentsClient.js";
import { buildInvoiceRequest, invoiceUrlIsUsable } from "../services/nowpayments/money.js";
import { parseMinAmount, minimumPriceCents } from "../services/nowpayments/minAmount.js";

const SANDBOX = "https://api-sandbox.nowpayments.io/v1";
const key = process.env.NOWPAYMENTS_SANDBOX_API_KEY?.trim();
const payCurrency = (process.argv[2] || "trx").toLowerCase();
const priceCurrency = (process.argv[3] || "usd").toLowerCase();
if (!key) { console.error("NOWPAYMENTS_SANDBOX_API_KEY is not set."); process.exit(2); }
if (key === process.env.NOWPAYMENTS_API_KEY?.trim()) { console.error("Refusing: that is the production API key."); process.exit(2); }
if (!/^[a-z0-9]{2,24}$/.test(payCurrency) || !["usd", "eur"].includes(priceCurrency)) { console.error("Unsupported currency argument."); process.exit(2); }

const http = (config) => axios.request({ baseURL: SANDBOX, headers: { "x-api-key": key, Accept: "application/json" }, timeout: 15_000, validateStatus: () => true, ...config });

const minRes = await http({
  method: "GET",
  url: buildQueryPath("/min-amount", { currency_from: payCurrency, currency_to: payCurrency, fiat_equivalent: priceCurrency, is_fixed_rate: false, is_fee_paid_by_user: false }),
});
const min = minRes.status === 200 ? parseMinAmount(minRes.data, payCurrency) : null;
if (!min?.minFiatEquivalent) { console.error(`/min-amount unusable (HTTP ${minRes.status}); stopping.`); process.exit(1); }
console.log(`provider minimum for ${payCurrency}: ${min.minCryptoAmount} (= ${min.minFiatEquivalent} ${priceCurrency})`);

const minCents = minimumPriceCents(min.minFiatEquivalent);
const cases = [
  ["BELOW minimum", Math.max(1, Math.floor(minCents / 2))],
  ["ABOVE minimum", minCents * 3],
];
for (const [label, cents] of cases) {
  const orderId = `SANDBOX-${label.split(" ")[0]}-${Date.now()}`;
  const body = buildInvoiceRequest({
    orderId, priceAmountCents: cents, priceCurrency, payCurrency, ipnCallbackUrl: "https://example.invalid/not-used",
    description: "sandbox hosted-page check", isFixedRate: false, isFeePaidByUser: false,
  });
  delete body.ipn_callback_url;
  const res = await http({ method: "POST", url: "/invoice", data: body });
  const url = res.data?.invoice_url;
  console.log(`\n${label}: price ${cents / 100} ${priceCurrency} -> HTTP ${res.status}, id ${res.data?.id ?? "n/a"}, usable URL: ${invoiceUrlIsUsable(url)}`);
  if (typeof url === "string") {
    console.log(`  open in a browser: ${url}`);
    const page = await axios.get(url, { timeout: 15_000, validateStatus: () => true, responseType: "text" }).catch((e) => ({ status: `error ${e.code || ""}`, data: "", headers: {} }));
    console.log(`  GET -> ${page.status}, ${String(page.headers?.["content-type"] || "").split(";")[0]}, ${String(page.data).length} bytes (a JS app: rendering must be checked in the browser)`);
  } else {
    console.log(`  no invoice_url; provider said: ${String(res.data?.message || res.data?.code || "").slice(0, 160)}`);
  }
}
console.log("\nRecord for each page: renders / blank / error banner, plus any console error. Sandbox invoices need no clean-up.");
