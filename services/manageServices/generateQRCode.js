import User from "../../models/User.js";
import { getServiceLiveStatus } from "../wizardServiceStatus.js";
import { subscriptionLink } from "../subscriptionLink.js";
import { QR_PHOTO_FILE, subscriptionQrPng } from "../qrCode.js";

const generateQRCode = async (bot, chatId, messageId, data, query = {}) => {
  // data is expected to be like "qrcode_USERNAME"
  const username = data.split("qrcode_")[1];
  const userId = query.from?.id;
  const alert = (text) => bot.answerCallbackQuery(query.id, { text, show_alert: true });

  if (!userId) {
    await alert("خطا در شناسایی کاربر.");
    return;
  }

  // Get user from database to verify ownership
  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    await alert("کاربر پیدا نشد.");
    return;
  }

  // Check if user owns this service
  const service = user.services.find((item) => item.username === username);
  if (!service) {
    await alert("سرویس پیدا نشد.");
    return;
  }

  // The panel's link when it answers; the stored copy when it does not. A QR code of the current link, or none at all.
  const status = await getServiceLiveStatus(username);
  const link = status.data?.smartLink || subscriptionLink({ link: service.sub_link });
  if (!link) {
    await alert("لینک اشتراک یافت نشد.");
    return;
  }

  // The picture is drawn here, and editMessageMedia cannot upload a Buffer, so the photo replaces the screen as a new message. The
  // back button returns from a photo the way it always has: sendDetailsMessage sends text and removes the photo.
  try {
    const png = await subscriptionQrPng(link);
    await bot.sendPhoto(chatId, png, { reply_markup: { inline_keyboard: [[{ text: "بازگشت", callback_data: `show_service_${username}` }]] } }, { ...QR_PHOTO_FILE });
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  } catch (error) {
    console.error("QR code could not be sent:", error?.name || "Error");
    if (query.id) await alert("خطا در ایجاد QRCode");
  }
};

export default generateQRCode;
