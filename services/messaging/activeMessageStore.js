/**
 * Redis-backed pointer to "the message currently showing this chat's active
 * navigation screen" (profile, guide, menus, ...). Deliberately a separate
 * key from config/sessionStore.js: callers there routinely call setSession()
 * with a partial object that REPLACES the whole stored session (see e.g.
 * handlers/onMessage.js `setSession(chatId, { step: null })`), which would
 * silently drop a pointer kept in the same blob. This store is single-purpose
 * so unrelated session writes can never clobber it.
 *
 * Like sessionStore.js, this is a UX convenience, never a source of truth: a
 * missing/expired pointer just means the next navigation sends a fresh
 * message instead of editing one, and every operation degrades to a no-op
 * when Redis is unavailable.
 */
import defaultRedisClient, { isRedisReady } from "../../config/redisClient.js";

const prefix = "ui_msg:";

// A stale pointer only costs one extra sent message on the next navigation,
// so this can be much shorter than the 7-day session TTL.
const ACTIVE_MESSAGE_TTL_SECONDS = 24 * 60 * 60;

// Compare-and-set: only replace the pointer if it still holds the value the
// caller last observed. This stops a slow/stale navigation request (e.g. a
// delayed retry after a fallback send) from overwriting a pointer a more
// recent concurrent request already advanced — the stale write is dropped
// instead of corrupting the tracked message id.
const SET_IF_MATCH_LUA = `
  local current = redis.call('get', KEYS[1])
  if (current == ARGV[1]) or (current == false and ARGV[1] == '') then
    redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
    return 1
  end
  return 0
`;

function isReady(redis) {
  return Boolean(redis) && (redis !== defaultRedisClient || isRedisReady());
}

/**
 * @param {number|string} chatId
 * @returns {Promise<number|null>}
 */
export async function getActiveMessage(chatId, { redis = defaultRedisClient } = {}) {
  if (!isReady(redis)) return null;
  try {
    const raw = await redis.get(prefix + chatId);
    if (raw == null) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
  } catch (err) {
    console.warn(`[activeMessageStore] getActiveMessage failed (${err?.name || "RedisError"}) — continuing without a tracked message`);
    return null;
  }
}

/**
 * Unconditionally point the chat's active message at `messageId`. Reserved
 * for callers that just confirmed, from the current Telegram update itself
 * (e.g. the message id on an incoming callback query), which message is
 * actually on screen — that is more authoritative than anything a concurrent
 * request could race against.
 */
export async function setActiveMessage(chatId, messageId, { redis = defaultRedisClient } = {}) {
  if (!isReady(redis) || !Number.isSafeInteger(messageId)) return false;
  try {
    await redis.set(prefix + chatId, String(messageId), { EX: ACTIVE_MESSAGE_TTL_SECONDS });
    return true;
  } catch (err) {
    console.warn(`[activeMessageStore] setActiveMessage failed (${err?.name || "RedisError"})`);
    return false;
  }
}

/**
 * Point the chat's active message at `messageId`, but only if the stored
 * value still matches `expectedPrevious` (the value this caller originally
 * read before doing its work). See SET_IF_MATCH_LUA for why.
 */
export async function setActiveMessageIfUnchanged(chatId, messageId, expectedPrevious, { redis = defaultRedisClient } = {}) {
  if (!isReady(redis) || !Number.isSafeInteger(messageId)) return false;
  try {
    const result = await redis.eval(SET_IF_MATCH_LUA, {
      keys: [prefix + chatId],
      arguments: [
        expectedPrevious == null ? "" : String(expectedPrevious),
        String(messageId),
        String(ACTIVE_MESSAGE_TTL_SECONDS),
      ],
    });
    return Number(result) === 1;
  } catch (err) {
    console.warn(`[activeMessageStore] setActiveMessageIfUnchanged failed (${err?.name || "RedisError"})`);
    return false;
  }
}

/**
 * @param {number|string} chatId
 */
export async function clearActiveMessage(chatId, { redis = defaultRedisClient } = {}) {
  if (!isReady(redis)) return;
  try {
    await redis.del(prefix + chatId);
  } catch (err) {
    console.warn(`[activeMessageStore] clearActiveMessage failed (${err?.name || "RedisError"})`);
  }
}

export { ACTIVE_MESSAGE_TTL_SECONDS };
