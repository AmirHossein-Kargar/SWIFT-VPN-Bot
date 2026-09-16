/**
 * Shared bot instance singleton.
 * bot.js sets this after creating the TelegramBot so the webhook handler
 * (server.js) can send messages without needing a circular import.
 */
let _bot = null;

export function setBotInstance(bot) {
  _bot = bot;
}

export default {
  get bot() { return _bot; },
  // Allow direct default import to return the bot instance
  sendMessage: (...args) => _bot?.sendMessage(...args),
  deleteMessage: (...args) => _bot?.deleteMessage(...args),
};
