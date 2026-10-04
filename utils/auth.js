/**
 * Central fail-closed Telegram admin authorization helpers.
 *
 * The `ADMINS` environment variable is the bootstrap allowlist: with no
 * `ADMINS` configured, nobody is an admin. A database-backed registry may
 * EXTEND this set by registering itself through `setAdditionalAdminProvider`
 * (see services/admin/adminRegistry.js); the provider is optional so this
 * module stays dependency-free and unit-testable in isolation.
 */

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

// Optional secondary provider (database-backed admins). Kept injectable so
// this module never imports the database layer.
let additionalAdminProvider = null;

/**
 * Register a synchronous predicate that reports extra allowlisted admin IDs.
 * The provider result alone is never sufficient: it can only extend the
 * allowlist, never bypass the numeric-ID validation.
 */
export function setAdditionalAdminProvider(provider) {
  additionalAdminProvider = typeof provider === "function" ? provider : null;
}

export function isAdminUser(userId) {
  const id = parseSafeInteger(userId);
  if (id === null || id <= 0) return false;
  if (getAdminIds().includes(id)) return true;
  if (additionalAdminProvider) {
    try {
      return additionalAdminProvider(id) === true;
    } catch {
      // A failing provider must never widen or crash authorization.
      return false;
    }
  }
  return false;
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

export default { getAdminIds, setAdditionalAdminProvider, isAdminUser, isAdminGroup, isAdmin };
