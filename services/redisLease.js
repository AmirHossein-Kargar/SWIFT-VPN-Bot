import { randomUUID } from "node:crypto";
import defaultRedisClient, { isRedisReady } from "../config/redisClient.js";

const COMPARE_RENEW_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], tonumber(ARGV[2]))
  end
  return 0
`;
const COMPARE_DELETE_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Acquire an owner-token lease. Returns null when another owner holds it. */
export async function acquireRedisLease(key, ttlSeconds, {
  redis = defaultRedisClient,
  timeoutMs = 2_000,
} = {}) {
  if (!redis || (redis === defaultRedisClient && !isRedisReady())) {
    throw new Error("Redis is not ready");
  }
  if (typeof key !== "string" || !key || !Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("A non-empty key and positive integer lease TTL are required");
  }

  const token = randomUUID();
  const result = await withTimeout(
    redis.set(key, token, { NX: true, EX: ttlSeconds }),
    timeoutMs,
    "Redis lease acquire"
  );
  return result === "OK" ? { key, token, ttlSeconds, redis } : null;
}

/** Extend only a lease still owned by this caller. */
export async function renewRedisLease(lease, ttlSeconds = lease?.ttlSeconds, { timeoutMs = 2_000 } = {}) {
  if (!lease?.redis || !lease?.key || !lease?.token || !Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    return false;
  }
  const result = await withTimeout(
    lease.redis.eval(COMPARE_RENEW_LUA, {
      keys: [lease.key],
      arguments: [lease.token, String(ttlSeconds)],
    }),
    timeoutMs,
    "Redis lease renew"
  );
  return Number(result) === 1;
}

/** Release only a lease still owned by this caller. */
export async function releaseRedisLease(lease, { timeoutMs = 2_000 } = {}) {
  if (!lease?.redis || !lease?.key || !lease?.token) return false;
  const result = await withTimeout(
    lease.redis.eval(COMPARE_DELETE_LUA, {
      keys: [lease.key],
      arguments: [lease.token],
    }),
    timeoutMs,
    "Redis lease release"
  );
  return Number(result) === 1;
}

export function startRedisLeaseHeartbeat(lease, {
  ttlSeconds = lease?.ttlSeconds,
  intervalMs = Math.max(1_000, Math.floor((ttlSeconds || 60) * 1_000 / 3)),
  onLost = () => {},
} = {}) {
  if (!lease?.redis || !Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("A valid Redis lease is required");
  }
  let stopped = false;
  let renewing = false;
  const timer = setInterval(async () => {
    if (stopped || renewing) return;
    renewing = true;
    try {
      const renewed = await renewRedisLease(lease, ttlSeconds);
      if (!renewed) {
        stopped = true;
        clearInterval(timer);
        try { await onLost(new Error("Redis lease ownership was lost")); } catch { /* callback must not leak a rejection */ }
      }
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      try { await onLost(error); } catch { /* callback must not leak a rejection */ }
    } finally {
      renewing = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export { COMPARE_DELETE_LUA, COMPARE_RENEW_LUA };
