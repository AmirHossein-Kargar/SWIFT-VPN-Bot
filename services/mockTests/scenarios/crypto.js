/**
 * Scenario B — cryptocurrency wallet top-up through the real NOWPayments code:
 * catalog normalisation and asset/network selection, hosted-invoice creation,
 * IPN signature verification, the IPN state machine and idempotent crediting.
 *
 * No blockchain transfer happens: provider responses and IPNs are synthesised
 * and signed with a per-run random secret.
 */
import { buildCatalogFromProviderData, validateCatalogSelection } from "../../nowpayments/catalog.js";
import { createNowPaymentsTopUp } from "../../nowpayments/createInvoice.js";
import { applyNowPaymentsUpdate } from "../../nowpayments/applyStatus.js";
import { signNowPaymentsIpn, verifyNowPaymentsSignature } from "../../nowpayments/signature.js";
import { NowPaymentsFlowError } from "../../nowpayments/money.js";
import { createMockDataset } from "../memoryStore.js";
import {
  MOCK_BASE_URL,
  MOCK_NOWPAYMENTS_CURRENCIES,
  createFakeNowPayments,
  mockNowPaymentsEnv,
  mockSecret,
  mockUserId,
  nowPaymentsIpn,
} from "../fakes.js";

const MOCK_RATE = Object.freeze({ tomanPerFiat: 100_000, source: "mock-fixed-rate" });
const flowError = (code) => (error) => error instanceof NowPaymentsFlowError && error.code === code;

export const cryptoScenario = Object.freeze({
  id: "crypto",
  title: "Cryptocurrency wallet top-up",
  titleFa: "شارژ کیف پول با ارز دیجیتال",
  async run(t) {
    const secret = mockSecret();
    const env = mockNowPaymentsEnv(secret);
    const resolveRate = async () => ({ ...MOCK_RATE, quoteAt: Date.now() });

    // ── Asset and network selection via the real catalog builder
    const catalog = buildCatalogFromProviderData({
      fullCurrencies: MOCK_NOWPAYMENTS_CURRENCIES,
      merchantCoins: MOCK_NOWPAYMENTS_CURRENCIES.map((entry) => entry.code),
    });
    const usdt = catalog.groups.find((group) => group.ticker === "USDT");
    t.check("multi-network asset requires a network choice", usdt?.requiresNetworkSelection === true && usdt.networks.length === 2);
    t.check("single-network asset needs no network choice", catalog.groups.find((group) => group.ticker === "TRX")?.requiresNetworkSelection === false);
    const asset = validateCatalogSelection(catalog, { payCurrency: "usdttrc20" });
    t.check("selected asset keeps its ticker and network", asset?.ticker === "USDT" && asset?.code === "usdttrc20" && Boolean(asset?.network));
    await t.rejects("unknown asset is refused", async () => validateCatalogSelection(catalog, { payCurrency: "dogemock" }), flowError("currency_unavailable"));
    await t.rejects("asset on the wrong network is refused",
      async () => validateCatalogSelection(catalog, { payCurrency: "usdttrc20", network: "ETH" }), flowError("invalid_network_selection"));

    // ── Invoice creation (pending; nothing credited)
    const ds = createMockDataset();
    const provider = createFakeNowPayments();
    const create = (userId, amountToman, overrides = {}) => createNowPaymentsTopUp({
      userId,
      amountToman,
      payCurrency: asset.code,
      ticker: asset.ticker,
      network: asset.network,
      env,
      invoiceModel: ds.nowpayments,
      request: provider.request,
      catalog,
      resolveRate,
      ...overrides,
    });

    for (const amount of [0, -5, 1.5, "250000", Number.MAX_SAFE_INTEGER + 1]) {
      await t.rejects(`invalid amount ${String(amount)} is refused`, () => create(mockUserId(20), amount), flowError("invalid_amount"));
    }
    await t.rejects("invalid user ID is refused", () => create("not-a-user", 250_000), flowError("invalid_user"));
    t.equal("invalid input never reaches the provider", provider.invoiceCalls(), 0);

    const payer = mockUserId(21);
    await ds.users.create({ telegramId: payer, balance: 0 });
    const amountToman = 250_000;
    const [first, second] = await Promise.allSettled([create(payer, amountToman), create(payer, amountToman)]);
    t.check("a duplicate in-flight request for the same user is refused",
      [first, second].filter((entry) => entry.status === "fulfilled").length === 1
      && [first, second].some((entry) => entry.status === "rejected" && entry.reason?.code === "in_flight"));
    const created = first.status === "fulfilled" ? first.value : second.value;
    t.check("order ID uses the production NP- format", /^NP-[0-9a-f-]{36}$/i.test(created?.orderId || ""));
    const invoice = ds.nowpayments.peek({ orderId: created?.orderId });
    t.equal("invoice is pending after creation", invoice?.status, "pending");
    t.equal("Toman amount is stored exactly as entered", invoice?.amountToman, amountToman);
    t.equal("USD amount = Toman / rate (no ÷10)", invoice?.priceAmountCents, Math.round((amountToman * 100) / MOCK_RATE.tomanPerFiat));
    t.check("asset, ticker and network are preserved",
      invoice?.payCurrency === asset.code && invoice?.ticker === asset.ticker && invoice?.network === asset.network);
    t.check("provider invoice ID is stored", typeof invoice?.invoiceId === "string" && invoice.invoiceId.startsWith("MOCKINV"));
    const sent = provider.calls.find((call) => call.path === "/invoice")?.data;
    t.check("provider request carries the IPN callback and order ID",
      sent?.ipn_callback_url === `${MOCK_BASE_URL}/api/nowpayments/ipn` && sent?.order_id === created?.orderId && sent?.pay_currency === asset.code);
    t.equal("creating an invoice never credits the wallet", ds.users.peek({ telegramId: payer }).balance, 0);

    // ── Provider failures on creation
    const failing = createFakeNowPayments({ invoiceOutcomes: ["http500", "http400", "throw"] });
    const failUsers = [mockUserId(22), mockUserId(23), mockUserId(24)];
    const outcomes = [];
    for (const user of failUsers) {
      outcomes.push(await create(user, amountToman, { request: failing.request }).then(() => null, (error) => error));
    }
    t.check("provider 5xx is treated as ambiguous", outcomes[0]?.code === "ambiguous");
    t.check("provider 4xx is a definitive rejection", outcomes[1]?.code === "provider_rejected");
    t.check("transport timeout is treated as ambiguous", outcomes[2]?.code === "ambiguous");
    t.equal("5xx leaves the order recoverable (creation_unknown)", ds.nowpayments.peek({ userId: Number(failUsers[0]) })?.status, "creation_unknown");
    t.equal("4xx closes the order (creation_failed)", ds.nowpayments.peek({ userId: Number(failUsers[1]) })?.status, "creation_failed");
    t.equal("no provider request is retried automatically", failing.invoiceCalls(), 3);

    // ── IPN signature
    const paymentId = "5077125051";
    const finished = nowPaymentsIpn(invoice, { status: "finished", paymentId });
    const signature = signNowPaymentsIpn(finished, secret);
    t.check("valid IPN signature verifies", verifyNowPaymentsSignature(finished, signature, secret));
    t.check("tampered IPN amount fails verification", !verifyNowPaymentsSignature({ ...finished, price_amount: 9999 }, signature, secret));
    t.check("IPN signed with another secret fails verification", !verifyNowPaymentsSignature(finished, signNowPaymentsIpn(finished, mockSecret()), secret));
    t.check("missing signature fails verification", !verifyNowPaymentsSignature(finished, "", secret) && !verifyNowPaymentsSignature(finished, signature, ""));

    // ── IPN state machine: pending states never credit; finished credits once
    const apply = (payload) => applyNowPaymentsUpdate({ payload, invoiceModel: ds.nowpayments, userModel: ds.users });
    const waiting = await apply(nowPaymentsIpn(invoice, { status: "waiting", paymentId }));
    t.check("waiting IPN does not credit", waiting.credited === false);
    await apply(nowPaymentsIpn(invoice, { status: "confirming", paymentId }));
    t.equal("confirming IPN advances the status", ds.nowpayments.peek({ orderId: invoice.orderId })?.status, "confirming");
    t.equal("no credit before the payment is finished", ds.users.peek({ telegramId: payer }).balance, 0);

    const credit = await apply(finished);
    t.check("finished IPN credits the wallet", credit.outcome === "finished" && credit.credited === true);
    t.equal("credited amount is the confirmed Toman amount", ds.users.peek({ telegramId: payer }).balance, amountToman);
    const duplicate = await apply(finished);
    t.check("duplicate finished IPN is acknowledged without credit", duplicate.credited === false && duplicate.alreadyCredited === true);
    const storm = await Promise.all(Array.from({ length: 5 }, () => apply(finished)));
    t.check("5 concurrent duplicate IPNs never credit", storm.every((entry) => entry.credited === false));
    t.equal("balance credited exactly once", ds.users.peek({ telegramId: payer }).balance, amountToman);
    t.equal("one idempotency key for the order", ds.users.peek({ telegramId: payer }).appliedPaymentKeys.filter((key) => key === `nowpayments:${invoice.orderId}`).length, 1);
    const settled = ds.nowpayments.peek({ orderId: invoice.orderId });
    t.check("provider identifiers are bound to the invoice",
      settled?.paymentId === paymentId && settled?.invoiceId === invoice.invoiceId && settled?.payCurrency === asset.code && settled?.balanceCredited === true);
    const late = await apply(nowPaymentsIpn(invoice, { status: "failed", paymentId }));
    t.check("a late failed IPN cannot undo a finished payment", late.credited === false && ds.nowpayments.peek({ orderId: invoice.orderId })?.status === "finished");

    // ── Mismatches and failures never credit
    const second2 = mockUserId(25);
    await ds.users.create({ telegramId: second2, balance: 0 });
    const other = await create(second2, 120_000);
    const otherInvoice = ds.nowpayments.peek({ orderId: other.orderId });
    const mismatch = await apply(nowPaymentsIpn(otherInvoice, { status: "finished", paymentId: "5077125052", priceAmount: 99 }));
    t.check("amount mismatch is refused", mismatch.credited === false && mismatch.outcome === "amount_mismatch");
    t.equal("amount mismatch flags recovery", ds.nowpayments.peek({ orderId: other.orderId })?.recoveryStatus, "required");
    const underpaid = await apply(nowPaymentsIpn(otherInvoice, { status: "finished", paymentId: "5077125052", actuallyPaid: otherInvoice.payAmount / 2 }));
    t.check("underpayment marked finished is refused", underpaid.credited === false);
    await apply(nowPaymentsIpn(otherInvoice, { status: "failed", paymentId: "5077125052" }));
    t.equal("failed IPN closes the invoice", ds.nowpayments.peek({ orderId: other.orderId })?.status, "failed");
    const afterFailure = await apply(nowPaymentsIpn(otherInvoice, { status: "finished", paymentId: "5077125052" }));
    t.check("finished after failed does not credit", afterFailure.credited === false);
    t.equal("rejected IPNs left the wallet untouched", ds.users.peek({ telegramId: second2 }).balance, 0);
    t.check("unknown order IDs are ignored", (await apply({ ...finished, order_id: "NP-00000000-0000-4000-8000-000000000000" })).outcome === "unknown_order");

    t.note("Provider responses and IPNs were synthesised and signed with a per-run random secret. No blockchain funds were transferred and no real invoice was created.");
  },
});

export default cryptoScenario;
