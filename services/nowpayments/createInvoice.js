import { randomUUID } from "node:crypto";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import { TRON_PAY_CURRENCY } from "./constants.js";
import { resolveTomanPerFiat } from "./exchangeRate.js";
import {
  buildInvoiceRequest,
  currenciesIncludeTron,
  invoiceUrlIsTrusted,
  readNowPaymentsConfig,
  tomanToFiatCents,
  NowPaymentsFlowError,
} from "./money.js";
import { createNowPaymentsRequest, NowPaymentsApiError } from "./nowpaymentsClient.js";
import { logQuoteFailure } from "../pricing/quoteLog.js";

const OPEN_CREATE = ["creating", "creation_unknown"];
const localLocks = new Set();

async function findOne(model, filter) {
  const query = model.findOne(filter);
  return typeof query?.lean === "function" ? query.lean() : query;
}

function duplicateKey(error) {
  return error?.code === 11000;
}

function assertProviderId(value, field) {
  const id = value == null ? "" : String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new NowPaymentsFlowError("malformed_response");
  return id;
}

export async function createNowPaymentsTopUp({
  userId,
  amountToman,
  env = process.env,
  invoiceModel = NowPaymentsInvoice,
  request,
  resolveRate = resolveTomanPerFiat,
  now = () => new Date(),
} = {}) {
  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) throw new NowPaymentsFlowError("invalid_user");
  if (!Number.isSafeInteger(amountToman) || amountToman <= 0) throw new NowPaymentsFlowError("invalid_amount");

  const lockKey = String(numericUserId);
  if (localLocks.has(lockKey)) throw new NowPaymentsFlowError("in_flight");
  localLocks.add(lockKey);
  let orderId = null;
  try {
    const config = readNowPaymentsConfig(env);
    if (!config) throw new NowPaymentsFlowError("not_configured");
    const open = await findOne(invoiceModel, {
      userId: numericUserId,
      status: { $in: OPEN_CREATE },
    });
    if (open) throw new NowPaymentsFlowError("in_flight");

    const rate = await resolveRate({ priceCurrency: config.priceCurrency, env });
    const priceAmountCents = tomanToFiatCents(amountToman, rate.tomanPerFiat);
    if (priceAmountCents == null) throw new NowPaymentsFlowError("invalid_rate");

    orderId = `NP-${randomUUID()}`;
    const openCreateKey = `user:${numericUserId}`;
    try {
      await invoiceModel.create({
        orderId,
        userId: numericUserId,
        amountToman,
        priceAmountCents,
        priceCurrency: config.priceCurrency,
        payCurrency: TRON_PAY_CURRENCY,
        tomanPerFiat: rate.tomanPerFiat,
        rateSource: rate.source,
        status: "creating",
        openCreateKey,
        creditLedgerVersion: 2,
        createdAt: now(),
        updatedAt: now(),
      });
    } catch (error) {
      if (duplicateKey(error)) throw new NowPaymentsFlowError("in_flight");
      throw error;
    }

    const call = request || createNowPaymentsRequest({ apiKey: config.apiKey, baseURL: config.baseURL });
    let currencies;
    try {
      currencies = await call({ method: "GET", path: "/currencies" });
    } catch (error) {
      logQuoteFailure("nowpayments_currencies", error);
      await markFailed(invoiceModel, orderId);
      if (error instanceof NowPaymentsApiError && error.ambiguous) throw new NowPaymentsFlowError("currency_unavailable");
      throw new NowPaymentsFlowError("currency_unavailable");
    }
    if (currencies.status < 200 || currencies.status >= 300 || !currenciesIncludeTron(currencies.data)) {
      logQuoteFailure("nowpayments_currencies", {
        code: "currency_unavailable",
        status: currencies?.status,
        providerCode: currencies?.providerCode,
        message: currencies?.providerMessage || "trx was not available",
      });
      await markFailed(invoiceModel, orderId);
      throw new NowPaymentsFlowError("currency_unavailable");
    }

    const payload = buildInvoiceRequest({
      orderId,
      priceAmountCents,
      priceCurrency: config.priceCurrency,
      payCurrency: TRON_PAY_CURRENCY,
      ipnCallbackUrl: config.callbackUrl,
      description: "SWIFT VPN wallet top-up",
    });
    if (payload.price_amount === amountToman && config.priceCurrency !== "toman") {
      await markFailed(invoiceModel, orderId);
      throw new NowPaymentsFlowError("invalid_rate");
    }
    await invoiceModel.updateOne({ orderId, status: "creating" }, {
      $set: { apiAttemptedAt: now(), updatedAt: now() },
    });

    let response;
    try {
      response = await call({ method: "POST", path: "/invoice", data: payload });
    } catch (error) {
      logQuoteFailure("nowpayments_invoice", error);
      await markUnknown(invoiceModel, orderId);
      const wrapped = new NowPaymentsFlowError("ambiguous");
      if (Number.isInteger(error?.status)) wrapped.status = error.status;
      if (error?.providerCode) wrapped.providerCode = error.providerCode;
      throw wrapped;
    }
    if (!response || response.status >= 500 || response.status === 408 || response.status === 429) {
      logQuoteFailure("nowpayments_invoice", {
        code: "ambiguous",
        status: response?.status,
        providerCode: response?.providerCode,
        message: response?.providerMessage,
      });
      await markUnknown(invoiceModel, orderId);
      const wrapped = new NowPaymentsFlowError("ambiguous");
      if (Number.isInteger(response?.status)) wrapped.status = response.status;
      throw wrapped;
    }
    if (response.status < 200 || response.status >= 300) {
      logQuoteFailure("nowpayments_invoice", {
        code: "provider_rejected",
        status: response.status,
        providerCode: response.providerCode,
        message: response.providerMessage,
      });
      await markFailed(invoiceModel, orderId);
      const wrapped = new NowPaymentsFlowError("provider_rejected");
      wrapped.status = response.status;
      wrapped.providerCode = response.providerCode;
      throw wrapped;
    }

    const body = response.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      await markUnknown(invoiceModel, orderId);
      throw new NowPaymentsFlowError("malformed_response");
    }
    let invoiceId;
    try {
      invoiceId = assertProviderId(body.id, "id");
    } catch {
      await markUnknown(invoiceModel, orderId);
      throw new NowPaymentsFlowError("malformed_response");
    }
    if (body.order_id != null && String(body.order_id) !== orderId) {
      await markUnknown(invoiceModel, orderId, invoiceId);
      throw new NowPaymentsFlowError("malformed_response");
    }
    if (!invoiceUrlIsTrusted(body.invoice_url)) {
      await markUnknown(invoiceModel, orderId, invoiceId);
      throw new NowPaymentsFlowError("malformed_response");
    }
    const echoedCents = body.price_amount == null ? priceAmountCents : Math.round(Number(body.price_amount) * 100);
    if (echoedCents !== priceAmountCents || (body.price_currency != null && String(body.price_currency).toLowerCase() !== config.priceCurrency)) {
      await markUnknown(invoiceModel, orderId, invoiceId);
      throw new NowPaymentsFlowError("malformed_response");
    }
    if (body.pay_currency != null && String(body.pay_currency).toLowerCase() !== TRON_PAY_CURRENCY) {
      await markUnknown(invoiceModel, orderId, invoiceId);
      throw new NowPaymentsFlowError("malformed_response");
    }

    await invoiceModel.updateOne({ orderId, status: "creating" }, {
      $set: {
        status: "pending",
        invoiceId,
        invoiceUrl: String(body.invoice_url),
        updatedAt: now(),
      },
      $unset: { openCreateKey: 1 },
    });
    const payAmount = Number(body.pay_amount);
    return {
      orderId,
      invoiceId,
      invoiceUrl: String(body.invoice_url),
      amountToman,
      priceAmountCents,
      priceCurrency: config.priceCurrency,
      payCurrency: TRON_PAY_CURRENCY,
      payAmount: Number.isFinite(payAmount) && payAmount > 0 && String(body.pay_currency || "").toLowerCase() === TRON_PAY_CURRENCY
        ? payAmount
        : null,
    };
  } finally {
    localLocks.delete(lockKey);
  }
}

async function markFailed(model, orderId) {
  await model.updateOne({ orderId, status: "creating" }, {
    $set: { status: "creation_failed", updatedAt: new Date() },
    $unset: { openCreateKey: 1 },
  });
}

async function markUnknown(model, orderId, invoiceId) {
  const update = { status: "creation_unknown", updatedAt: new Date() };
  if (invoiceId) update.invoiceId = invoiceId;
  await model.updateOne({ orderId, status: "creating" }, { $set: update });
}

export function resetNowPaymentsCreateLocksForTests() {
  localLocks.clear();
}
