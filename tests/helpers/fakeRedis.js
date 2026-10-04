/**
 * Minimal in-memory Redis stub for admin-session and idempotency tests.
 * Supports exactly the command surface used by services/admin/*:
 * set (NX/EX), get, del, eval(CONSUME_ONCE), ping.
 */
export function makeFakeRedis() {
  const map = new Map();
  const expiries = new Map();
  const isExpired = (key) => {
    const at = expiries.get(key);
    return at != null && Date.now() >= at;
  };
  const redis = {
    map,
    async set(key, value, opts = {}) {
      if (opts.NX && map.has(key) && !isExpired(key)) return null;
      map.set(key, value);
      if (opts.EX) expiries.set(key, Date.now() + opts.EX * 1000);
      return "OK";
    },
    async get(key) {
      if (!map.has(key)) return null;
      if (isExpired(key)) {
        map.delete(key);
        expiries.delete(key);
        return null;
      }
      return map.get(key);
    },
    async del(key) {
      const existed = map.has(key);
      map.delete(key);
      expiries.delete(key);
      return existed ? 1 : 0;
    },
    async eval(_script, { keys = [] } = {}) {
      const [key] = keys;
      const value = await redis.get(key);
      if (value != null) await redis.del(key);
      return value ?? null;
    },
    async ping() { return "PONG"; },
    isReady: true,
  };
  return redis;
}
