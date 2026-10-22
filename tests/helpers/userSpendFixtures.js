/**
 * Raw (schema-bypassing) fixtures for the persisted-spend tests: they write straight to the collections so a
 * fixture can have exactly the shape a test needs (missing counters, odd statuses, past completion times)
 * without going through any model hook.
 */
let sequence = 0;

export const NON_COMPLETED_STATUSES = Object.freeze([
  "reserving", "reserved", "provisioning", "uncertain", "provisioned", "refund_pending", "refunded", "failed", "manual_review",
]);

export function purchaseDoc(telegramId, fields = {}) {
  sequence += 1;
  const at = fields.completedAt === undefined ? new Date() : fields.completedAt;
  return {
    purchaseId: `spend-${process.pid}-${sequence}`,
    telegramId: String(telegramId),
    planId: "mini", planName: "Mini", gig: 5, days: 7, amount: 25_000,
    status: "completed", walletDebitStatus: "finalized", recoveryStatus: "none", revokedAt: null,
    createdAt: at || new Date(), completedAt: at,
    ...fields,
  };
}

export function userDoc(telegramId, fields = {}) {
  return {
    telegramId: String(telegramId), balance: 0, successfulPayments: 0, totalServices: 0,
    createdAt: new Date(), lastActivityAt: new Date(), isBanned: false, services: [],
    appliedPaymentKeys: [], appliedAdminBalanceKeys: [], appliedPurchaseReservations: [], refundedPurchaseIds: [], completedPurchaseIds: [],
    ...fields,
  };
}

export const insertPurchases = (WalletPurchase, docs) => (docs.length ? WalletPurchase.collection.insertMany(docs, { ordered: false }) : null);
export const insertUsers = (User, docs) => (docs.length ? User.collection.insertMany(docs, { ordered: false }) : null);

export const counters = async (User, telegramId) => {
  const user = await User.collection.findOne({ telegramId: String(telegramId) }, { projection: { totalSpent: 1, completedOrderCount: 1 } });
  return { totalSpent: user?.totalSpent, completedOrderCount: user?.completedOrderCount };
};

/** Ground truth computed independently of the module under test (plain find + JS sum). */
export async function truthByScan(WalletPurchase, telegramId) {
  const rows = await WalletPurchase.collection.find({ telegramId: String(telegramId), status: "completed" }).toArray();
  return { totalSpent: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0), completedOrderCount: rows.length };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
