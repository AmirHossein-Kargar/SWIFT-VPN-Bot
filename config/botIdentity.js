/**
 * Public identity of the running Telegram bot (username only), captured from
 * getMe() at startup so the storefront can build t.me deep links without a
 * hardcoded handle. BOT_USERNAME overrides it when set.
 */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
let detectedUsername = null;

export function setBotIdentity(me) {
  const username = typeof me?.username === "string" ? me.username.trim() : "";
  detectedUsername = USERNAME.test(username) ? username : null;
}

export function getBotUsername(env = process.env) {
  const configured = String(env.BOT_USERNAME || "").trim().replace(/^@/, "");
  if (USERNAME.test(configured)) return configured;
  return detectedUsername;
}

export function resetBotIdentityForTests() {
  detectedUsername = null;
}

export default { setBotIdentity, getBotUsername };
