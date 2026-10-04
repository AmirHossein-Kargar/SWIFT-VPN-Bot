import {
  acquireRedisLease,
  releaseRedisLease,
  renewRedisLease,
} from "../redisLease.js";

const LOCK_PREFIX = "hoosh:lock:";
const LOCK_TTL_SECONDS = 90;
const REDIS_OP_TIMEOUT_MS = 2_000;

/**
 * MongoDB's atomic wallet-ledger update is the financial idempotency guard.
 * Redis only avoids duplicate verification work, so an outage fails open.
 */
export async function acquireVerifyLock(uid) {
  try {
    const lease = await acquireRedisLease(
      `${LOCK_PREFIX}${uid}`,
      LOCK_TTL_SECONDS,
      { timeoutMs: REDIS_OP_TIMEOUT_MS }
    );
    return { acquired: Boolean(lease), lease };
  } catch (error) {
    console.warn(`[HooshPay Lock] Redis lock unavailable (${error?.name || "RedisError"}); using MongoDB idempotency`);
    return { acquired: true, lease: null, redisUnavailable: true };
  }
}

export async function releaseVerifyLock(lock) {
  if (!lock?.lease) return;
  try {
    await releaseRedisLease(lock.lease, { timeoutMs: REDIS_OP_TIMEOUT_MS });
  } catch (error) {
    console.warn(`[HooshPay Lock] Redis lock release failed (${error?.name || "RedisError"}); lease will expire`);
  }
}

/** Cron locks fail closed: skip recovery work rather than run duplicate sweeps. */
export async function acquireCronLock(jobName, ttlSeconds = 600) {
  try {
    return await acquireRedisLease(`hoosh:cron:${jobName}`, ttlSeconds, {
      timeoutMs: REDIS_OP_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn(`[HooshPay Cron] Redis lock unavailable for ${jobName} (${error?.name || "RedisError"}); skipping cycle`);
    return null;
  }
}

export async function renewCronLock(lease) {
  try {
    return await renewRedisLease(lease, lease?.ttlSeconds, { timeoutMs: REDIS_OP_TIMEOUT_MS });
  } catch (error) {
    console.warn(`[HooshPay Cron] Redis lock renewal failed (${error?.name || "RedisError"})`);
    return false;
  }
}

export async function releaseCronLock(lease) {
  if (!lease) return;
  try {
    await releaseRedisLease(lease, { timeoutMs: REDIS_OP_TIMEOUT_MS });
  } catch (error) {
    console.warn(`[HooshPay Cron] Redis lock release failed (${error?.name || "RedisError"}); lease will expire`);
  }
}
