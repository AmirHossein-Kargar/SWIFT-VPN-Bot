/**
 * verifyLock
 * ----------
 * Redis-backed per-invoice in-flight lock using SET NX EX (atomic).
 *
 * Failure policy:
 *   If Redis is unavailable or times out, acquireVerifyLock returns TRUE
 *   (fail-open). The MongoDB Phase-1 atomic write in fulfillHooshOrder is
 *   the authoritative idempotency guard — Redis is an optimisation layer
 *   only (prevents redundant API calls). Never let Redis failure block payments.
 *
 * TTL is 30 s — covers:
 *   HooshPay API call (up to 10 s) + MongoDB writes (up to 5 s) + Telegram (up to 5 s)
 *   with 10 s headroom. The lock is released explicitly in `finally` blocks
 *   so the TTL is only a crash-safety backstop.
 */
import client from "../../config/redisClient.js";

const LOCK_PREFIX = "hoosh:lock:";
const LOCK_TTL_SECONDS = 30;

/**
 * Acquire an exclusive lock for the given invoice UID.
 *
 * @param {string} uid
 * @returns {Promise<boolean>}
 *   true  — lock acquired (proceed)
 *   false — another call holds the lock (duplicate, back off)
 *   true  — Redis error (fail-open; MongoDB guard is the fallback)
 */
export async function acquireVerifyLock(uid) {
  try {
    const result = await client.set(
      `${LOCK_PREFIX}${uid}`,
      "1",
      { NX: true, EX: LOCK_TTL_SECONDS }
    );
    return result === "OK";
  } catch (err) {
    // Redis unavailable or timed out — fail open so the payment is not lost.
    // The MongoDB findOneAndUpdate({fulfilled:false}) is the safety net.
    console.warn(
      `[HooshPay Lock] Redis acquire failed for uid=${uid} — failing open: ${err.message}`
    );
    return true;
  }
}

/**
 * Release the lock for a given invoice UID.
 * Always call in a finally block. Errors are swallowed — TTL handles cleanup.
 *
 * @param {string} uid
 */
export async function releaseVerifyLock(uid) {
  try {
    await client.del(`${LOCK_PREFIX}${uid}`);
  } catch (err) {
    // Non-fatal — key will auto-expire via TTL.
    console.warn(`[HooshPay Lock] Redis release failed for uid=${uid}: ${err.message}`);
  }
}

/**
 * Distributed cron lock — prevents multiple PM2 workers from running
 * the recovery cron simultaneously.
 *
 * @param {string} jobName  - unique job identifier (e.g. "recovery-cron")
 * @param {number} ttlSeconds - how long to hold the lock (should exceed job runtime)
 * @returns {Promise<boolean>} true if this worker won the cron slot
 */
export async function acquireCronLock(jobName, ttlSeconds = 270) {
  // 270 s = 4.5 min — just under the 5-min cron interval
  try {
    const result = await client.set(
      `hoosh:cron:${jobName}`,
      process.pid.toString(),
      { NX: true, EX: ttlSeconds }
    );
    return result === "OK";
  } catch (err) {
    console.warn(`[HooshPay Cron] Redis cron lock failed for ${jobName} — skipping run: ${err.message}`);
    return false; // fail-closed for cron: skip rather than risk double-run
  }
}
