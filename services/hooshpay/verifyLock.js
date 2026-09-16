/**
 * verifyLock
 * ----------
 * Redis-backed per-invoice in-flight lock.
 *
 * Prevents duplicate concurrent executions of hoosh_verify for the same
 * invoice UID — covers double-clicks, duplicate Telegram callback deliveries,
 * and race between webhook and manual verify.
 *
 * Uses SET NX EX (atomic Redis command) so only one caller acquires the lock.
 * Lock TTL is 20 seconds — long enough to cover a full verify+fulfill round-trip.
 */
import client from "../../config/redisClient.js";

const LOCK_PREFIX = "hoosh:lock:";
const LOCK_TTL_SECONDS = 20;

/**
 * Attempts to acquire an exclusive lock for the given invoice UID.
 *
 * @param {string} uid
 * @returns {Promise<boolean>} true if lock was acquired, false if already locked
 */
export async function acquireVerifyLock(uid) {
  // SET key value NX EX ttl — returns "OK" if set, null if key already exists
  const result = await client.set(
    `${LOCK_PREFIX}${uid}`,
    "1",
    { NX: true, EX: LOCK_TTL_SECONDS }
  );
  return result === "OK";
}

/**
 * Releases the lock for a given invoice UID.
 * Should be called in a finally block to release early on success/failure.
 *
 * @param {string} uid
 */
export async function releaseVerifyLock(uid) {
  await client.del(`${LOCK_PREFIX}${uid}`).catch(() => {});
}
