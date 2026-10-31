/**
 * Loads everything one customer's money touches, through the read-only sources only, as plain normalized values.
 *
 * ORDER MATTERS: the User document is read LAST. Every writer stores the ledger key first and the record flag after it
 * (credit, then balanceCredited; refund, then status), so if a record says "applied", a later read of the User must show
 * the key. Reading the other way round would report a credit that happened between the two reads as a missing key.
 *
 * Only named fields are selected. Card details, payment addresses, service links, receipts and provider payloads never
 * enter this module, so they cannot reach a finding, a log line or a browser.
 */
import { PAYMENT_PROVIDERS } from "./constants.js";
import { defaultSources } from "./readOnly.js";
import { wholeToman } from "./ledger.js";

const QUERY_TIMEOUT_MS = 8_000;
export const ROW_LIMIT = 4_000;

const PAYMENT_FIELDS = {
  hooshpay: "uid orderId userId amount status creationStatus trackingCode fulfilled fulfilledAt balanceCredited balanceCreditedAt creditLedgerVersion recoveryStatus recoveryReason createdAt paidAt reversedAt expiresAt retryCount lastErrorCode webhookLog.receivedAt webhookLog.payload.status",
  nowpayments: "orderId invoiceId paymentId userId amountToman status providerStatus balanceCredited balanceCreditedAt creditLedgerVersion recoveryStatus recoveryReason createdAt updatedAt paidAt priceAmountCents priceCurrency payCurrency payAmount actuallyPaid underpaidAmount overpaidAmount planId retryCount lastErrorCode ipnLog.receivedAt ipnLog.paymentStatus",
  bank: "paymentId userId amount paymentType status trackingCode balanceCredited balanceCreditedAt creditLedgerVersion recoveryStatus recoveryReason createdAt confirmedAt rejectedAt confirmedBy retryCount lastErrorCode",
  trx: "invoiceId userId amount paymentType status transactionHash balanceCredited balanceCreditedAt creditLedgerVersion recoveryStatus recoveryReason createdAt confirmedAt rejectedAt retryCount lastErrorCode",
};
const ORDER_FIELDS = "purchaseId telegramId planId planName gig days amount status walletDebitStatus walletDebitedAt reservedAt provisioningStartedAt serviceUsername provisionedAt completedAt errorCode retryCount recoveryStatus recoveryReason refundStatus refundAmount refundReason refundedAt refundRequestedAt awaitingProviderSince events createdAt";
const USER_FIELDS = "telegramId balance successfulPayments appliedPaymentKeys appliedAdminBalanceKeys appliedPurchaseReservations refundedPurchaseIds completedPurchaseIds services.purchaseId services.username services.productId testServiceAttemptId createdAt";
const AUDIT_FIELDS = "operationId action status targetId actorTelegramId metadata.amount metadata.direction createdAt completedAt errorCode";

const ms = (value) => (value ? new Date(value).getTime() : NaN);

function callbacks(provider, record) {
  if (provider === "hooshpay") return (record.webhookLog || []).map((item) => ({ at: item.receivedAt, status: String(item.payload?.status ?? "unknown").slice(0, 40) }));
  if (provider === "nowpayments") return (record.ipnLog || []).map((item) => ({ at: item.receivedAt, status: String(item.paymentStatus ?? "unknown").slice(0, 40) }));
  return [];
}

export function normalizePayment(provider, record) {
  const spec = PAYMENT_PROVIDERS[provider];
  const ref = record[spec.refField] == null ? null : String(record[spec.refField]);
  const fallbackRef = provider === "hooshpay" ? record.orderId : ref;
  const status = String(record.status ?? "unknown");
  return {
    provider,
    key: `${provider}:${ref ?? fallbackRef}`,
    ref: ref ?? fallbackRef,
    creditKey: ref ? `${provider}:${ref}` : null,
    userId: record[spec.ownerField] == null ? null : String(record[spec.ownerField]),
    amount: Number(record[spec.amountField]),
    status,
    confirmed: spec.confirmed.includes(status),
    reversed: spec.reversed.includes(status),
    credited: record.balanceCredited === true,
    creditedAt: record.balanceCreditedAt || null,
    confirmedAt: record.paidAt || record.confirmedAt || null,
    fulfilled: provider === "hooshpay" ? record.fulfilled === true : null,
    fulfilledAt: record.fulfilledAt || null,
    reversedAt: record.reversedAt || (provider === "nowpayments" && status === "refunded" ? record.updatedAt || null : null),
    rejectedAt: record.rejectedAt || null,
    ledgerVersion: record.creditLedgerVersion ?? null,
    creationStatus: record.creationStatus || null,
    trackingCode: record.trackingCode || null,
    transactionHash: record.transactionHash || null,
    invoiceId: provider === "nowpayments" ? record.invoiceId || null : null,
    paymentId: provider === "nowpayments" ? record.paymentId || null : null,
    payCurrency: record.payCurrency ? String(record.payCurrency) : null,
    payAmount: record.payAmount ?? null,
    actuallyPaid: record.actuallyPaid ?? null,
    planId: record.planId || null,
    recoveryStatus: record.recoveryStatus || "none",
    recoveryReason: record.recoveryReason || null,
    lastErrorCode: record.lastErrorCode || null,
    retryCount: Number(record.retryCount || 0),
    expiresAt: record.expiresAt || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    callbacks: callbacks(provider, record),
  };
}

export function normalizeOrder(record, config) {
  const createdAt = record.createdAt || null;
  return {
    key: `wallet:${record.purchaseId}`,
    purchaseId: String(record.purchaseId),
    userId: String(record.telegramId),
    planId: record.planId || null,
    planName: record.planName || null,
    gig: record.gig ?? null,
    days: record.days ?? null,
    amount: Number(record.amount),
    status: String(record.status ?? "unknown"),
    walletDebitStatus: record.walletDebitStatus || null,
    reservedAt: record.reservedAt || record.walletDebitedAt || null,
    provisioningStartedAt: record.provisioningStartedAt || null,
    serviceUsername: record.serviceUsername || null,
    provisionedAt: record.provisionedAt || null,
    completedAt: record.completedAt || null,
    errorCode: record.errorCode || null,
    retryCount: Number(record.retryCount || 0),
    recoveryStatus: record.recoveryStatus || "none",
    recoveryReason: record.recoveryReason || null,
    refundStatus: record.refundStatus || "none",
    refundAmount: record.refundAmount ?? null,
    refundReason: record.refundReason || null,
    refundedAt: record.refundedAt || null,
    refundRequestedAt: record.refundRequestedAt || null,
    awaitingProviderSince: record.awaitingProviderSince || null,
    events: (record.events || []).slice(-30).map((event) => ({ at: event.at || null, type: event.type || null, from: event.from || null, to: event.to || null })),
    createdAt,
    legacy: !(ms(createdAt) >= config.ledgerEpoch.getTime()),
  };
}

function normalizeAudit(row, config) {
  return {
    id: String(row._id),
    operationId: String(row.operationId),
    action: row.action,
    status: row.status,
    amount: wholeToman(row.metadata?.amount),
    direction: row.metadata?.direction === "add" || row.action === "USER_BALANCE_ADDED" ? "add" : row.metadata?.direction === "remove" || row.action === "USER_BALANCE_REMOVED" ? "remove" : null,
    userId: row.targetId == null ? null : String(row.targetId),
    actor: row.actorTelegramId == null ? null : String(row.actorTelegramId),
    createdAt: row.createdAt || null,
    legacy: !(ms(row.createdAt) >= config.ledgerEpoch.getTime()),
  };
}

function normalizeTombstone(row) {
  return {
    provider: row.provider,
    key: `${row.provider}:${row.uid || row.orderId}`,
    creditKeys: [row.uid ? `${row.provider}:${row.uid}` : null, row.orderId ? `${row.provider}:${row.orderId}` : null].filter(Boolean),
    userId: row.userId == null ? null : String(row.userId),
    amount: row.amountToman ?? null,
    finalStatus: row.finalStatus,
    createdAt: row.invoiceCreatedAt || row.createdAt || null,
    deletedAt: row.deletedAt || null,
    lateEvents: (row.lateEvents || []).map((event) => ({ at: event.receivedAt, status: event.status })),
  };
}

const timed = (query) => query.lean().maxTimeMS(QUERY_TIMEOUT_MS);
const emptyBundle = (userId) => ({ userId, user: null, payments: [], orders: [], audits: [], tombstones: [], foreignPayments: [], foreignOrders: [], foreignTracking: [], truncated: false });

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function loadRows(sources, userIds, config) {
  const numeric = userIds.map(Number).filter(Number.isSafeInteger);
  const paymentRows = await Promise.all(Object.keys(PAYMENT_PROVIDERS).map(async (provider) => ({
    provider,
    rows: await timed(sources[provider].find({ userId: { $in: numeric } }).select(PAYMENT_FIELDS[provider]).limit(ROW_LIMIT)),
  })));
  const [orderRows, adminRows, tombstoneRows] = await Promise.all([
    timed(sources.purchases.find({ telegramId: { $in: userIds } }).select(ORDER_FIELDS).limit(ROW_LIMIT)),
    timed(sources.audits.find({ targetType: "user", targetId: { $in: userIds }, action: { $in: ["USER_BALANCE_ADDED", "USER_BALANCE_REMOVED"] } }).select(AUDIT_FIELDS).limit(ROW_LIMIT)),
    timed(sources.tombstones.find({ userId: { $in: numeric } }).select("provider orderId uid userId amountToman finalStatus invoiceCreatedAt deletedAt lateEvents createdAt").limit(ROW_LIMIT)),
  ]);
  const hitLimit = paymentRows.some((entry) => entry.rows.length >= ROW_LIMIT) || orderRows.length >= ROW_LIMIT || adminRows.length >= ROW_LIMIT || tombstoneRows.length >= ROW_LIMIT;
  // Last on purpose: see the header.
  const users = await timed(sources.users.find({ telegramId: { $in: userIds } }).select(USER_FIELDS));
  return { paymentRows, orderRows, adminRows, tombstoneRows, users, hitLimit, config };
}

/** Ledger keys whose record was not among the customer's own rows: another owner's record, a tombstone, or nothing. */
async function resolveForeignKeys(sources, bundles, config) {
  const wanted = { hooshpay: new Map(), nowpayments: new Map(), bank: new Map(), trx: new Map() };
  const orderIds = new Map();
  const operationIds = new Map();
  for (const bundle of bundles) {
    const own = new Set(bundle.payments.map((payment) => payment.creditKey));
    for (const key of bundle.user?.appliedPaymentKeys || []) {
      const separator = String(key).indexOf(":");
      const provider = String(key).slice(0, separator);
      if (separator > 0 && wanted[provider] && !own.has(key)) wanted[provider].set(String(key).slice(separator + 1), bundle);
    }
    const ownOrders = new Set(bundle.orders.map((order) => order.purchaseId));
    for (const id of [...(bundle.user?.appliedPurchaseReservations || []), ...(bundle.user?.refundedPurchaseIds || [])]) {
      if (!ownOrders.has(String(id))) orderIds.set(String(id), bundle);
    }
    const ownAudits = new Set(bundle.audits.map((audit) => audit.operationId));
    for (const id of bundle.user?.appliedAdminBalanceKeys || []) {
      if (!ownAudits.has(String(id))) operationIds.set(String(id), bundle);
    }
  }
  for (const [provider, refs] of Object.entries(wanted)) {
    if (!refs.size) continue;
    const field = PAYMENT_PROVIDERS[provider].refField;
    const rows = await timed(sources[provider].find({ [field]: { $in: [...refs.keys()] } }).select(PAYMENT_FIELDS[provider]).limit(ROW_LIMIT));
    for (const row of rows) refs.get(String(row[field]))?.foreignPayments.push(normalizePayment(provider, row));
    const tombstones = await timed(sources.tombstones.find({ provider, [provider === "hooshpay" ? "uid" : "orderId"]: { $in: [...refs.keys()] } }).select("provider orderId uid userId amountToman finalStatus invoiceCreatedAt deletedAt lateEvents createdAt").limit(ROW_LIMIT));
    for (const row of tombstones) {
      const bundle = refs.get(String(provider === "hooshpay" ? row.uid : row.orderId));
      const item = normalizeTombstone(row);
      if (bundle && !bundle.tombstones.some((tombstone) => tombstone.key === item.key)) bundle.tombstones.push(item);
    }
  }
  if (orderIds.size) {
    const rows = await timed(sources.purchases.find({ purchaseId: { $in: [...orderIds.keys()] } }).select(ORDER_FIELDS).limit(ROW_LIMIT));
    for (const row of rows) orderIds.get(String(row.purchaseId))?.foreignOrders.push(normalizeOrder(row, config));
  }
  if (operationIds.size) {
    const rows = await timed(sources.audits.find({ operationId: { $in: [...operationIds.keys()] } }).select(AUDIT_FIELDS).limit(ROW_LIMIT));
    for (const row of rows) operationIds.get(String(row.operationId))?.audits.push(normalizeAudit(row, config));
  }
}

/** Other invoices carrying a HooshPay tracking code one of these customers' invoices also carries. */
async function resolveSharedTracking(sources, bundles) {
  const byCode = new Map();
  for (const bundle of bundles) {
    for (const payment of bundle.payments) {
      if (payment.provider === "hooshpay" && payment.trackingCode) byCode.set(payment.trackingCode, [...(byCode.get(payment.trackingCode) || []), bundle]);
    }
  }
  if (!byCode.size) return;
  const rows = await timed(sources.hooshpay.find({ trackingCode: { $in: [...byCode.keys()] } }).select(PAYMENT_FIELDS.hooshpay).limit(ROW_LIMIT));
  for (const row of rows) {
    const payment = normalizePayment("hooshpay", row);
    for (const bundle of byCode.get(payment.trackingCode) || []) {
      if (payment.userId !== bundle.userId && !bundle.foreignTracking.some((item) => item.key === payment.key)) bundle.foreignTracking.push(payment);
    }
  }
}

/**
 * Bundles for a list of Telegram IDs, in that order. A batch that hits the row limit is split until each customer has it
 * alone; a single customer beyond the limit is marked truncated, which keeps the reconstruction honest (coverage: partial).
 */
export async function loadBundles(userIds, { sources = defaultSources(), config, batchSize = 25 } = {}) {
  const unique = [...new Set(userIds.map(String))];
  const out = new Map();
  for (const ids of chunk(unique, batchSize)) {
    const { paymentRows, orderRows, adminRows, tombstoneRows, users, hitLimit } = await loadRows(sources, ids, config);
    if (hitLimit && ids.length > 1) {
      const middle = Math.ceil(ids.length / 2);
      for (const part of [ids.slice(0, middle), ids.slice(middle)]) {
        for (const [id, bundle] of await loadBundles(part, { sources, config, batchSize })) out.set(id, bundle);
      }
      continue;
    }
    const bundles = new Map(ids.map((id) => [id, { ...emptyBundle(id), truncated: hitLimit }]));
    for (const { provider, rows } of paymentRows) {
      for (const row of rows) bundles.get(String(row.userId))?.payments.push(normalizePayment(provider, row));
    }
    for (const row of orderRows) bundles.get(String(row.telegramId))?.orders.push(normalizeOrder(row, config));
    for (const row of adminRows) bundles.get(String(row.targetId))?.audits.push(normalizeAudit(row, config));
    for (const row of tombstoneRows) bundles.get(String(row.userId))?.tombstones.push(normalizeTombstone(row));
    for (const user of users) {
      const bundle = bundles.get(String(user.telegramId));
      if (bundle) bundle.user = user;
    }
    const list = [...bundles.values()];
    await resolveForeignKeys(sources, list, config);
    await resolveSharedTracking(sources, list);
    for (const bundle of list) out.set(bundle.userId, bundle);
  }
  return out;
}
