import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import {
  KNOWN_CONVERSION_STATUSES,
  KNOWN_PAYMENT_STATUSES,
  KNOWN_PAYOUT_STATUSES,
  NOWPAYMENTS_CAPABILITY_MATRIX,
} from "../nowpayments/constants.js";
import {
  centsToPriceAmount,
  compareDecimalAmounts,
  normalizePayCurrency,
  readNowPaymentsConfig,
} from "../nowpayments/money.js";
import { createNowPaymentsClient } from "../nowpayments/nowpaymentsClient.js";
import { fetchNowPaymentsCatalog, validateCatalogSelection } from "../nowpayments/catalog.js";
import { isOwnerUser } from "./adminRegistry.js";
import { runAuditedAction } from "./audit.js";
import {
  AdminServiceError,
  assertAdminUser,
} from "./authorization.js";

function parsePageParams(query = {}, { defaultPageSize = 15, maxPageSize = 100 } = {}) {
  const rawPage = Number(query?.page ?? 1);
  const rawPageSize = Number(query?.pageSize ?? defaultPageSize);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawPageSize) && rawPageSize >= 1
    ? Math.min(rawPageSize, maxPageSize)
    : defaultPageSize;
  return { page, pageSize };
}

function parseSearchTerm(raw) {
  return String(raw ?? "").trim().slice(0, 120);
}

function requireReason(raw) {
  const clean = String(raw ?? "").trim();
  if (clean.length < 3 || clean.length > 500) {
    throw new AdminServiceError("A reason between 3 and 500 characters is required for this audited action.", {
      status: 400,
      code: "invalid_reason",
    });
  }
  return clean;
}

function assertOwnerActor(actorId) {
  const admin = assertAdminUser(actorId);
  if (!isOwnerUser(admin)) {
    throw new AdminServiceError(
      "Only the primary owner account is authorized to execute Custody conversions or withdrawals.",
      { status: 403, code: "owner_only" },
    );
  }
  return admin;
}

let injectedCustodyDeps = {};
export function setCustodyDepsForTests(deps = {}) {
  injectedCustodyDeps = deps || {};
}

function resolveCustodyOptions(opts = {}) {
  return {
    env: opts.env || injectedCustodyDeps.env || process.env,
    request: opts.request || injectedCustodyDeps.request || null,
    client: opts.client || injectedCustodyDeps.client || null,
    invoiceModel: opts.invoiceModel || injectedCustodyDeps.invoiceModel || NowPaymentsInvoice,
    auditModel: opts.auditModel || injectedCustodyDeps.auditModel || undefined,
    now: opts.now || injectedCustodyDeps.now || Date.now,
  };
}

function buildClientFromEnv(rawOpts = {}) {
  const { env, request, client, now } = resolveCustodyOptions(rawOpts);
  if (client) return { client, config: readNowPaymentsConfig(env, { allowWithoutCallback: true }) };
  let config = null;
  try {
    config = readNowPaymentsConfig(env, { allowWithoutCallback: true });
  } catch {
    config = null;
  }
  if (!config) {
    return { client: null, config: null };
  }
  return {
    config,
    client: createNowPaymentsClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      email: config.email,
      password: config.password,
      request,
      now,
    }),
  };
}

function normalizeBalanceEntries(rawBalances, catalogByCode = {}) {
  if (!rawBalances || typeof rawBalances !== "object" || Array.isArray(rawBalances)) {
    return [];
  }
  const rows = [];
  for (const [rawCode, entry] of Object.entries(rawBalances)) {
    if (!entry || typeof entry !== "object") continue;
    const code = normalizePayCurrency(rawCode);
    if (!code) continue;
    const rawAvailable = entry.amount ?? entry.available ?? entry.balance;
    const rawPending = entry.pendingAmount ?? entry.pending_amount ?? entry.pending ?? 0;
    const availableNum = Number(rawAvailable);
    const pendingNum = Number(rawPending);
    if (!Number.isFinite(availableNum) && !Number.isFinite(pendingNum)) continue;

    const meta = catalogByCode[code] || null;
    rows.push({
      code,
      ticker: meta?.ticker || code.toUpperCase(),
      name: meta?.name || code.toUpperCase(),
      network: meta?.network || code.toUpperCase(),
      availableAmount: Number.isFinite(availableNum) ? availableNum : null,
      availableDisplay: rawAvailable != null ? String(rawAvailable) : "0",
      pendingAmount: Number.isFinite(pendingNum) ? pendingNum : 0,
      pendingDisplay: rawPending != null ? String(rawPending) : "0",
      networkPrecision: meta?.networkPrecision ?? 8,
    });
  }
  return rows.sort((a, b) => {
    const aHas = (a.availableAmount || 0) > 0 || (a.pendingAmount || 0) > 0 ? 1 : 0;
    const bHas = (b.availableAmount || 0) > 0 || (b.pendingAmount || 0) > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return a.code.localeCompare(b.code);
  });
}

function normalizeConversionItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? item.conversion_id ?? "").trim();
  const fromCurrency = normalizePayCurrency(item.from_currency ?? item.fromCurrency ?? item.deposit_currency) || "—";
  const toCurrency = normalizePayCurrency(item.to_currency ?? item.toCurrency ?? item.withdrawal_currency) || "—";
  const fromAmount = item.from_amount ?? item.fromAmount ?? item.amount ?? null;
  const toAmount = item.to_amount ?? item.toAmount ?? item.outcome_amount ?? null;
  const rate = item.rate ?? (Number(fromAmount) > 0 && Number(toAmount) > 0
    ? Number((Number(toAmount) / Number(fromAmount)).toFixed(8))
    : null);
  const status = String(item.status || "waiting").trim().toLowerCase();
  return {
    id: id || "—",
    fromCurrency,
    toCurrency,
    fromAmount: fromAmount != null ? Number(fromAmount) : null,
    fromAmountDisplay: fromAmount != null ? String(fromAmount) : "—",
    toAmount: toAmount != null ? Number(toAmount) : null,
    toAmountDisplay: toAmount != null ? String(toAmount) : "—",
    rate: rate != null && Number.isFinite(Number(rate)) ? Number(rate) : null,
    status,
    createdAt: item.created_at || item.createdAt || null,
    updatedAt: item.updated_at || item.updatedAt || null,
  };
}

function normalizePayoutItem(item, catalogByCode = {}) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? item.payout_id ?? "").trim();
  const currency = normalizePayCurrency(item.currency) || "—";
  const meta = catalogByCode[currency] || null;
  const amount = item.amount != null ? Number(item.amount) : null;
  const fee = item.fee != null ? Number(item.fee) : null;
  return {
    id: id || "—",
    batchWithdrawalId: item.batch_withdrawal_id ? String(item.batch_withdrawal_id) : null,
    currency,
    ticker: meta?.ticker || currency.toUpperCase(),
    network: meta?.network || currency.toUpperCase(),
    address: item.address ? String(item.address) : "—",
    extraId: item.extra_id ? String(item.extra_id) : null,
    amount: Number.isFinite(amount) ? amount : null,
    amountDisplay: item.amount != null ? String(item.amount) : "—",
    fee: Number.isFinite(fee) ? fee : null,
    status: String(item.status || "waiting").trim().toLowerCase(),
    hash: item.hash ? String(item.hash) : null,
    error: item.error ? String(item.error) : null,
    uniqueExternalId: item.unique_external_id ? String(item.unique_external_id) : null,
    createdAt: item.created_at || item.createdAt || null,
    updatedAt: item.updated_at || item.updatedAt || null,
  };
}

function normalizeLocalInvoiceItem(doc) {
  if (!doc) return null;
  const priceUsd = centsToPriceAmount(doc.priceAmountCents);
  return {
    key: `nowpayments:${doc.orderId}`,
    orderId: doc.orderId,
    invoiceId: doc.invoiceId || null,
    paymentId: doc.paymentId || null,
    userId: String(doc.userId),
    planId: doc.planId || null,
    amountToman: doc.amountToman,
    priceAmountCents: doc.priceAmountCents,
    priceAmountUsd: priceUsd,
    priceCurrency: doc.priceCurrency || "usd",
    payCurrency: doc.payCurrency || "trx",
    ticker: doc.ticker || String(doc.payCurrency || "trx").toUpperCase(),
    network: doc.network || String(doc.payCurrency || "trx").toUpperCase(),
    estimatedPayAmount: doc.estimatedPayAmount ?? null,
    payAmount: doc.payAmount ?? null,
    actuallyPaid: doc.actuallyPaid ?? null,
    overpaidAmount: doc.overpaidAmount ?? null,
    underpaidAmount: doc.underpaidAmount ?? null,
    outcomeAmount: doc.outcomeAmount ?? null,
    outcomeCurrency: doc.outcomeCurrency || null,
    payAddress: doc.payAddress || null,
    status: doc.status,
    providerStatus: doc.providerStatus || null,
    balanceCredited: Boolean(doc.balanceCredited),
    recoveryStatus: doc.recoveryStatus || "none",
    recoveryReason: doc.recoveryReason || null,
    quoteSnapshot: doc.quoteSnapshot || null,
    createdAt: doc.createdAt || null,
    paidAt: doc.paidAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

export async function getCustodyOverview({
  actorId,
  env,
  request = null,
  client: injectedClient = null,
  invoiceModel,
  now,
} = {}) {
  assertAdminUser(actorId);
  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, invoiceModel, now });
  const currentNow = typeof resolved.now === "function" ? resolved.now() : Number(resolved.now);
  const { client, config } = buildClientFromEnv(resolved);
  invoiceModel = resolved.invoiceModel;
  env = resolved.env;
  now = resolved.now;

  const capabilities = {
    apiConfigured: Boolean(config?.apiKey),
    ipnConfigured: Boolean(config?.ipnSecret && config?.callbackUrl),
    custodyJwtConfigured: Boolean(config?.hasCustodyAuth),
    isOwner: isOwnerUser(actorId),
    apiHealthy: false,
    balanceEnabled: false,
    conversionsEnabled: false,
    payoutsEnabled: false,
    paymentListingEnabled: false,
  };

  let catalog = { assets: [], groups: [], byCode: {} };
  let balances = [];
  let balanceError = null;
  let recentConversions = [];
  let conversionsError = null;
  let recentPayouts = [];
  let payoutsError = null;
  let providerHealth = { status: "down", message: "Not configured" };

  if (client && config) {
    const [statusRes, catalogRes, balanceRes] = await Promise.allSettled([
      client.getStatus(),
      fetchNowPaymentsCatalog({ env, client, now }),
      client.getBalance(),
    ]);

    if (statusRes.status === "fulfilled") {
      capabilities.apiHealthy = true;
      providerHealth = {
        status: "healthy",
        message: statusRes.value?.data?.message || "OK",
      };
    } else {
      providerHealth = {
        status: "down",
        message: statusRes.reason?.providerMessage || statusRes.reason?.message || "API unreachable",
      };
    }

    if (catalogRes.status === "fulfilled") {
      catalog = catalogRes.value;
    }

    if (balanceRes.status === "fulfilled") {
      capabilities.balanceEnabled = true;
      balances = normalizeBalanceEntries(balanceRes.value?.data, catalog.byCode);
    } else {
      balanceError = balanceRes.reason?.providerMessage || balanceRes.reason?.message || "Custody balance unavailable";
    }

    if (config.hasCustodyAuth) {
      const [convRes, payoutRes] = await Promise.allSettled([
        client.listConversions({ limit: 5, offset: 0, order: "DESC" }),
        client.listPayouts({ limit: 5, page: 0 }),
      ]);

      if (convRes.status === "fulfilled") {
        capabilities.conversionsEnabled = true;
        capabilities.paymentListingEnabled = true;
        const list = Array.isArray(convRes.value?.data?.result)
          ? convRes.value.data.result
          : Array.isArray(convRes.value?.data?.conversions)
            ? convRes.value.data.conversions
            : Array.isArray(convRes.value?.data)
              ? convRes.value.data
              : [];
        recentConversions = list.map(normalizeConversionItem).filter(Boolean).slice(0, 5);
      } else {
        conversionsError = convRes.reason?.providerMessage || convRes.reason?.message || "Conversions unavailable";
      }

      if (payoutRes.status === "fulfilled") {
        capabilities.payoutsEnabled = true;
        const list = Array.isArray(payoutRes.value?.data?.withdrawals)
          ? payoutRes.value.data.withdrawals
          : Array.isArray(payoutRes.value?.data?.result)
            ? payoutRes.value.data.result
            : Array.isArray(payoutRes.value?.data)
              ? payoutRes.value.data
              : [];
        recentPayouts = list.map((item) => normalizePayoutItem(item, catalog.byCode)).filter(Boolean).slice(0, 5);
      } else {
        payoutsError = payoutRes.reason?.providerMessage || payoutRes.reason?.message || "Payouts unavailable";
      }
    }
  }

  let localSummary = {
    finishedCount: 0,
    finishedToman: 0,
    pendingCount: 0,
    recoveryRequiredCount: 0,
    underpaidCount: 0,
  };
  let recentDeposits = [];
  let reconciliationWarnings = [];

  if (invoiceModel && typeof invoiceModel.find === "function") {
    try {
      const docs = await Promise.resolve(invoiceModel.find({})).then((res) =>
        Array.isArray(res) ? res : typeof res?.lean === "function" ? res.lean() : [],
      );
      const sorted = [...docs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      for (const doc of sorted) {
        if (doc.status === "finished" && doc.balanceCredited) {
          localSummary.finishedCount += 1;
          localSummary.finishedToman += Number(doc.amountToman || 0);
        } else if (["creating", "pending", "waiting", "confirming", "confirmed", "sending"].includes(doc.status)) {
          localSummary.pendingCount += 1;
        }
        if (doc.recoveryStatus === "required") {
          localSummary.recoveryRequiredCount += 1;
        }
        if (doc.status === "partially_paid" || (doc.underpaidAmount != null && doc.underpaidAmount > 0)) {
          localSummary.underpaidCount += 1;
        }
      }
      recentDeposits = sorted.slice(0, 8).map(normalizeLocalInvoiceItem);
      reconciliationWarnings = sorted
        .filter((doc) => doc.recoveryStatus === "required" || doc.status === "partially_paid" || doc.status === "creation_unknown")
        .slice(0, 10)
        .map((doc) => ({
          orderId: doc.orderId,
          invoiceId: doc.invoiceId || null,
          paymentId: doc.paymentId || null,
          userId: String(doc.userId),
          status: doc.status,
          payCurrency: doc.payCurrency,
          amountToman: doc.amountToman,
          reason: doc.recoveryReason || doc.status,
          updatedAt: doc.updatedAt || doc.createdAt,
        }));
    } catch {
      // Non-fatal if DB is disconnected in unit test mode
    }
  }

  const nonZeroBalances = balances.filter((b) => (b.availableAmount || 0) > 0 || (b.pendingAmount || 0) > 0);

  return {
    lastSyncedAt: new Date(currentNow).toISOString(),
    providerHealth,
    capabilities,
    capabilityMatrix: NOWPAYMENTS_CAPABILITY_MATRIX,
    balances: nonZeroBalances.length > 0 ? nonZeroBalances : balances.slice(0, 12),
    totalTrackedAssets: balances.length,
    catalogAssetsCount: catalog.assets.length,
    catalogGroupsCount: catalog.groups.length,
    balanceError,
    recentConversions,
    conversionsError,
    recentPayouts,
    payoutsError,
    localSummary,
    recentDeposits,
    reconciliationWarnings,
  };
}

export async function getCustodyAssets({
  actorId,
  query = {},
  env = process.env,
  request = null,
  client: injectedClient = null,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePageParams(query, { defaultPageSize: 20, maxPageSize: 100 });
  const search = parseSearchTerm(query.search).toLowerCase();
  const networkFilter = String(query.network || "all").trim().toUpperCase();
  const filter = String(query.filter || "all").trim().toLowerCase();
  const forceRefresh = query.refresh === "true" || query.refresh === true;

  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, now });
  const { client, config } = buildClientFromEnv(resolved);
  if (!client || !config) {
    return {
      items: [],
      networks: [],
      total: 0,
      page: 1,
      pages: 1,
      balanceAvailable: false,
      lastSyncedAt: new Date(typeof resolved.now === "function" ? resolved.now() : Number(resolved.now)).toISOString(),
    };
  }

  const [catalogRes, balanceRes] = await Promise.allSettled([
    fetchNowPaymentsCatalog({ env: resolved.env, client, forceRefresh, now: resolved.now }),
    client.getBalance(),
  ]);

  const catalog = catalogRes.status === "fulfilled"
    ? catalogRes.value
    : { assets: [], groups: [], byCode: {}, fetchedAt: Date.now() };
  const rawBalances = balanceRes.status === "fulfilled" ? balanceRes.value?.data : null;
  const balanceEntries = normalizeBalanceEntries(rawBalances, catalog.byCode);
  const balanceByCode = new Map(balanceEntries.map((item) => [item.code, item]));

  const allCodes = new Set([
    ...catalog.assets.map((a) => a.code),
    ...balanceEntries.map((b) => b.code),
  ]);

  const merged = [];
  const networksSet = new Set();
  const isOwner = isOwnerUser(actorId);

  for (const code of allCodes) {
    const asset = catalog.byCode[code] || null;
    const bal = balanceByCode.get(code) || null;
    const network = asset?.network || bal?.network || code.toUpperCase();
    networksSet.add(network);
    const availableAmount = bal ? bal.availableAmount : null;
    const pendingAmount = bal ? bal.pendingAmount : null;
    const hasBalance = (availableAmount != null && availableAmount > 0) || (pendingAmount != null && pendingAmount > 0);

    merged.push({
      code,
      ticker: asset?.ticker || bal?.ticker || code.toUpperCase(),
      name: asset?.name || bal?.name || code.toUpperCase(),
      network,
      enable: asset ? Boolean(asset.enable) : true,
      fixedRateSupported: Boolean(asset?.fixedRateSupported),
      extraIdExists: Boolean(asset?.extraIdExists),
      networkPrecision: asset?.networkPrecision ?? bal?.networkPrecision ?? 8,
      minAmount: asset?.minAmount ?? null,
      availableAmount,
      availableDisplay: bal ? bal.availableDisplay : null,
      pendingAmount,
      pendingDisplay: bal ? bal.pendingDisplay : null,
      hasBalance,
      lastUpdatedAt: new Date(catalog.fetchedAt || Date.now()).toISOString(),
      supportedActions: {
        acceptPayment: asset ? Boolean(asset.enable) : false,
        convert: Boolean(isOwner && config.hasCustodyAuth && availableAmount != null && availableAmount > 0),
        withdraw: Boolean(isOwner && config.hasCustodyAuth && availableAmount != null && availableAmount > 0),
      },
    });
  }

  merged.sort((a, b) => {
    if (a.hasBalance !== b.hasBalance) return a.hasBalance ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  const filtered = merged.filter((item) => {
    if (networkFilter !== "ALL" && item.network !== networkFilter) return false;
    if (filter === "with-balance" && !item.hasBalance) return false;
    if (filter === "pending" && !(item.pendingAmount != null && item.pendingAmount > 0)) return false;
    if (filter === "fixed-rate" && !item.fixedRateSupported) return false;
    if (search) {
      const hay = `${item.code} ${item.ticker} ${item.name} ${item.network}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    networks: [...networksSet].sort(),
    total,
    page: safePage,
    pages,
    pageSize,
    balanceAvailable: balanceRes.status === "fulfilled",
    balanceError: balanceRes.status === "rejected"
      ? (balanceRes.reason?.providerMessage || balanceRes.reason?.message || "Custody balance unavailable")
      : null,
    lastSyncedAt: new Date(catalog.fetchedAt || Date.now()).toISOString(),
  };
}

export async function getCustodyConversions({
  actorId,
  query = {},
  env = process.env,
  request = null,
  client: injectedClient = null,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePageParams(query, { defaultPageSize: 15, maxPageSize: 100 });
  const statusFilter = String(query.status || "all").trim().toLowerCase();
  const search = parseSearchTerm(query.search).toLowerCase();

  const { client, config } = buildClientFromEnv({ env, request, client: injectedClient, now });
  if (!client || !config?.hasCustodyAuth) {
    return {
      items: [],
      total: 0,
      page: 1,
      pages: 1,
      capabilityDisabled: true,
      capabilityReason: !config?.apiKey
        ? "NOWPAYMENTS_API_KEY is not configured."
        : "Custody conversions require NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD for JWT authentication.",
    };
  }

  let response;
  try {
    response = await client.listConversions({ limit: 100, offset: 0, order: "DESC" });
  } catch (error) {
    return {
      items: [],
      total: 0,
      page: 1,
      pages: 1,
      capabilityDisabled: true,
      capabilityReason: error?.providerMessage || error?.message || "Custody conversion listing is not enabled for this account.",
    };
  }

  const rawList = Array.isArray(response?.data?.result)
    ? response.data.result
    : Array.isArray(response?.data?.conversions)
      ? response.data.conversions
      : Array.isArray(response?.data)
        ? response.data
        : [];

  const normalized = rawList.map(normalizeConversionItem).filter(Boolean);
  const filtered = normalized.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (search) {
      const hay = `${item.id} ${item.fromCurrency} ${item.toCurrency} ${item.status}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    total,
    page: safePage,
    pages,
    pageSize,
    capabilityDisabled: false,
    knownStatuses: KNOWN_CONVERSION_STATUSES,
  };
}

export async function previewCustodyConversion({
  actorId,
  fromCurrency,
  toCurrency,
  amount,
  env = process.env,
  request = null,
  client: injectedClient = null,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const cleanFrom = normalizePayCurrency(fromCurrency);
  const cleanTo = normalizePayCurrency(toCurrency);
  const numericAmount = Number(amount);

  if (!cleanFrom || !cleanTo) {
    throw new AdminServiceError("Please select valid source and destination currencies.", {
      code: "invalid_currency",
    });
  }
  if (cleanFrom === cleanTo) {
    throw new AdminServiceError("Source and destination currencies must be different.", {
      code: "same_currency",
    });
  }
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new AdminServiceError("Conversion amount must be a positive number.", {
      code: "invalid_amount",
    });
  }

  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, now });
  const { client, config } = buildClientFromEnv(resolved);
  if (!client || !config) {
    throw new AdminServiceError("NOWPayments is not configured.", {
      status: 503,
      code: "not_configured",
    });
  }

  const catalog = await fetchNowPaymentsCatalog({ env: resolved.env, client, now: resolved.now });
  const sourceAsset = validateCatalogSelection(catalog, { payCurrency: cleanFrom });
  const destAsset = validateCatalogSelection(catalog, { payCurrency: cleanTo });

  let availableBalance = null;
  try {
    const balRes = await client.getBalance();
    const balances = normalizeBalanceEntries(balRes?.data, catalog.byCode);
    const match = balances.find((b) => b.code === cleanFrom);
    availableBalance = match ? match.availableAmount : 0;
  } catch {
    availableBalance = null;
  }

  if (availableBalance != null && compareDecimalAmounts(numericAmount, availableBalance) > 0) {
    throw new AdminServiceError(
      `Insufficient Custody balance for ${cleanFrom.toUpperCase()} (available: ${availableBalance}).`,
      { code: "insufficient_custody_balance" },
    );
  }

  let estimateRes;
  try {
    estimateRes = await client.getEstimate({
      amount: numericAmount,
      currencyFrom: cleanFrom,
      currencyTo: cleanTo,
    });
  } catch (error) {
    throw new AdminServiceError(
      error?.providerMessage || "Unable to fetch live conversion estimate from NOWPayments.",
      { status: 502, code: "estimate_unavailable" },
    );
  }

  const estimatedToAmount = Number(estimateRes?.data?.estimated_amount);
  if (!Number.isFinite(estimatedToAmount) || estimatedToAmount <= 0) {
    throw new AdminServiceError("NOWPayments returned an invalid conversion estimate.", {
      status: 502,
      code: "estimate_unavailable",
    });
  }

  return {
    fromCurrency: sourceAsset.code,
    fromTicker: sourceAsset.ticker,
    fromNetwork: sourceAsset.network,
    toCurrency: destAsset.code,
    toTicker: destAsset.ticker,
    toNetwork: destAsset.network,
    fromAmount: numericAmount,
    estimatedToAmount,
    impliedRate: Number((estimatedToAmount / numericAmount).toFixed(8)),
    availableBalance,
    previewedAt: new Date(typeof now === "function" ? now() : Number(now)).toISOString(),
  };
}

export async function executeCustodyConversion({
  actorId,
  operationId,
  fromCurrency,
  toCurrency,
  amount,
  reason,
  ipAddress = null,
  env = process.env,
  request = null,
  client: injectedClient = null,
  auditModel = undefined,
  now = Date.now,
} = {}) {
  const owner = assertOwnerActor(actorId);
  const cleanReason = requireReason(reason);
  const preview = await previewCustodyConversion({
    actorId: owner,
    fromCurrency,
    toCurrency,
    amount,
    env,
    request,
    client: injectedClient,
    now,
  });

  const { client, config } = buildClientFromEnv({ env, request, client: injectedClient, now });
  if (!config?.hasCustodyAuth) {
    throw new AdminServiceError(
      "Custody conversion requires NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD.",
      { status: 503, code: "custody_auth_not_configured" },
    );
  }

  const audited = await runAuditedAction({
    actorTelegramId: owner,
    operationId,
    action: "NOWPAYMENTS_CONVERSION_CREATE",
    targetType: "custody_conversion",
    targetId: `${preview.fromCurrency}->${preview.toCurrency}`,
    ipAddress,
    auditModel: auditModel || resolveCustodyOptions().auditModel,
    metadata: {
      reason: cleanReason,
      fromCurrency: preview.fromCurrency,
      toCurrency: preview.toCurrency,
      fromAmount: preview.fromAmount,
      estimatedToAmount: preview.estimatedToAmount,
    },
    execute: async () => {
      const response = await client.createConversion({
        amount: preview.fromAmount,
        fromCurrency: preview.fromCurrency,
        toCurrency: preview.toCurrency,
      });
      const resultObj = response?.data?.result || response?.data || {};
      const conversion = normalizeConversionItem({
        ...resultObj,
        from_currency: resultObj.from_currency || preview.fromCurrency,
        to_currency: resultObj.to_currency || preview.toCurrency,
        from_amount: resultObj.from_amount ?? preview.fromAmount,
        to_amount: resultObj.to_amount ?? preview.estimatedToAmount,
      });
      return {
        conversion,
        auditSummary: {
          conversionId: conversion?.id,
          status: conversion?.status,
          fromCurrency: conversion?.fromCurrency,
          toCurrency: conversion?.toCurrency,
          fromAmount: conversion?.fromAmount,
          toAmount: conversion?.toAmount,
        },
      };
    },
  });
  return audited.result?.conversion || audited.result;
}

export async function getCustodyPayouts({
  actorId,
  query = {},
  env = process.env,
  request = null,
  client: injectedClient = null,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePageParams(query, { defaultPageSize: 15, maxPageSize: 100 });
  const statusFilter = String(query.status || "all").trim().toLowerCase();
  const currencyFilter = normalizePayCurrency(query.currency) || "";
  const search = parseSearchTerm(query.search).toLowerCase();

  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, now });
  const { client, config } = buildClientFromEnv(resolved);
  if (!client || !config?.hasCustodyAuth) {
    return {
      items: [],
      total: 0,
      page: 1,
      pages: 1,
      capabilityDisabled: true,
      capabilityReason: !config?.apiKey
        ? "NOWPAYMENTS_API_KEY is not configured."
        : "Custody payouts require NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD for JWT authentication.",
    };
  }

  let catalog = { byCode: {} };
  try {
    catalog = await fetchNowPaymentsCatalog({ env: resolved.env, client, now: resolved.now });
  } catch {
    // non-fatal
  }

  let response;
  try {
    response = await client.listPayouts({
      status: statusFilter !== "all" ? statusFilter : undefined,
      limit: 100,
      page: 0,
    });
  } catch (error) {
    return {
      items: [],
      total: 0,
      page: 1,
      pages: 1,
      capabilityDisabled: true,
      capabilityReason: error?.providerMessage || error?.message || "Custody payouts are not enabled for this account.",
    };
  }

  const rawList = Array.isArray(response?.data?.withdrawals)
    ? response.data.withdrawals
    : Array.isArray(response?.data?.result)
      ? response.data.result
      : Array.isArray(response?.data)
        ? response.data
        : [];

  const normalized = rawList.map((item) => normalizePayoutItem(item, catalog.byCode)).filter(Boolean);
  const filtered = normalized.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (currencyFilter && item.currency !== currencyFilter) return false;
    if (search) {
      const hay = `${item.id} ${item.batchWithdrawalId || ""} ${item.currency} ${item.address} ${item.hash || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    total,
    page: safePage,
    pages,
    pageSize,
    capabilityDisabled: false,
    knownStatuses: KNOWN_PAYOUT_STATUSES,
  };
}

export async function validateCustodyPayoutAddress({
  actorId,
  currency,
  address,
  extraId = null,
  env = process.env,
  request = null,
  client: injectedClient = null,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const cleanCurrency = normalizePayCurrency(currency);
  const cleanAddress = String(address || "").trim();
  const cleanExtraId = extraId != null && String(extraId).trim() ? String(extraId).trim() : null;

  if (!cleanCurrency) {
    throw new AdminServiceError("Please select a valid payout currency.", { code: "invalid_currency" });
  }
  if (!cleanAddress || cleanAddress.length < 10 || cleanAddress.length > 160 || /\s/.test(cleanAddress)) {
    throw new AdminServiceError("Destination wallet address is malformed.", { code: "invalid_address" });
  }

  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, now });
  const { client, config } = buildClientFromEnv(resolved);
  if (!client || !config) {
    throw new AdminServiceError("NOWPayments is not configured.", { status: 503, code: "not_configured" });
  }

  const catalog = await fetchNowPaymentsCatalog({ env: resolved.env, client, now: resolved.now });
  const asset = validateCatalogSelection(catalog, { payCurrency: cleanCurrency });

  if (asset.walletRegex) {
    try {
      const regex = new RegExp(asset.walletRegex);
      if (!regex.test(cleanAddress)) {
        throw new AdminServiceError(
          `Address does not match the required format for ${asset.ticker} (${asset.network}).`,
          { code: "address_regex_mismatch" },
        );
      }
    } catch (error) {
      if (error instanceof AdminServiceError) throw error;
    }
  }

  try {
    await client.validatePayoutAddress({
      address: cleanAddress,
      currency: asset.code,
      extraId: cleanExtraId,
    });
  } catch (error) {
    throw new AdminServiceError(
      error?.providerMessage || `NOWPayments rejected destination address for ${asset.ticker} (${asset.network}).`,
      { status: 400, code: "invalid_address" },
    );
  }

  return {
    valid: true,
    currency: asset.code,
    ticker: asset.ticker,
    network: asset.network,
    address: cleanAddress,
    extraId: cleanExtraId,
  };
}

export async function estimateCustodyPayoutFee({
  actorId,
  currency,
  amount,
  env = process.env,
  request = null,
  client: injectedClient = null,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const cleanCurrency = normalizePayCurrency(currency);
  const numericAmount = Number(amount);

  if (!cleanCurrency) {
    throw new AdminServiceError("Please select a valid payout currency.", { code: "invalid_currency" });
  }
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new AdminServiceError("Withdrawal amount must be a positive number.", { code: "invalid_amount" });
  }

  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, now });
  const { client, config } = buildClientFromEnv(resolved);
  if (!client || !config) {
    throw new AdminServiceError("NOWPayments is not configured.", { status: 503, code: "not_configured" });
  }

  const catalog = await fetchNowPaymentsCatalog({ env: resolved.env, client, now: resolved.now });
  const asset = validateCatalogSelection(catalog, { payCurrency: cleanCurrency });

  let fee = null;
  try {
    const feeRes = await client.getPayoutFee({ currency: asset.code, amount: numericAmount });
    const rawFee = Number(feeRes?.data?.fee);
    if (Number.isFinite(rawFee) && rawFee >= 0) {
      fee = rawFee;
    }
  } catch (error) {
    throw new AdminServiceError(
      error?.providerMessage || "Unable to fetch payout fee estimate from NOWPayments.",
      { status: 502, code: "fee_unavailable" },
    );
  }

  return {
    currency: asset.code,
    ticker: asset.ticker,
    network: asset.network,
    amount: numericAmount,
    fee,
    minAmount: asset.minAmount ?? null,
    estimatedTotalDebit: fee != null ? Number((numericAmount + fee).toFixed(8)) : numericAmount,
  };
}

export async function createCustodyPayout({
  actorId,
  operationId,
  currency,
  address,
  amount,
  extraId = null,
  reason,
  ipAddress = null,
  env = process.env,
  request = null,
  client: injectedClient = null,
  auditModel = undefined,
  now = Date.now,
} = {}) {
  const owner = assertOwnerActor(actorId);
  const cleanReason = requireReason(reason);
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new AdminServiceError("Withdrawal amount must be a positive number.", { code: "invalid_amount" });
  }

  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, now });
  const validated = await validateCustodyPayoutAddress({
    actorId: owner,
    currency,
    address,
    extraId,
    env: resolved.env,
    request: resolved.request,
    client: resolved.client,
    now: resolved.now,
  });

  const { client, config } = buildClientFromEnv(resolved);
  if (!config?.hasCustodyAuth) {
    throw new AdminServiceError(
      "Custody payouts require NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD.",
      { status: 503, code: "custody_auth_not_configured" },
    );
  }

  const catalog = await fetchNowPaymentsCatalog({ env: resolved.env, client, now: resolved.now });
  const asset = catalog.byCode[validated.currency];
  if (asset?.minAmount != null && compareDecimalAmounts(numericAmount, asset.minAmount) < 0) {
    throw new AdminServiceError(
      `Amount is below minimum withdrawal limit (${asset.minAmount} ${asset.ticker}).`,
      { code: "below_min_amount" },
    );
  }

  let availableBalance = null;
  try {
    const balRes = await client.getBalance();
    const balances = normalizeBalanceEntries(balRes?.data, catalog.byCode);
    const match = balances.find((b) => b.code === validated.currency);
    availableBalance = match ? match.availableAmount : 0;
  } catch {
    availableBalance = null;
  }

  if (availableBalance != null && compareDecimalAmounts(numericAmount, availableBalance) > 0) {
    throw new AdminServiceError(
      `Insufficient Custody balance for ${validated.ticker} (available: ${availableBalance}).`,
      { code: "insufficient_custody_balance" },
    );
  }

  const audited = await runAuditedAction({
    actorTelegramId: owner,
    operationId,
    action: "NOWPAYMENTS_PAYOUT_CREATE",
    targetType: "custody_payout",
    targetId: `${validated.currency}:${validated.address.slice(0, 18)}`,
    ipAddress,
    auditModel: auditModel || resolveCustodyOptions().auditModel,
    metadata: {
      reason: cleanReason,
      currency: validated.currency,
      network: validated.network,
      address: validated.address,
      amount: numericAmount,
      extraId: validated.extraId,
    },
    execute: async () => {
      const response = await client.createPayout({
        withdrawals: [
          {
            address: validated.address,
            currency: validated.currency,
            amount: numericAmount,
            ...(validated.extraId ? { extra_id: validated.extraId } : {}),
            unique_external_id: operationId,
          },
        ],
      });
      const batchId = response?.data?.id ? String(response.data.id) : null;
      const firstWithdrawal = Array.isArray(response?.data?.withdrawals)
        ? response.data.withdrawals[0]
        : response?.data;
      const payout = normalizePayoutItem(
        {
          ...firstWithdrawal,
          batch_withdrawal_id: firstWithdrawal?.batch_withdrawal_id || batchId,
          currency: firstWithdrawal?.currency || validated.currency,
          address: firstWithdrawal?.address || validated.address,
          amount: firstWithdrawal?.amount ?? numericAmount,
        },
        catalog.byCode,
      );
      return {
        payout,
        auditSummary: {
          payoutId: payout?.id,
          batchWithdrawalId: payout?.batchWithdrawalId || batchId,
          status: payout?.status,
          currency: payout?.currency,
          amount: payout?.amount,
        },
      };
    },
  });
  return audited.result?.payout || audited.result;
}

export async function verifyCustodyPayout({
  actorId,
  operationId,
  batchWithdrawalId,
  verificationCode,
  reason,
  ipAddress = null,
  env = process.env,
  request = null,
  client: injectedClient = null,
  auditModel = undefined,
  now = Date.now,
} = {}) {
  const owner = assertOwnerActor(actorId);
  const cleanBatchId = String(batchWithdrawalId || "").trim();
  const cleanCode = String(verificationCode || "").trim();
  const cleanReason = requireReason(reason || "2FA verification for NOWPayments batch payout");

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cleanBatchId)) {
    throw new AdminServiceError("Batch withdrawal ID is invalid.", { code: "invalid_batch_id" });
  }
  if (!/^[A-Za-z0-9]{4,12}$/.test(cleanCode)) {
    throw new AdminServiceError("Verification code must be 4–12 alphanumeric characters.", {
      code: "invalid_verification_code",
    });
  }

  const { client, config } = buildClientFromEnv({ env, request, client: injectedClient, now });
  if (!client || !config?.hasCustodyAuth) {
    throw new AdminServiceError("NOWPayments Custody JWT credentials are not configured.", {
      status: 503,
      code: "custody_auth_not_configured",
    });
  }

  const audited = await runAuditedAction({
    actorTelegramId: owner,
    operationId,
    action: "NOWPAYMENTS_PAYOUT_VERIFY",
    targetType: "custody_payout",
    targetId: cleanBatchId,
    ipAddress,
    auditModel: auditModel || resolveCustodyOptions().auditModel,
    metadata: { batchWithdrawalId: cleanBatchId, reason: cleanReason },
    execute: async () => {
      const response = await client.verifyPayout({
        batchWithdrawalId: cleanBatchId,
        verificationCode: cleanCode,
      });
      return {
        batchWithdrawalId: cleanBatchId,
        verified: true,
        providerResult: response?.data || { status: "verified" },
        auditSummary: { batchWithdrawalId: cleanBatchId, verified: true },
      };
    },
  });
  return audited.result;
}

export async function getCustodyTransactions({
  actorId,
  query = {},
  invoiceModel,
} = {}) {
  assertAdminUser(actorId);
  invoiceModel = resolveCustodyOptions({ invoiceModel }).invoiceModel;
  const { page, pageSize } = parsePageParams(query, { defaultPageSize: 15, maxPageSize: 100 });
  const statusFilter = String(query.status || "all").trim().toLowerCase();
  const currencyFilter = normalizePayCurrency(query.currency) || "";
  const search = parseSearchTerm(query.search).toLowerCase();

  let docs = [];
  if (invoiceModel && typeof invoiceModel.find === "function") {
    docs = await Promise.resolve(invoiceModel.find({})).then((res) =>
      Array.isArray(res) ? res : typeof res?.lean === "function" ? res.lean() : [],
    );
  }

  const items = docs
    .map(normalizeLocalInvoiceItem)
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .filter((item) => {
      if (statusFilter === "recovery-required") {
        if (item.recoveryStatus !== "required") return false;
      } else if (statusFilter === "underpaid") {
        if (item.status !== "partially_paid" && !(item.underpaidAmount > 0)) return false;
      } else if (statusFilter === "overpaid") {
        if (!(item.overpaidAmount > 0)) return false;
      } else if (statusFilter !== "all" && item.status !== statusFilter) {
        return false;
      }
      if (currencyFilter && item.payCurrency !== currencyFilter) return false;
      if (search) {
        const hay = `${item.orderId} ${item.invoiceId || ""} ${item.paymentId || ""} ${item.userId} ${item.payCurrency} ${item.ticker} ${item.network}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    total,
    page: safePage,
    pages,
    pageSize,
    knownStatuses: KNOWN_PAYMENT_STATUSES,
  };
}

/**
 * Read-only reconciliation inspection: compares local NOWPayments invoices
 * against live provider payment records without mutating user balances.
 */
export async function reconcileNowPaymentsRecords({
  actorId,
  orderId = null,
  limit = 20,
  env,
  request = null,
  client: injectedClient = null,
  invoiceModel,
  now,
} = {}) {
  assertAdminUser(actorId);
  const resolved = resolveCustodyOptions({ env, request, client: injectedClient, invoiceModel, now });
  invoiceModel = resolved.invoiceModel;
  now = resolved.now;
  const { client, config } = buildClientFromEnv(resolved);
  if (!client || !config) {
    throw new AdminServiceError("NOWPayments is not configured.", { status: 503, code: "not_configured" });
  }

  let docs = [];
  if (invoiceModel && typeof invoiceModel.find === "function") {
    const filter = orderId ? { orderId: String(orderId).trim() } : {};
    docs = await Promise.resolve(invoiceModel.find(filter)).then((res) =>
      Array.isArray(res) ? res : typeof res?.lean === "function" ? res.lean() : [],
    );
  }

  const candidates = docs
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, Math.min(50, Math.max(1, Number(limit) || 20)));

  const findings = [];
  for (const doc of candidates) {
    if (!doc.paymentId) {
      if (doc.status === "creation_unknown" || doc.recoveryStatus === "required") {
        findings.push({
          orderId: doc.orderId,
          invoiceId: doc.invoiceId || null,
          paymentId: null,
          userId: String(doc.userId),
          amountToman: doc.amountToman,
          payCurrency: doc.payCurrency,
          localStatus: doc.status,
          providerStatus: null,
          balanceCredited: Boolean(doc.balanceCredited),
          classification: "missing_provider_payment_id",
          severity: "warning",
          detail: doc.recoveryReason || "Invoice has no payment_id bound yet.",
          correctiveActionKey: `nowpayments:${doc.orderId}`,
        });
      }
      continue;
    }

    try {
      const statusRes = await client.getPaymentStatus(doc.paymentId);
      const remote = statusRes?.data || {};
      const remoteStatus = String(remote.payment_status || "").trim().toLowerCase();
      const remotePaid = Number(remote.actually_paid ?? 0);
      const remotePayAmount = Number(remote.pay_amount ?? doc.payAmount ?? 0);

      let classification = "in_sync";
      let severity = "ok";
      let detail = "Local invoice matches NOWPayments provider state.";

      if (remoteStatus === "finished" && !doc.balanceCredited) {
        classification = "uncredited_finished";
        severity = "critical";
        detail = "Provider reports finished payment, but local wallet has not been credited yet.";
      } else if (remoteStatus === "partially_paid" || (remotePayAmount > 0 && remotePaid > 0 && remotePaid + 1e-8 < remotePayAmount)) {
        classification = "underpaid";
        severity = "warning";
        detail = `Underpaid: paid ${remotePaid} of ${remotePayAmount} ${doc.payCurrency.toUpperCase()}.`;
      } else if (remotePayAmount > 0 && remotePaid > remotePayAmount + 1e-8) {
        classification = "overpaid";
        severity = "info";
        detail = `Overpaid: paid ${remotePaid} vs expected ${remotePayAmount} ${doc.payCurrency.toUpperCase()}.`;
      } else if (remoteStatus === "refunded" && doc.balanceCredited) {
        classification = "refunded_after_credit";
        severity = "critical";
        detail = "Provider reports refunded payment after wallet credit; manual ledger review required.";
      } else if (remoteStatus && remoteStatus !== doc.status) {
        classification = "status_drift";
        severity = "warning";
        detail = `Local status is '${doc.status}' while provider reports '${remoteStatus}'.`;
      }

      findings.push({
        orderId: doc.orderId,
        invoiceId: doc.invoiceId || remote.invoice_id || null,
        paymentId: String(doc.paymentId),
        userId: String(doc.userId),
        amountToman: doc.amountToman,
        payCurrency: doc.payCurrency,
        localStatus: doc.status,
        providerStatus: remoteStatus || null,
        payAmount: remotePayAmount || null,
        actuallyPaid: Number.isFinite(remotePaid) ? remotePaid : null,
        balanceCredited: Boolean(doc.balanceCredited),
        classification,
        severity,
        detail,
        correctiveActionKey: `nowpayments:${doc.orderId}`,
      });
    } catch (error) {
      findings.push({
        orderId: doc.orderId,
        invoiceId: doc.invoiceId || null,
        paymentId: String(doc.paymentId),
        userId: String(doc.userId),
        amountToman: doc.amountToman,
        payCurrency: doc.payCurrency,
        localStatus: doc.status,
        providerStatus: null,
        balanceCredited: Boolean(doc.balanceCredited),
        classification: "provider_lookup_failed",
        severity: "warning",
        detail: error?.providerMessage || error?.message || "Failed to fetch payment status from NOWPayments.",
        correctiveActionKey: `nowpayments:${doc.orderId}`,
      });
    }
  }

  return {
    checkedAt: new Date(typeof now === "function" ? now() : Number(now)).toISOString(),
    checkedCount: candidates.length,
    discrepancyCount: findings.filter((f) => f.classification !== "in_sync").length,
    findings,
  };
}
