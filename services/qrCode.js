import QRCode from "qrcode";

/**
 * Subscription QR codes, drawn here. A subscription link is a credential, so it must not leave this process for anything but
 * Telegram: the picture used to come from a third-party image service, which received every link in a URL. Nothing in this module
 * touches the network, and tests/unit/qrCode.test.js fails if that changes.
 */
/** A scale, not a width: a fixed width squeezes a long link's modules until a camera cannot read them. */
const PNG_OPTIONS = Object.freeze({ type: "png", errorCorrectionLevel: "M", margin: 4, scale: 8 });

/** Telegram's upload settings for the picture. It is a Buffer, so the file name is only what the client sees. */
export const QR_PHOTO_FILE = Object.freeze({ filename: "subscription-qr.png", contentType: "image/png" });

/** A chat that refuses the bot refuses text too, so these go to the caller's retry instead of a second call. */
const CHAT_UNREACHABLE = /forbidden|chat not found|user is deactivated|bot was (?:blocked|kicked)/i;

export function subscriptionQrPng(link) {
  if (typeof link !== "string" || !link) return Promise.reject(new TypeError("A subscription link is required"));
  return QRCode.toBuffer(link, { ...PNG_OPTIONS });
}

/**
 * Sends the service message with its QR code. The link is what the customer paid for and the picture is a convenience, so when the
 * picture is the part that fails, the same text goes out alone. A chat that cannot be reached is rethrown for the caller's retry.
 */
export async function sendWithQrCode(bot, chatId, link, caption, options = {}) {
  try {
    const png = await subscriptionQrPng(link);
    await bot.sendPhoto(chatId, png, { ...options, caption }, { ...QR_PHOTO_FILE });
  } catch (error) {
    if (!bot.sendMessage || CHAT_UNREACHABLE.test(String(error?.message))) throw error;
    await bot.sendMessage(chatId, caption, options);
  }
}
