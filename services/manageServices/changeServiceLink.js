import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { changeLinkService } from "../../api/wizardApi.js";
import { invalidateServiceStatus } from "../wizardServiceStatus.js";

const BACK = (username) => ({ inline_keyboard: [[{ text: "بازگشت", callback_data: `show_service_${username}` }]] });

function logFailure(message, error) {
  // Never the error's response or the link: a subscription link is a credential.
  console.error(JSON.stringify({ ts: new Date().toISOString(), service: "service-link", level: "error", message, errorType: error?.name || "Error", code: typeof error?.code === "string" ? error.code : undefined }));
}

/**
 * The panel has already replaced the link when this runs, so every local copy must follow: the customer's record, and the order,
 * whose stored hash and link would otherwise rebuild the link that was just revoked.
 */
export async function persistNewLink({ telegramId, username, link, hash, userModel = User, purchaseModel = WalletPurchase }) {
  const updated = await userModel.findOneAndUpdate(
    { telegramId, "services.username": username },
    { $set: { "services.$.sub_link": link } },
    { new: true },
  );
  await purchaseModel.updateOne(
    { serviceUsername: username, telegramId },
    { $set: { serviceLink: link, ...(hash ? { serviceHash: hash } : {}) } },
  ).catch((error) => logFailure("Order link could not be updated", error));
  return updated;
}

const changeServiceLink = async (bot, chatId, messageId, data, query = {}) => {
  const telegramId = query?.from?.id ? String(query.from.id) : undefined;
  const username = data.split("change_link_")[1];
  const fail = (text) => bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: BACK(username) });

  let response;
  try {
    response = await changeLinkService(username);
  } catch (error) {
    logFailure("Link change failed", error);
    invalidateServiceStatus(username);
    // A lost answer may still have replaced the link, so the customer is sent to look rather than to try again blindly.
    await fail(error?.ambiguous
      ? "⚠️ نتیجهٔ تغییر لینک مشخص نشد. لطفاً به سرویس برگردید و لینک فعلی را بررسی کنید."
      : "❌ خطا در تغییر لینک. لطفاً دوباره تلاش کنید.");
    return;
  }

  invalidateServiceStatus(username);
  let updated = null;
  try {
    updated = await persistNewLink({ telegramId, username, link: response.result.new_sub_link, hash: response.result.new_hash });
  } catch (error) {
    logFailure("Service record could not be updated after a link change", error);
  }
  if (!updated) {
    // The new link exists at the panel and the live view reads it from there, so this is a stale copy, not a lost link.
    await fail("⚠️ لینک تغییر کرد، اما ذخیرهٔ آن با خطا روبه‌رو شد. لینک جدید را از صفحهٔ سرویس ببینید.");
    return;
  }

  await bot.editMessageText(
    "🔗 لینک اتصال شما با موفقیت تغییر کرد.\n\n🔸 جهت دریافت اطلاعات سرویس و مشاهده لینک جدید، بر روی گزینه بازگشت کلیک بفرمایید .",
    { chat_id: chatId, message_id: messageId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: BACK(username) },
  );
};

export default changeServiceLink;
