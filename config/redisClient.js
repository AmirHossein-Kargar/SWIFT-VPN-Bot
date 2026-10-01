/**
 * Redis client.
 *
 * IMPORTANT — startup must never block on Redis.
 *
 * A top-level `await client.connect()` would hang the whole process when Redis
 * is unreachable: node-redis keeps retrying per its reconnect strategy, so the
 * promise never settles, the `catch` never runs, and the module graph (and
 * therefore Mongo, Express and the Telegram bot) never loads.
 *
 * Instead we connect in the background. Callers handle outages explicitly:
 *   - verifyLock      → fail-OPEN  (MongoDB is authoritative for money)
 *   - hooshpay cron   → fail-CLOSED (skip the cycle rather than double-run)
 *   - sessionStore    → degrade to empty/no-op sessions
 *   - trxWalletScanner→ fail-OPEN  (in-process `isScanning` guard still applies)
 */
import { createClient } from "redis";

const client = createClient({
  username: process.env.REDIS_USERNAME || "default",
  password: process.env.REDIS_PASSWORD || undefined,
  // CRITICAL: do NOT queue commands issued while disconnected.
  // With the default offline queue, a command sent during a Redis outage waits
  // for a reconnect that may never come — every webhook and every cron cycle
  // would hang forever instead of taking its documented fallback path.
  disableOfflineQueue: true,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
    connectTimeout: 5000,
    // Keep retrying forever so the app recovers when Redis comes back,
    // but with a capped backoff so we do not hammer a dead endpoint.
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
});

client.on("error", (err) => {
  // node-redis emits on every retry — keep it to one concise line.
  console.error("\x1b[41m\x1b[37m❌ Redis Client Error:\x1b[0m", err.message);
});

client.on("ready", () => {
  console.log("\x1b[32m%s\x1b[0m", "✔ Redis connected");
});

// Fire-and-forget: never awaited at module scope.
let _connectError = null;
client
  .connect()
  .then(() => { _connectError = null; })
  .catch((err) => {
    _connectError = err;
    console.error(
      "\x1b[41m\x1b[37m❌ Redis connection failed — continuing with fallbacks:\x1b[0m",
      err.message
    );
  });

/**
 * Is Redis usable right now?
 * @returns {boolean}
 */
export function isRedisReady() {
  return client.isOpen === true && client.isReady === true;
}

/**
 * Last connection error, if any (for /health style diagnostics).
 * @returns {Error|null}
 */
export function getRedisError() {
  return _connectError;
}

export default client;
