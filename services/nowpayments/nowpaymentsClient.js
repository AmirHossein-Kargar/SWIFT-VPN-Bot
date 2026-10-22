import axios from "axios";
import { NowPaymentsFlowError } from "./money.js";

export class NowPaymentsApiError extends Error {
  constructor(code, { status, ambiguous = false, message = null } = {}) {
    super(message || `NOWPayments request failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`);
    this.name = "NowPaymentsApiError";
    this.code = code;
    this.status = status;
    this.ambiguous = Boolean(ambiguous);
  }
}

function sanitizeSecretText(text, secrets = []) {
  if (!text) return "";
  let out = String(text);
  for (const secret of secrets) {
    if (secret && String(secret).trim()) {
      out = out.split(String(secret).trim()).join("[REDACTED]");
    }
  }
  return out.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
}

function providerDetails(data, secrets = []) {
  if (!data || typeof data !== "object") return {};
  const code = data.code ?? data.error;
  const message = typeof data.message === "string" ? sanitizeSecretText(data.message, secrets) : undefined;
  return {
    providerCode: code == null ? undefined : String(code).slice(0, 80),
    providerMessage: message || undefined,
  };
}

export function buildQueryPath(basePath, params = {}) {
  const entries = Object.entries(params || {}).filter(
    ([, val]) => val !== undefined && val !== null && String(val).trim() !== "",
  );
  if (!entries.length) return basePath;
  const search = new URLSearchParams();
  for (const [key, val] of entries) {
    search.set(key, String(val));
  }
  const sep = basePath.includes("?") ? "&" : "?";
  return `${basePath}${sep}${search.toString()}`;
}

export function createNowPaymentsRequest({
  apiKey,
  baseURL,
  transport = axios.request,
  extraSecrets = [],
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new NowPaymentsFlowError("not_configured");
  const normalizedBase = String(baseURL || "https://api.nowpayments.io/v1").replace(/\/+$/, "");

  return async function nowpaymentsRequest({
    method = "GET",
    path,
    data,
    bearerToken,
    includeApiKey = true,
  } = {}) {
    const secrets = [
      apiKey,
      bearerToken,
      ...(Array.isArray(extraSecrets) ? extraSecrets : []),
      typeof data?.password === "string" ? data.password : null,
    ].filter(Boolean);

    const headers = {
      Accept: "application/json",
    };
    if (includeApiKey && apiKey) {
      headers["x-api-key"] = apiKey;
    }
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    // GET /v1/estimate is documented with x-api-key only. A JSON body is not part of that contract.
    if (data !== undefined) headers["Content-Type"] = "application/json";

    const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
    try {
      const response = await transport({
        method,
        url: `${normalizedBase}${normalizedPath}`,
        data,
        headers,
        timeout: 15_000,
        maxContentLength: 1_048_576,
        maxBodyLength: 1_048_576,
        validateStatus: () => true,
      });
      return {
        status: response.status,
        data: response.data,
        ...providerDetails(response.data, secrets),
      };
    } catch (error) {
      const status = Number.isInteger(error?.response?.status) ? error.response.status : undefined;
      const details = providerDetails(error?.response?.data, secrets);
      const wrapped = new NowPaymentsApiError("transport", {
        status,
        ambiguous: !status || status >= 500,
      });
      wrapped.providerCode = details.providerCode;
      wrapped.providerMessage = details.providerMessage;
      throw wrapped;
    }
  };
}

const jwtCache = new Map();
const JWT_CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes (NOWPayments JWT expires in 5 minutes)

export function resetNowPaymentsAuthCacheForTests() {
  jwtCache.clear();
}

function assertSuccessResponse(response, fallbackCode = "provider_rejected") {
  const status = Number(response?.status || 0);
  if (status >= 200 && status < 300) {
    return response;
  }
  const code = status === 401 || status === 403
    ? "auth_failed"
    : status >= 500 || status === 408 || status === 429
      ? "provider_unavailable"
      : fallbackCode;
  const err = new NowPaymentsApiError(code, {
    status,
    ambiguous: status >= 500 || status === 408 || status === 429,
    message: response?.providerMessage
      ? `NOWPayments request failed (HTTP ${status}): ${response.providerMessage}`
      : `NOWPayments request failed (HTTP ${status})`,
  });
  err.providerCode = response?.providerCode;
  err.providerMessage = response?.providerMessage;
  throw err;
}

export async function authenticateNowPayments({
  email,
  password,
  request,
  baseURL = "https://api.nowpayments.io/v1",
  now = Date.now,
  forceRefresh = false,
} = {}) {
  const cleanEmail = String(email || "").trim();
  const cleanPassword = String(password || "").trim();
  if (!cleanEmail || !cleanPassword) {
    throw new NowPaymentsApiError("custody_auth_not_configured", {
      status: 401,
      ambiguous: false,
      message: "NOWPayments Custody JWT credentials (NOWPAYMENTS_EMAIL / NOWPAYMENTS_PASSWORD) are not configured",
    });
  }
  const cacheKey = `${String(baseURL).replace(/\/+$/, "")}:${cleanEmail.toLowerCase()}`;
  const currentNow = typeof now === "function" ? now() : (now instanceof Date ? now.getTime() : Number(now));
  if (!forceRefresh) {
    const cached = jwtCache.get(cacheKey);
    if (cached && cached.expiresAt > currentNow && cached.token) {
      return cached.token;
    }
  }

  const response = await request({
    method: "POST",
    path: "/auth",
    data: { email: cleanEmail, password: cleanPassword },
    includeApiKey: false,
  });
  assertSuccessResponse(response, "auth_failed");
  const token = typeof response?.data?.token === "string" ? response.data.token.trim() : "";
  if (!token) {
    throw new NowPaymentsApiError("auth_malformed", {
      status: response?.status ?? 200,
      ambiguous: false,
      message: "NOWPayments /auth response did not include a bearer token",
    });
  }
  jwtCache.set(cacheKey, {
    token,
    obtainedAt: currentNow,
    expiresAt: currentNow + JWT_CACHE_TTL_MS,
  });
  return token;
}

/**
 * High-level NOWPayments API & Custody client covering all documented v1 endpoints.
 * Never retries mutating financial POST operations; supports safe read-only GET retries.
 */
export function createNowPaymentsClient({
  apiKey,
  baseURL = "https://api.nowpayments.io/v1",
  email = "",
  password = "",
  transport = axios.request,
  request: injectedRequest = null,
  now = Date.now,
  readRetries = 1,
} = {}) {
  const baseRequest = injectedRequest || createNowPaymentsRequest({
    apiKey: apiKey || "unconfigured",
    baseURL,
    transport,
    extraSecrets: [password],
  });

  async function safeReadRequest(options) {
    let lastError;
    const attempts = Math.max(1, Number(readRetries || 0) + 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await baseRequest({ ...options, method: "GET" });
        return assertSuccessResponse(res);
      } catch (error) {
        lastError = error;
        const retryable = error?.code === "transport" || error?.code === "provider_unavailable";
        if (!retryable || attempt + 1 >= attempts) throw error;
      }
    }
    throw lastError;
  }

  async function mutatingPostRequest(options) {
    const res = await baseRequest({ ...options, method: "POST" });
    return assertSuccessResponse(res);
  }

  async function getJwtToken(forceRefresh = false) {
    return authenticateNowPayments({
      email,
      password,
      request: baseRequest,
      baseURL,
      now,
      forceRefresh,
    });
  }

  async function authenticatedGet(path, { includeApiKey = true } = {}) {
    const token = await getJwtToken(false);
    try {
      return await safeReadRequest({ path, bearerToken: token, includeApiKey });
    } catch (error) {
      if (error?.status === 401) {
        const refreshed = await getJwtToken(true);
        return safeReadRequest({ path, bearerToken: refreshed, includeApiKey });
      }
      throw error;
    }
  }

  async function authenticatedPost(path, data, { includeApiKey = true } = {}) {
    const token = await getJwtToken(false);
    return mutatingPostRequest({
      path,
      data,
      bearerToken: token,
      includeApiKey,
    });
  }

  return {
    request: baseRequest,
    hasJwtCredentials: () => Boolean(String(email || "").trim() && String(password || "").trim()),

    // Discovery & Pricing
    getStatus: () => safeReadRequest({ path: "/status", includeApiKey: false }),
    getCurrencies: ({ fixedRate } = {}) => safeReadRequest({
      path: buildQueryPath("/currencies", fixedRate !== undefined ? { fixed_rate: fixedRate } : {}),
    }),
    getFullCurrencies: () => safeReadRequest({ path: "/full-currencies" }),
    getMerchantCoins: () => safeReadRequest({ path: "/merchant/coins" }),
    getMinAmount: ({ currencyFrom, currencyTo, fiatEquivalent, isFixedRate, isFeePaidByUser } = {}) => safeReadRequest({
      path: buildQueryPath("/min-amount", {
        currency_from: currencyFrom,
        currency_to: currencyTo,
        fiat_equivalent: fiatEquivalent,
        is_fixed_rate: isFixedRate,
        is_fee_paid_by_user: isFeePaidByUser,
      }),
    }),
    getEstimate: ({ amount, currencyFrom, currencyTo } = {}) => safeReadRequest({
      path: buildQueryPath("/estimate", {
        amount,
        currency_from: currencyFrom,
        currency_to: currencyTo,
      }),
    }),

    // Invoices & Payments
    createInvoice: (payload) => mutatingPostRequest({ path: "/invoice", data: payload }),
    createPayment: (payload) => mutatingPostRequest({ path: "/payment", data: payload }),
    createInvoicePayment: (payload) => mutatingPostRequest({ path: "/invoice-payment", data: payload }),
    getPaymentStatus: (paymentId) => safeReadRequest({
      path: `/payment/${encodeURIComponent(String(paymentId).trim())}`,
    }),
    updateMerchantEstimate: (paymentId) => mutatingPostRequest({
      path: `/payment/${encodeURIComponent(String(paymentId).trim())}/update-merchant-estimate`,
    }),
    listPayments: ({ limit = 20, page = 0, sortBy = "created_at", orderBy = "desc", dateFrom, dateTo, invoiceId } = {}) =>
      authenticatedGet(
        buildQueryPath("/payment/", { limit, page, sortBy, orderBy, dateFrom, dateTo, invoiceId }),
        { includeApiKey: true },
      ),

    // Custody Balances & Sub-Partners
    getBalance: async () => {
      if (String(email || "").trim() && String(password || "").trim()) {
        try {
          return await authenticatedGet("/balance", { includeApiKey: true });
        } catch {
          return safeReadRequest({ path: "/balance" });
        }
      }
      return safeReadRequest({ path: "/balance" });
    },
    getSubPartnerBalance: (subPartnerId) => safeReadRequest({
      path: buildQueryPath("/sub-partner/balance", { id: subPartnerId }),
    }),
    listSubPartners: ({ id, offset, limit, order } = {}) => authenticatedGet(
      buildQueryPath("/sub-partner", { id, offset, limit, order }),
      { includeApiKey: false },
    ),
    listSubPartnerTransfers: ({ id, status, limit, offset, order } = {}) => authenticatedGet(
      buildQueryPath("/sub-partner/transfers", { id, status, limit, offset, order }),
      { includeApiKey: false },
    ),

    // Custody Conversions
    createConversion: ({ amount, fromCurrency, toCurrency }) => authenticatedPost(
      "/conversion",
      {
        amount: String(amount),
        from_currency: String(fromCurrency || "").trim().toLowerCase(),
        to_currency: String(toCurrency || "").trim().toLowerCase(),
      },
      { includeApiKey: false },
    ),
    getConversionStatus: (conversionId) => authenticatedGet(
      `/conversion/${encodeURIComponent(String(conversionId).trim())}`,
      { includeApiKey: false },
    ),
    listConversions: ({ limit = 20, offset = 0, order = "DESC" } = {}) => authenticatedGet(
      buildQueryPath("/conversion", { limit, offset, order }),
      { includeApiKey: false },
    ),

    // Custody Withdrawals / Mass Payouts
    validatePayoutAddress: ({ address, currency, extraId = null }) => mutatingPostRequest({
      path: "/payout/validate-address",
      data: {
        address: String(address || "").trim(),
        currency: String(currency || "").trim().toLowerCase(),
        ...(extraId ? { extra_id: String(extraId).trim() } : {}),
      },
    }),
    getPayoutFee: ({ currency, amount }) => safeReadRequest({
      path: buildQueryPath("/payout/fee", {
        currency: String(currency || "").trim().toLowerCase(),
        amount,
      }),
    }),
    createPayout: ({ withdrawals, ipnCallbackUrl }) => authenticatedPost(
      "/payout",
      {
        ...(ipnCallbackUrl ? { ipn_callback_url: ipnCallbackUrl } : {}),
        withdrawals,
      },
      { includeApiKey: true },
    ),
    verifyPayout: ({ batchWithdrawalId, verificationCode }) => authenticatedPost(
      `/payout/${encodeURIComponent(String(batchWithdrawalId).trim())}/verify`,
      { verification_code: String(verificationCode || "").trim() },
      { includeApiKey: true },
    ),
    getPayoutStatus: (payoutId) => safeReadRequest({
      path: `/payout/${encodeURIComponent(String(payoutId).trim())}`,
    }),
    listPayouts: ({ batchId, status, orderBy, order, dateFrom, dateTo, limit = 20, page = 0 } = {}) =>
      authenticatedGet(
        buildQueryPath("/payout", {
          batch_id: batchId,
          status,
          order_by: orderBy,
          order,
          date_from: dateFrom,
          date_to: dateTo,
          limit,
          page,
        }),
        { includeApiKey: true },
      ),
  };
}
