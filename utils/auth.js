/** Central fail-closed Telegram admin authorization helpers. */

function parseSafeInteger(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** @returns {number[]} Configured positive Telegram user IDs. */
export function getAdminIds() {
  return (process.env.ADMINS || "")
    .split(",")
    .map((item) => parseSafeInteger(item))
    .filter((id) => id !== null && id > 0);
}

export function isAdminUser(userId) {
  const id = parseSafeInteger(userId);
  return id !== null && id > 0 && getAdminIds().includes(id);
}

/** Admin actions always require an explicitly configured negative group ID. */
export function isAdminGroup(chatId) {
  const configured = parseSafeInteger(process.env.GROUP_ID);
  const supplied = parseSafeInteger(chatId);
  return configured !== null && configured < 0 && supplied === configured;
}

/** A configured admin, acting only inside the configured admin group. */
export function isAdmin(chatId, userId) {
  return isAdminGroup(chatId) && isAdminUser(userId);
}

export default { getAdminIds, isAdminUser, isAdminGroup, isAdmin };
