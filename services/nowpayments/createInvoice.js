import { randomUUID } from "node:crypto";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import { resolveTomanPerFiat } from "./exchangeRate.js";
import {
  buildDirectPaymentRequest,
  buildInvoicePaymentRequest,
  buildInvoiceRequest,
  currenciesIncludeAsset,
  invoiceUrlIsTrusted,
  normalizePayCurrency,
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

function assertProviderId(value) {
  const id = value == null ? "" : String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new NowPaymentsFlowError("malformed_response");
  return id;
}

export async function createNowPaymentsTopUp({
  userId,
  amountToman,
  payCurrency: requestedPayCurrency = null,
  ticker: requestedTicker = null,
  network: requestedNetwork = null,
  currencyPrecision = 6,
  planId = null,
  quote = null,
  description = null,
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

    const targetPayCurrency = normalizePayCurrency(
      requestedPayCurrency || quote?.payCurrency || config.payCurrency,
    );
    if (!targetPayCurrency) throw new NowPaymentsFlowError("currency_unavailable");
    const targetTicker = String(requestedTicker || quote?.ticker || targetPayCurrency).trim().toUpperCase();
    const targetNetwork = String(requestedNetwork || quote?.network || targetPayCurrency).trim().toUpperCase();
    const targetPrecision = Number.isInteger(currencyPrecision) ? currencyPrecision : (quote?.currencyPrecision ?? 6);
    const targetPlanId = planId || quote?.planId || null;

    const rate = await resolveRate({ priceCurrency: config.priceCurrency, env });
    const priceAmountCents = tomanToFiatCents(amountToman, rate.tomanPerFiat);
    if (priceAmountCents == null) throw new NowPaymentsFlowError("invalid_rate");

    if (quote?.minAmount?.minFiatEquivalent != null) {
      const priceUsd = priceAmountCents / 100;
      if (priceUsd + 1e-6 < Number(quote.minAmount.minFiatEquivalent)) {
        throw new NowPaymentsFlowError("below_min_amount");
      }
    }

    orderId = `NP-${randomUUID()}`;
    const openCreateKey = `user:${numericUserId}`;
    const currentNow = now();
    const immutableSnapshot = {
      orderId,
      userId: numericUserId,
      planId: targetPlanId,
      amountToman,
      gheymatQuote: quote?.quoteSnapshot?.gheymatQuote || {
        value: rate.tomanPerFiat,
        unit: "toman",
        source: rate.source,
        quoteAt: rate.quoteAt || currentNow.getTime(),
      },
      priceCurrency: config.priceCurrency,
      priceAmountCents,
      finalPriceAmount: Number((priceAmountCents / 100).toFixed(2)),
      selectedAsset: {
        payCurrency: targetPayCurrency,
        ticker: targetTicker,
        network: targetNetwork,
        currencyPrecision: targetPrecision,
      },
      estimate: quote?.quoteSnapshot?.estimate || (quote?.estimatedAmount
        ? {
            estimatedAmount: quote.estimatedAmount,
            estimateAt: quote.estimateAt || currentNow.getTime(),
          }
        : null),
      minAmount: quote?.minAmount || null,
      feePolicy: {
        isFixedRate: Boolean(config.isFixedRate),
        isFeePaidByUser: Boolean(config.isFeePaidByUser),
      },
      quoteExpiresAt: quote?.quoteExpiresAt ? new Date(quote.quoteExpiresAt).toISOString() : null,
      invoiceId: null,
      paymentId: null,
    };

    try {
      await invoiceModel.create({
        orderId,
        userId: numericUserId,
        amountToman,
        priceAmountCents,
        priceCurrency: config.priceCurrency,
        payCurrency: targetPayCurrency,
        ticker: targetTicker,
        network: targetNetwork,
        currencyPrecision: targetPrecision,
        planId: targetPlanId,
        tomanPerFiat: rate.tomanPerFiat,
        rateSource: rate.source,
        quotedAt: rate.quoteAt ? new Date(rate.quoteAt) : currentNow,
        estimatedPayAmount: quote?.estimatedAmount ?? null,
        estimatedAt: quote?.estimateAt ? new Date(quote.estimateAt) : null,
        minPayAmount: quote?.minAmount?.minCryptoAmount ?? null,
        minFiatEquivalent: quote?.minAmount?.minFiatEquivalent ?? null,
        quoteExpiresAt: quote?.quoteExpiresAt ? new Date(quote.quoteExpiresAt) : null,
        feePolicy: {
          isFixedRate: Boolean(config.isFixedRate),
          isFeePaidByUser: Boolean(config.isFeePaidByUser),
        },
        quoteSnapshot: immutableSnapshot,
        status: "creating",
        openCreateKey,
        creditLedgerVersion: 2,
        createdAt: currentNow,
        updatedAt: currentNow,
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
    if (currencies.status < 200 || currencies.status >= 300 || !currenciesIncludeAsset(currencies.data, targetPayCurrency)) {
      logQuoteFailure("nowpayments_currencies", {
        code: "currency_unavailable",
        status: currencies?.status,
        providerCode: currencies?.providerCode,
        message: currencies?.providerMessage || `${targetPayCurrency} was not available`,
      });
      await markFailed(invoiceModel, orderId);
      throw new NowPaymentsFlowError("currency_unavailable");
    }

    const payload = buildInvoiceRequest({
      orderId,
      priceAmountCents,
      priceCurrency: config.priceCurrency,
      payCurrency: targetPayCurrency,
      ipnCallbackUrl: config.callbackUrl,
      description: description || "SWIFT VPN wallet top-up",
      isFixedRate: config.isFixedRate,
      isFeePaidByUser: config.isFeePaidByUser,
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
      invoiceId = assertProviderId(body.id);
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
    if (body.pay_currency != null && String(body.pay_currency).toLowerCase() !== targetPayCurrency) {
      await markUnknown(invoiceModel, orderId, invoiceId);
      throw new NowPaymentsFlowError("malformed_response");
    }

    const responsePayAmount = Number(body.pay_amount);
    const payAmount = Number.isFinite(responsePayAmount)
      && responsePayAmount > 0
      && String(body.pay_currency || "").toLowerCase() === targetPayCurrency
      ? responsePayAmount
      : null;

    const updatedSnapshot = {
      ...immutableSnapshot,
      invoiceId,
    };

    await invoiceModel.updateOne({ orderId, status: "creating" }, {
      $set: {
        status: "pending",
        invoiceId,
        invoiceUrl: String(body.invoice_url),
        payAmount,
        quoteSnapshot: updatedSnapshot,
        recoveryStatus: "none",
        recoveryReason: null,
        updatedAt: now(),
      },
      $unset: { openCreateKey: 1, nextRetryAt: 1 },
    });
    return {
      orderId,
      invoiceId,
      invoiceUrl: String(body.invoice_url),
      amountToman,
      priceAmountCents,
      priceCurrency: config.priceCurrency,
      payCurrency: targetPayCurrency,
      ticker: targetTicker,
      network: targetNetwork,
      payAmount,
      quoteSnapshot: updatedSnapshot,
    };
  } finally {
    localLocks.delete(lockKey);
  }
}

/**
 * Create a direct payment via POST /v1/payment or bind an invoice payment via POST /v1/invoice-payment.
 */
export async function createNowPaymentsDirectPayment({
  orderId,
  invoiceId = null,
  priceAmountCents,
  payCurrency,
  description = "SWIFT VPN payment",
  env = process.env,
  invoiceModel = NowPaymentsInvoice,
  request,
  now = () => new Date(),
} = {}) {
  const config = readNowPaymentsConfig(env);
  if (!config) throw new NowPaymentsFlowError("not_configured");
  const normalizedPayCurrency = normalizePayCurrency(payCurrency || config.payCurrency);
  if (!normalizedPayCurrency) throw new NowPaymentsFlowError("currency_unavailable");

  const call = request || createNowPaymentsRequest({ apiKey: config.apiKey, baseURL: config.baseURL });
  let response;
  if (invoiceId) {
    const payload = buildInvoicePaymentRequest({
      iid: invoiceId,
      payCurrency: normalizedPayCurrency,
      orderDescription: description,
    });
    response = await call({ method: "POST", path: "/invoice-payment", data: payload });
  } else {
    const payload = buildDirectPaymentRequest({
      orderId,
      priceAmountCents,
      priceCurrency: config.priceCurrency,
      payCurrency: normalizedPayCurrency,
      ipnCallbackUrl: config.callbackUrl,
      description,
      isFixedRate: config.isFixedRate,
      isFeePaidByUser: config.isFeePaidByUser,
    });
    response = await call({ method: "POST", path: "/payment", data: payload });
  }

  const body = response?.data;
  if (!body || typeof body !== "object") {
    throw new NowPaymentsFlowError("malformed_response");
  }
  const paymentId = assertProviderId(body.payment_id);
  const payAddress = typeof body.pay_address === "string" && body.pay_address.trim() ? body.pay_address.trim() : null;
  if (!payAddress) {
    throw new NowPaymentsFlowError("malformed_response");
  }
  const payAmount = Number.isFinite(Number(body.pay_amount)) && Number(body.pay_amount) > 0
    ? Number(body.pay_amount)
    : null;
  const payinExtraId = typeof body.payin_extra_id === "string" ? body.payin_extra_id : null;
  const expirationEstimateDate = typeof body.expiration_estimate_date === "string"
    ? body.expiration_estimate_date
    : null;

  if (orderId && invoiceModel) {
    await invoiceModel.updateOne(
      { orderId },
      {
        $set: {
          paymentId,
          payAddress,
          payAmount,
          payinExtraId,
          expirationEstimateDate,
          status: body.payment_status || "waiting",
          providerStatus: body.payment_status || "waiting",
          updatedAt: now(),
        },
      },
    );
  }

  return {
    paymentId,
    paymentStatus: body.payment_status || "waiting",
    payAddress,
    payAmount,
    payCurrency: normalizedPayCurrency,
    payinExtraId,
    expirationEstimateDate,
  };
}

/**
 * Refresh merchant estimate on an active payment via POST /v1/payment/:id/update-merchant-estimate.
 */
export async function refreshNowPaymentsMerchantEstimate({
  paymentId,
  env = process.env,
  invoiceModel = NowPaymentsInvoice,
  request,
  now = () => new Date(),
} = {}) {
  const config = readNowPaymentsConfig(env, { allowWithoutCallback: true });
  if (!config) throw new NowPaymentsFlowError("not_configured");
  const cleanPaymentId = assertProviderId(paymentId);
  const call = request || createNowPaymentsRequest({ apiKey: config.apiKey, baseURL: config.baseURL });
  const response = await call({
    method: "POST",
    path: `/payment/${encodeURIComponent(cleanPaymentId)}/update-merchant-estimate`,
  });
  const body = response?.data;
  const updatedPayAmount = Number(body?.pay_amount);
  if (!Number.isFinite(updatedPayAmount) || updatedPayAmount <= 0) {
    throw new NowPaymentsFlowError("malformed_response");
  }
  const expirationEstimateDate = typeof body?.expiration_estimate_date === "string"
    ? body.expiration_estimate_date
    : null;

  if (invoiceModel) {
    await invoiceModel.updateOne(
      { paymentId: cleanPaymentId, balanceCredited: false },
      {
        $set: {
          payAmount: updatedPayAmount,
          ...(expirationEstimateDate ? { expirationEstimateDate } : {}),
          updatedAt: now(),
        },
      },
    );
  }

  return {
    paymentId: cleanPaymentId,
    payAmount: updatedPayAmount,
    expirationEstimateDate,
  };
}

async function markFailed(model, orderId) {
  await model.updateOne({ orderId, status: "creating" }, {
    $set: { status: "creation_failed", recoveryStatus: "none", recoveryReason: null, updatedAt: new Date() },
    $unset: { openCreateKey: 1, nextRetryAt: 1 },
  });
}

async function markUnknown(model, orderId, invoiceId) {
  const now = new Date();
  const update = {
    status: "creation_unknown",
    recoveryStatus: "required",
    recoveryReason: "provider_creation_outcome_unknown",
    nextRetryAt: new Date(now.getTime() + 2 * 60_000),
    updatedAt: now,
  };
  if (invoiceId) update.invoiceId = invoiceId;
  await model.updateOne({ orderId, status: "creating" }, { $set: update });
}

export function resetNowPaymentsCreateLocksForTests() {
  localLocks.clear();
}
