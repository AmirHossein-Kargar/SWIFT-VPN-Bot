import { setServiceStatus } from "../../api/wizardApi.js";
import { getServiceLiveStatus, invalidateServiceStatus } from "../wizardServiceStatus.js";

const backTo = (username) => ({ inline_keyboard: [[{ text: "بازگشت", callback_data: `show_service_${username}` }]] });

async function show(bot, chatId, messageId, text, username, options = {}) {
  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: backTo(username), ...options });
}

/**
 * The button sends no target, because old buttons stay on screen for ever. So the target comes from a fresh read and is sent to
 * the panel by name: a second tap, or a retried update, lands on the same state instead of flipping it back.
 *
 * Only a service the customer could really switch moves: `limited`, `expired` and `on_hold` are not on/off states, and the
 * panel would turn them `active` regardless of the reason they stopped.
 */
const deactivateServiceButton = async (bot, chatId, messageId, data) => {
  const username = data.split("deactivate_service_")[1];
  const current = await getServiceLiveStatus(username, { fresh: true });
  const status = current.live ? current.data?.status : null;
  if (status !== "active" && status !== "disabled") {
    await show(bot, chatId, messageId, current.live
      ? "⚠️ در وضعیت فعلی سرویس، فعال یا غیرفعال کردن آن ممکن نیست."
      : "⚠️ وضعیت سرویس از پنل در دسترس نیست. کمی بعد دوباره تلاش کنید.", username);
    return;
  }

  const target = status === "active" ? "disabled" : "active";
  try {
    await setServiceStatus(username, target);
  } catch (error) {
    invalidateServiceStatus(username);
    await show(bot, chatId, messageId, error?.ambiguous
      ? "⚠️ نتیجهٔ تغییر وضعیت مشخص نشد. لطفاً پیش از تلاش دوباره، وضعیت سرویس را بروزرسانی کنید."
      : "❌ خطا در فعال/غیرفعال کردن سرویس. کمی بعد دوباره تلاش کنید.", username);
    return;
  }
  invalidateServiceStatus(username);
  await show(
    bot,
    chatId,
    messageId,
    `سرویس با موفقیت ${target === "active" ? "فعال" : "غیرفعال"} شد.\n\n<a href="https://t.me/swift_shield/12">غیرفعال کردن سرویس چیست؟</a>`,
    username,
    { parse_mode: "HTML", disable_web_page_preview: true },
  );
};

export default deactivateServiceButton;
