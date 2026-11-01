import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { deleteService } from "../../api/wizardApi.js";
import { invalidateServiceStatus } from "../wizardServiceStatus.js";

const BACK = (username) => ({ inline_keyboard: [[{ text: "بازگشت", callback_data: `show_service_${username}` }]] });

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : "log"](JSON.stringify({ ts: new Date().toISOString(), service: "service-delete", level, message, ...meta }));
}

/**
 * Removes a deleted service from its owner and closes its order, in that order, repeatable after any partial failure.
 *
 * `totalServices` is recomputed from the array in the same update, because reading it first and writing it back loses a
 * concurrent purchase. The order keeps its money status and gains `revokedAt`: Sentinel and every count of live services tell a
 * deliberately removed service from one that was never delivered by that field.
 */
export async function recordServiceRemoval({ telegramId, username, actorId, userModel = User, purchaseModel = WalletPurchase }) {
  await userModel.updateOne(
    { telegramId, "services.username": username },
    [
      { $set: { services: { $filter: { input: "$services", cond: { $ne: ["$$this.username", username] } } } } },
      { $set: { totalServices: { $size: "$services" } } },
    ],
  );
  await purchaseModel.updateOne(
    { serviceUsername: username, telegramId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy: String(actorId) } },
  );
}

/**
 * The customer's delete. The local record goes only once the panel has confirmed: a refused or unanswered delete leaves the
 * service in the list, because the customer may still be connected through it and the panel is still billing it.
 *
 * What `delsv` refunds goes to the provider wallet of this bot, not to the customer; the confirmation screen says so.
 */
export async function deleteCustomerService(bot, { chatId, messageId, userId, username }) {
  const show = (text, options = {}) => bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
  try {
    await deleteService(username);
  } catch (error) {
    log("error", "Service deletion failed", { errorType: error?.name || "Error", code: typeof error?.code === "string" ? error.code : undefined, ambiguous: Boolean(error?.ambiguous) });
    invalidateServiceStatus(username);
    await show(error?.ambiguous
      ? "⚠️ نتیجهٔ حذف سرویس مشخص نشد. لطفاً پیش از تلاش دوباره، وضعیت سرویس را بررسی کنید."
      : "❌ حذف سرویس انجام نشد. کمی بعد دوباره تلاش کنید.", { reply_markup: BACK(username) });
    return;
  }

  invalidateServiceStatus(username);
  try {
    await recordServiceRemoval({ telegramId: String(userId), username, actorId: userId });
  } catch (error) {
    // The panel has deleted it and repeating `delsv` is safe, so the same button finishes the job.
    log("error", "Deleted service could not be removed from the local record", { errorType: error?.name || "Error" });
    await show("⚠️ سرویس حذف شد، اما ثبت آن در حساب شما کامل نشد. لطفاً دوباره تلاش کنید.", {
      reply_markup: { inline_keyboard: [[{ text: "🔄 تلاش دوباره", callback_data: `confirm_delete_service_${username}` }]] },
    });
    return;
  }
  await show("✅ سرویس با موفقیت حذف شد.");
}
