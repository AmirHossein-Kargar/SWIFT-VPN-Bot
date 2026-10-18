import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "nowpayments-notify", level, message, ...meta }),
  );
}

/** Claim and deliver one durable NOWPayments credit notification. */
export async function notifyNowPaymentsCredit(orderId, bot, {
  invoiceModel = NowPaymentsInvoice,
  now = () => new Date(),
} = {}) {
  if (!bot?.sendMessage || typeof orderId !== "string") return false;
  const claimAt = now();
  const stale = new Date(claimAt.getTime() - 5 * 60_000);
  const claimed = await invoiceModel.findOneAndUpdate(
    {
      orderId,
      status: "finished",
      balanceCredited: true,
      notificationPending: true,
      $or: [
        { notificationClaimedAt: null },
        { notificationClaimedAt: { $lt: stale } },
      ],
    },
    { $set: { notificationClaimedAt: claimAt } },
    { new: true },
  );
  if (!claimed) return false;

  const amount = Number(claimed.amountToman).toLocaleString("en-US");
  try {
    await bot.sendMessage(
      claimed.userId,
      `✅ <b>پرداخت ترون تأیید شد.</b>\n\n💰 <b>مبلغ شارژ:</b> <code>${amount}</code> تومان`,
      { parse_mode: "HTML" },
    );
    await invoiceModel.updateOne(
      { _id: claimed._id, notificationPending: true, notificationClaimedAt: claimAt },
      {
        $set: { notificationPending: false, notifiedAt: now() },
        $unset: { notificationClaimedAt: 1 },
      },
    );
    return true;
  } catch (error) {
    // Keep the claim briefly: a Telegram timeout can mean the message was sent.
    log("warn", "Telegram credit notification failed; retry delayed", {
      orderId,
      errorType: error?.name || "TelegramError",
    });
    return false;
  }
}

export default notifyNowPaymentsCredit;
