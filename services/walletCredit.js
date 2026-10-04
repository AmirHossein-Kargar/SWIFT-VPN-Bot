import User from "../models/User.js";

/**
 * Atomically apply one wallet credit. The payment key and both balance counters
 * change in a single MongoDB document update, so retries after a lost response
 * are safe even when the caller's invoice flag has not yet been persisted.
 */
export async function creditWalletOnce({ telegramId, amount, creditKey, userModel = User }) {
  const normalizedId = String(telegramId ?? "").trim();
  if (!normalizedId || !/^\d+$/.test(normalizedId)) throw new TypeError("telegramId must be a numeric Telegram ID");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError("amount must be a positive safe integer");
  if (typeof creditKey !== "string" || creditKey.length < 1 || creditKey.length > 256) {
    throw new TypeError("creditKey must be a non-empty string of at most 256 characters");
  }

  const user = await userModel.findOneAndUpdate(
    {
      telegramId: normalizedId,
      appliedPaymentKeys: { $ne: creditKey },
    },
    {
      $inc: { balance: amount, successfulPayments: 1 },
      $addToSet: { appliedPaymentKeys: creditKey },
    },
    { new: true }
  );

  if (user) return { user, credited: true, alreadyCredited: false };

  const existing = await userModel.findOne({ telegramId: normalizedId })
    .select("_id balance successfulPayments appliedPaymentKeys")
    .lean();
  if (!existing) return { user: null, credited: false, alreadyCredited: false };
  if (Array.isArray(existing.appliedPaymentKeys) && existing.appliedPaymentKeys.includes(creditKey)) {
    return { user: existing, credited: false, alreadyCredited: true };
  }

  // Do not mistake an unexpected predicate mismatch for a successful credit.
  throw new Error("Wallet credit did not update the user and its idempotency key is absent");
}

/** Pure criteria/update factory for focused tests and auditability. */
export function walletCreditOperation({ telegramId, amount, creditKey }) {
  if (!String(telegramId ?? "").trim() || !/^\d+$/.test(String(telegramId))) {
    throw new TypeError("telegramId must be a numeric Telegram ID");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError("amount must be a positive safe integer");
  if (typeof creditKey !== "string" || creditKey.length < 1 || creditKey.length > 256) {
    throw new TypeError("creditKey must be a non-empty string of at most 256 characters");
  }
  return {
    filter: { telegramId: String(telegramId), appliedPaymentKeys: { $ne: creditKey } },
    update: {
      $inc: { balance: amount, successfulPayments: 1 },
      $addToSet: { appliedPaymentKeys: creditKey },
    },
  };
}
