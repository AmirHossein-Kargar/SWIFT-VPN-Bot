/**
 * Small in-process sliding-window limiter for admin Telegram actions.
 *
 * It protects sensitive handlers from button mashing and scripted replay of a
 * compromised admin account. State is per process (a restart resets it), which
 * is acceptable here: the audited, idempotent services remain the authoritative
 * guard against double execution.
 */
const MAX_KEYS = 5_000;

export function createThrottle({ limit, windowMs, now = () => Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new TypeError("limit and windowMs must be positive integers");
  }
  const hits = new Map();

  function prune(key, current) {
    const recent = (hits.get(key) || []).filter((at) => current - at < windowMs);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
    return recent;
  }

  return {
    /** Records an attempt; false means the caller is over the limit. */
    check(key) {
      const id = String(key ?? "");
      if (!id) return false;
      const current = now();
      const recent = prune(id, current);
      if (recent.length >= limit) return false;
      recent.push(current);
      hits.set(id, recent);
      if (hits.size > MAX_KEYS) {
        for (const other of hits.keys()) {
          if (other !== id) prune(other, current);
          if (hits.size <= MAX_KEYS) break;
        }
      }
      return true;
    },
    reset() { hits.clear(); },
  };
}

export default { createThrottle };
