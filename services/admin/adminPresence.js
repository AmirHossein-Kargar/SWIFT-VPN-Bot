import redisClient, { isRedisReady } from "../../config/redisClient.js";

/**
 * When each admin last made a signed-in panel request, for the online state in the admin directory.
 *
 * A session cannot answer that: it lives for hours whether or not anyone is there, and it is stored by token, not by admin.
 * So the router notes the time of a request that has already passed the session check, at most once a minute per admin.
 *
 * This is a record, never an input to access. It runs after authentication, is not awaited, and swallows every failure, so a
 * Redis problem cannot slow, fail or change a request. Nothing here decides who may do anything.
 */
const PRESENCE_PREFIX = "admin:web:presence:";
/** "Online" means a signed-in panel request within this window. */
export const PRESENCE_WINDOW_SECONDS = 300;
const WRITE_INTERVAL_MS = 60_000;
const RETENTION_SECONDS = 90 * 86_400;
const READ_TIMEOUT_MS = 1_500;

// Bounded by the number of admins. One replica runs, so this throttle sees every request.
const lastWrites = new Map();

let injectedRedis = null;
export function setAdminPresenceRedisForTests(redis) { injectedRedis = redis; }
export function resetAdminPresenceForTests() { injectedRedis = null; lastWrites.clear(); }

function store() {
  if (injectedRedis) return injectedRedis;
  return redisClient && isRedisReady() ? redisClient : null;
}

export function notePanelRequest(telegramId, { redis = store(), now = Date.now } = {}) {
  const id = String(telegramId ?? "");
  if (!redis || !id) return;
  const at = now();
  if (at - (lastWrites.get(id) ?? 0) < WRITE_INTERVAL_MS) return;
  lastWrites.set(id, at);
  try {
    // A failed write clears the throttle, so the next request tries again instead of waiting out the minute.
    Promise.resolve(redis.set(`${PRESENCE_PREFIX}${id}`, String(at), { EX: RETENTION_SECONDS })).catch(() => lastWrites.delete(id));
  } catch {
    lastWrites.delete(id);
  }
}

/** Mounted after the session guards; it only observes, and always continues. */
export function trackAdminPresence(req, _res, next) {
  notePanelRequest(req.adminActorId);
  next();
}

function parseTimestamp(value) {
  const at = Number(value);
  return Number.isSafeInteger(at) && at > 0 ? new Date(at) : null;
}

/** `available: false` means Redis could not answer, which is different from an admin who has no record. */
export async function readPanelPresence(telegramIds, { redis = store(), timeoutMs = READ_TIMEOUT_MS } = {}) {
  const lastSeen = new Map();
  if (!redis) return { available: false, lastSeen };
  if (telegramIds.length === 0) return { available: true, lastSeen };
  let timer;
  try {
    const values = await Promise.race([
      redis.mGet(telegramIds.map((id) => `${PRESENCE_PREFIX}${id}`)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("presence read timed out")), timeoutMs); timer.unref?.(); }),
    ]);
    telegramIds.forEach((id, index) => {
      const at = parseTimestamp(values?.[index]);
      if (at) lastSeen.set(id, at);
    });
    return { available: true, lastSeen };
  } catch {
    return { available: false, lastSeen: new Map() };
  } finally {
    clearTimeout(timer);
  }
}
