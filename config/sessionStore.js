/**
 * Redis-backed user/chat session store.
 *
 * Sessions drive multi-step conversational flows (payment amount entry, receipt
 * upload, admin prompts). Two production concerns are handled here:
 *
 *  1. TTL — sessions are written with an expiry so abandoned flows cannot
 *     accumulate in Redis forever.
 *  2. Redis outages — every operation degrades gracefully. A session store is
 *     a UX convenience, never a source of financial truth, so a Redis outage
 *     must not crash a message handler.
 */
import client, { isRedisReady } from "./redisClient.js";

const prefix = "session:";

// 7 days: comfortably longer than any payment/invoice lifetime, short enough
// that abandoned conversations are reclaimed automatically.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * @param {number|string} userId
 * @returns {Promise<object>} session object, or {} when absent/unavailable
 */
export const getSession = async (userId) => {
  if (!client || !isRedisReady()) return {};
  try {
    const data = await client.get(prefix + userId);
    if (!data) return {};
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn(`[sessionStore] getSession failed (${err?.name || "RedisError"}) — continuing with empty session`);
    return {};
  }
};

/**
 * @param {number|string} userId
 * @param {object} sessionData
 * @returns {Promise<void>}
 */
export const setSession = async (userId, sessionData) => {
  if (!client || !isRedisReady()) return;
  try {
    await client.set(prefix + userId, JSON.stringify(sessionData), {
      EX: SESSION_TTL_SECONDS,
    });
  } catch (err) {
    console.warn(`[sessionStore] setSession failed (${err?.name || "RedisError"}) — session not persisted`);
  }
};

/**
 * @param {number|string} userId
 * @returns {Promise<void>}
 */
export const clearSession = async (userId) => {
  if (!client || !isRedisReady()) return;
  try {
    await client.del(prefix + userId);
  } catch (err) {
    console.warn(`[sessionStore] clearSession failed (${err?.name || "RedisError"})`);
  }
};

export { SESSION_TTL_SECONDS };
