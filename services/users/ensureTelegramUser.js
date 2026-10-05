import { randomBytes } from "node:crypto";
import User from "../../models/User.js";

function generateReferralCode() {
  return `SWIFT-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function cleanTelegramText(value, maxLength = 128) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) || null : null;
}

/**
 * Create or refresh a Telegram account using Telegram's immutable numeric
 * user ID as the sole identity key. No phone/contact data is read or written.
 * `userModel` and `now` are injectable to keep the data flow testable.
 */
export async function ensureTelegramUser(
  telegramUser,
  { userModel = User, now = new Date() } = {}
) {
  const source = telegramUser && typeof telegramUser === "object" ? telegramUser : { id: telegramUser };
  const telegramId = String(source.id ?? "").trim();
  if (!/^[1-9]\d{0,19}$/.test(telegramId)) {
    throw new TypeError("A valid numeric Telegram user ID is required");
  }

  const $set = { lastActivityAt: now };
  if (telegramUser && typeof telegramUser === "object") {
    $set.firstName = cleanTelegramText(source.first_name);
    $set.lastName = cleanTelegramText(source.last_name);
    $set.username = cleanTelegramText(source.username, 64);
  }

  const newReferralCode = generateReferralCode();
  let user = await userModel.findOneAndUpdate(
    { telegramId },
    {
      $set,
      $setOnInsert: { telegramId, referralCode: newReferralCode },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // Legacy accounts that were created before referrals were introduced (or
  // without a contact share) receive a code once, with an atomic missing-value
  // guard so concurrent /start updates cannot overwrite each other's code.
  if (user && !user.referralCode) {
    const updated = await userModel.findOneAndUpdate(
      {
        telegramId,
        $or: [
          { referralCode: null },
          { referralCode: "" },
          { referralCode: { $exists: false } },
        ],
      },
      { $set: { referralCode: newReferralCode } },
      { new: true }
    );
    if (updated) user = updated;
  }

  return user;
}

export default ensureTelegramUser;
