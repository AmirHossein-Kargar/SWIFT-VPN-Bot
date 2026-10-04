import { createClient } from "redis";
import { resolveRedisConfig } from "./env.js";

const REDIS_TIMEOUT_MS = 8_000;
const redisConfig = resolveRedisConfig();
let lastError = null;
let lastLoggedAt = 0;
let connectPromise = null;

const reconnectStrategy = (retries) => Math.min(250 * 2 ** Math.min(retries, 5), 5_000);
const common = {
  disableOfflineQueue: true,
  socket: { connectTimeout: 5_000, reconnectStrategy },
};

const client = redisConfig
  ? createClient(
      redisConfig.url
        ? { ...common, url: redisConfig.url }
        : {
            ...common,
            username: redisConfig.username || "default",
            password: redisConfig.password || undefined,
            socket: {
              ...common.socket,
              host: redisConfig.host,
              port: redisConfig.port,
              tls: redisConfig.tls,
            },
          }
    )
  : null;

function safeLogError(event, error) {
  lastError = error instanceof Error ? error : new Error("Redis connection error");
  const now = Date.now();
  // Redis emits an error for every reconnect attempt. Keep logs bounded and do
  // not print command arguments or connection URLs that might contain secrets.
  if (now - lastLoggedAt < 60_000) return;
  lastLoggedAt = now;
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "redis",
    level: "error",
    event,
    errorType: error?.name || "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
    source: redisConfig?.source,
  }));
}

if (client) {
  client.on("error", (error) => safeLogError("client_error", error));
  client.on("ready", () => {
    lastError = null;
    console.log(`Redis connected (configuration: ${redisConfig.source})`);
  });
  client.on("end", () => {
    lastError = new Error("Redis connection ended");
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Connect explicitly during application startup; this module has no side effects. */
export async function connectRedis({ timeoutMs = REDIS_TIMEOUT_MS } = {}) {
  if (!client || !redisConfig) throw new Error("Redis is not configured; set REDIS_URL or Railway Redis variables.");
  if (client.isOpen && client.isReady) return client;

  try {
    if (!connectPromise) {
      connectPromise = (client.isOpen ? Promise.resolve() : client.connect())
        .then(() => client.ping())
        .then((reply) => {
          if (reply !== "PONG") throw new Error("Redis ping returned an unexpected response");
          lastError = null;
        });
    }
    await withTimeout(connectPromise, timeoutMs, "Redis startup connection");
    return client;
  } catch (error) {
    lastError = error;
    connectPromise = null;
    // Do not allow an unready client with an infinite reconnect loop to keep a
    // failed startup process alive. A Railway restart starts with a clean client.
    try { client.destroy(); } catch { /* best effort */ }
    const code = typeof error?.code === "string" ? `, code ${error.code}` : "";
    throw new Error(`Redis connection failed (${redisConfig.source}${code}); verify the Railway service reference and network access.`);
  }
}

export function isRedisReady() {
  return Boolean(client?.isOpen && client?.isReady);
}

/** Returns a safe error summary, never a raw connection URL or credentials. */
export function getRedisError() {
  if (!lastError) return null;
  return { name: lastError.name || "Error", code: typeof lastError.code === "string" ? lastError.code : undefined };
}

export async function closeRedis() {
  if (!client?.isOpen) return;
  try {
    await withTimeout(client.quit(), 2_000, "Redis shutdown");
  } catch {
    try { client.destroy(); } catch { /* best effort */ }
  }
}

export { redisConfig };
export default client;
