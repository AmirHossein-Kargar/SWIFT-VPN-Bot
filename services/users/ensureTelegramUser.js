import { randomBytes } from "node:crypto";
import User from "../../models/User.js";

const ACCOUNT_PROJECTION = { telegramId: 1, isBanned: 1, blockedBy: 1 };

function referralCode() {
  return `SWIFT-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function optionalTelegramText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, maxLength);
  return text || null;
}

/**
 * Create/update the minimum Telegram account needed by the bot. No contact,
 * phone number, email address, or other extra personal data is requested.
 */
export async function ensureTelegramUser(from, { userModel = User, now = () => new Date() } = {}) {
  const telegramId = String(from?.id ?? "").trim();
  if (!/^[1-9]\d*$/.test(telegramId) || !Number.isSafeInteger(Number(telegramId))) {
    throw new TypeError("A valid Telegram user is required");
  }

  const firstName = optionalTelegramText(from?.first_name, 128);
  const lastName = optionalTelegramText(from?.last_name, 128);
  const username = optionalTelegramText(from?.username, 64);
  const set = {};
  if (firstName !== null) set.firstName = firstName;
  if (lastName !== null) set.lastName = lastName;
  if (username !== null) set.username = username;

  return userModel.findOneAndUpdate(
    { telegramId },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      $setOnInsert: {
        telegramId,
        referralCode: referralCode(),
        createdAt: now(),
        lastActivityAt: now(),
      },
    },
    // Runs on every private message. Callers only need the access-gate fields, and
    // a hydrated document would carry the whole (ever-growing) services array.
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true, projection: ACCOUNT_PROJECTION },
  );
}

export default ensureTelegramUser;
