import invoice from "../../models/invoice.js";
import User from "../../models/User.js";
import { creditWalletOnce } from "../walletCredit.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function notifyUserOnce(payment, user, bot) {
  if (!payment.notificationPending || !bot?.sendMessage) return false;
  const now = new Date();
  const staleClaim = new Date(now.getTime() - 5 * 60_000);
  const claim = await invoice.findOneAndUpdate(
    {
      _id: payment._id,
      status: "confirmed",
      balanceCredited: true,
      notificationPending: true,
      $or: [
        { notificationClaimedAt: null },
        { notificationClaimedAt: { $lt: staleClaim } },
      ],
    },
    { $set: { notificationClaimedAt: now } },
    { new: true }
  );
  if (!claim) return false;

  try {
    const message =
      `✅ پرداخت شما تأیید شد!\n` +
      `💰 مبلغ ${Number(claim.amount).toLocaleString("en-US")} تومان به کیف پول شما اضافه شد.\n` +
      `💳 موجودی جدید: ${Number(user?.balance ?? 0).toLocaleString("en-US")} تومان`;
    await bot.sendMessage(String(claim.userId), message);
    await invoice.findOneAndUpdate(
      { _id: claim._id, notificationClaimedAt: now, notificationPending: true },
      { $set: { notificationPending: false, notifiedAt: new Date() }, $unset: { notificationClaimedAt: 1 } }
    );
    return true;
  } catch (error) {
    // Retain the claim for five minutes to avoid duplicates after ambiguous timeouts.
    console.warn("Bank confirmation notification failed:", error?.name || "TelegramError");
    return false;
  }
}

/**
 * Atomically approve a manual card-transfer invoice and credit its owner once.
 * The user ID and amount are always read from MongoDB, never callback_data.
 */
export async function confirmBankPayment({ paymentId, adminId, bot }) {
  if (typeof paymentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(paymentId)) {
    return { status: "invalid" };
  }

  let payment = await invoice.findOneAndUpdate(
    { paymentId, status: "waiting_for_approval", paymentType: "bank" },
    {
      $set: {
        status: "confirmed",
        confirmedAt: new Date(),
        confirmedBy: String(adminId),
        creditLedgerVersion: 2,
        notificationPending: true,
      },
    },
    { new: true }
  );
  const newlyClaimed = Boolean(payment);

  if (!payment) {
    payment = await invoice.findOne({
      paymentId,
      status: "confirmed",
      paymentType: "bank",
      creditLedgerVersion: 2,
      balanceCredited: false,
    });
    if (!payment) {
      const existing = await invoice.findOne({ paymentId }).select("status creditLedgerVersion balanceCredited").lean();
      if (existing?.status === "confirmed" && existing.creditLedgerVersion !== 2 && !existing.balanceCredited) {
        return { status: "manual_review" };
      }
      return { status: existing?.status === "confirmed" ? "already_confirmed" : "not_pending" };
    }
  }

  let credit;
  try {
    credit = await creditWalletOnce({
      telegramId: payment.userId,
      amount: Number(payment.amount),
      creditKey: `bank:${payment.paymentId}`,
    });
  } catch (error) {
    console.error("Bank wallet credit failed:", error?.name || "DatabaseError");
    throw new Error("Bank payment credit is temporarily unavailable");
  }

  if (!credit.user) {
    if (newlyClaimed) {
      await invoice.findOneAndUpdate(
        { _id: payment._id, status: "confirmed", balanceCredited: false },
        {
          $set: { status: "waiting_for_approval", confirmedAt: null, confirmedBy: null, notificationPending: false },
          $unset: { creditLedgerVersion: 1 },
        }
      );
    }
    return { status: "user_not_found" };
  }

  const finalized = await invoice.findOneAndUpdate(
    { _id: payment._id, status: "confirmed", creditLedgerVersion: 2, balanceCredited: false },
    { $set: { balanceCredited: true, balanceCreditedAt: new Date(), notificationPending: true } },
    { new: true }
  );
  if (finalized) {
    payment = finalized;
  } else {
    payment = await invoice.findById(payment._id);
    if (!payment?.balanceCredited) throw new Error("Bank wallet credit is durable but invoice completion is pending");
  }

  const notified = await notifyUserOnce(payment, credit.user, bot);
  return {
    status: credit.credited ? "credited" : "recovered",
    amount: Number(payment.amount),
    userId: Number(payment.userId),
    notified,
  };
}
