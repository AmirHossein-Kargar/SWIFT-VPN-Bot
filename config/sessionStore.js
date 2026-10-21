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

// Test seam: unit tests inject an in-memory client so session-driven flows
// (e.g. support compose mode) can be exercised without Redis.
let injected = null;
export function setSessionClientForTests(fake) { injected = fake; }
export function clearSessionClientForTests() { injected = null; }
const redis = () => injected || client;
const online = () => (injected ? true : isRedisReady());

// 7 days: comfortably longer than any payment/invoice lifetime, short enough
// that abandoned conversations are reclaimed automatically.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * @param {number|string} userId
 * @returns {Promise<object>} session object, or {} when absent/unavailable
 */
export const getSession = async (userId) => {
  if (!redis() || !online()) return {};
  try {
    const data = await redis().get(prefix + userId);
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
  if (!redis() || !online()) return;
  try {
    // Stamp input-step sessions so a stale prompt can expire (see
    // utils/inputExpiry.js) instead of swallowing a much later message.
    const stored = sessionData && typeof sessionData === "object" && sessionData.step
      ? { ...sessionData, updatedAt: Date.now() }
      : sessionData;
    await redis().set(prefix + userId, JSON.stringify(stored), {
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
  if (!redis() || !online()) return;
  try {
    await redis().del(prefix + userId);
  } catch (err) {
    console.warn(`[sessionStore] clearSession failed (${err?.name || "RedisError"})`);
  }
};

export { SESSION_TTL_SECONDS };
