import { setSession } from "../config/sessionStore.js";
import invoice from "../models/invoice.js";
import User from "../models/User.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

const handleBankRecipt = async (bot, msg, session) => {
  const chatId = msg?.chat?.id;
  const user = msg?.from;
  const photos = Array.isArray(msg?.photo) ? msg.photo : [];
  const fileId = photos.at(-1)?.file_id;
  const groupId = process.env.GROUP_ID;
  const paymentId = session?.paymentId;
  if (!chatId || !user?.id || !fileId || typeof paymentId !== "string" || !groupId) {
    if (chatId) await bot.sendMessage(chatId, "❌ اطلاعات رسید کامل نیست. لطفاً فرایند پرداخت را دوباره شروع کنید.");
    return;
  }

  // Claim the receipt atomically and bind it to the submitting user. Replayed
  // photos cannot reopen or replace a receipt already under admin review.
  let claimed;
  try {
    claimed = await invoice.findOneAndUpdate(
      {
        paymentId,
        userId: Number(user.id),
        paymentType: "bank",
        status: "unpaid",
      },
      {
        $set: {
          status: "waiting_for_approval",
          receiptFileId: fileId,
          receiptSubmittedAt: new Date(),
        },
      },
      { new: true }
    );
  } catch (error) {
    console.error("Bank receipt claim failed:", error?.name || "DatabaseError");
    await bot.sendMessage(chatId, "❌ امکان ثبت رسید وجود ندارد. لطفاً دوباره تلاش کنید.");
    return;
  }
  if (!claimed) {
    await bot.sendMessage(chatId, "⚠️ این فاکتور پیدا نشد یا رسید آن قبلاً ارسال شده است.");
    return;
  }

  try {
    const dbUser = await User.findOne({ telegramId: String(user.id) }).select("phoneNumber").lean();
    const phoneNumber = dbUser?.phoneNumber ? String(dbUser.phoneNumber) : "نامشخص";
    const displayPhoneNumber = phoneNumber.startsWith("+98") ? `0${phoneNumber.slice(3)}` : phoneNumber;
    const amount = Number(claimed.amount).toLocaleString("en-US");
    const ltr = "\u202A";
    const pdf = "\u202C";

    await bot.sendPhoto(groupId, fileId, {
      caption:
        `🧾 <b>رسید جدید پرداخت</b>\n\n` +
        `👤 <b>نام کاربر:</b> <code>${escapeHtml(user.first_name || "نامشخص")}</code>\n` +
        `<b>آیدی عددی:</b> <code>${ltr}${escapeHtml(user.id)}${pdf}</code>\n` +
        `📎 <b>یوزرنیم:</b> @${escapeHtml(user.username || "ندارد")}\n` +
        `📞 <b>شماره تلفن:</b> <code>${escapeHtml(displayPhoneNumber)}</code>\n` +
        `💰 <b>مبلغ:</b> <code>${amount} تومان</code>\n` +
        `📌 <b>شماره فاکتور:</b> <code>${escapeHtml(paymentId)}</code>`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ تایید", callback_data: `confirm_payment_${paymentId}` },
          { text: "❌ رد", callback_data: `reject_payment_${paymentId}` },
        ]],
      },
    });
  } catch (error) {
    await invoice.findOneAndUpdate(
      { _id: claimed._id, status: "waiting_for_approval", balanceCredited: false },
      { $set: { status: "unpaid", receiptFileId: null, receiptSubmittedAt: null } }
    ).catch(() => {});
    console.error("Bank receipt delivery failed:", error?.name || "TelegramError");
    await bot.sendMessage(chatId, "❌ ارسال رسید به گروه بررسی انجام نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.");
    return;
  }

  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  await setSession(chatId, { ...session, step: "receipt_sent" });
  await bot.editMessageText("✅ رسید شما با موفقیت ارسال شد. منتظر تأیید توسط ادمین باشید.", {
    chat_id: chatId,
    message_id: session.messageId,
  }).catch(() => {});
};

export default handleBankRecipt;
