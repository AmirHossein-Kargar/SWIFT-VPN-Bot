/**
 * Runtime configuration resolution & validation.
 *
 * Why this exists
 * ---------------
 * Hosting platforms name their injected variables differently from this app's
 * own convention. Railway's MongoDB service exposes MONGO_URL and the Redis
 * service exposes REDIS_URL / REDISHOST / REDISPORT / REDISUSER / REDISPASSWORD
 * (see https://docs.railway.com/databases/redis), which do NOT match
 * REDIS_HOST / REDIS_PORT / ... . Without aliasing, a correctly provisioned
 * database still looks "undefined" to the app.
 *
 * This module resolves the accepted aliases in one place and produces a
 * human-readable report of anything missing, so a misconfigured deployment fails
 * fast with an actionable message instead of a mongoose stack trace.
 */

/** First non-empty value among `names`, with the name that supplied it. */
function firstSet(names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      return { name, value: String(raw).trim() };
    }
  }
  return null;
}

const DEFAULT_MONGO_DB = process.env.MONGO_DB_NAME || "swiftvpn";

/**
 * Resolve the MongoDB connection string.
 *
 * Accepted, in priority order:
 *   1. MONGO_URL / MONGODB_URI / MONGO_URI / DATABASE_URL   (full URI)
 *   2. MONGOHOST + MONGOPORT + MONGOUSER + MONGOPASSWORD    (Railway parts)
 *
 * A database name is appended when the URI does not carry one, so the target
 * database is deterministic instead of driver-dependent.
 *
 * @returns {{ url: string, source: string } | null}
 */
export function resolveMongoUrl() {
  const direct = firstSet(["MONGO_URL", "MONGODB_URI", "MONGO_URI", "DATABASE_URL"]);

  if (direct) {
    return { url: withDatabaseName(direct.value), source: direct.name };
  }

  const host = firstSet(["MONGOHOST", "MONGO_HOST"]);
  if (!host) return null;

  const port = firstSet(["MONGOPORT", "MONGO_PORT"])?.value || "27017";
  const user = firstSet(["MONGOUSER", "MONGO_USER"])?.value;
  const pass = firstSet(["MONGOPASSWORD", "MONGO_PASSWORD"])?.value;

  const credentials = user
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? "")}@`
    : "";

  return {
    url: `mongodb://${credentials}${host.value}:${port}/${DEFAULT_MONGO_DB}?authSource=admin`,
    source: "MONGOHOST/MONGOPORT/MONGOUSER/MONGOPASSWORD",
  };
}

/** Append a database name when the URI has none (ignores the ?query part). */
function withDatabaseName(uri) {
  const queryIndex = uri.indexOf("?");
  const base = queryIndex >= 0 ? uri.slice(0, queryIndex) : uri;
  const query = queryIndex >= 0 ? uri.slice(queryIndex) : "";

  // The path segment after "host[:port]" is the database name.
  const afterScheme = base.replace(/^mongodb(\+srv)?:\/\//, "");
  const hasDb = afterScheme.includes("/") && afterScheme.split("/").slice(1).join("/").length > 0;

  return hasDb ? uri : `${base}/${DEFAULT_MONGO_DB}${query}`;
}

/**
 * Resolve Redis connection options.
 *
 * Accepted, in priority order:
 *   1. REDIS_URL                (e.g. redis://default:pass@host:port)
 *   2. REDIS_HOST  | REDISHOST  + port / password / username
 *
 * @returns {{ url?: string, username: string, password?: string, host?: string,
 *             port?: number, source: string } | null}
 */
export function resolveRedisConfig() {
  const url = firstSet(["REDIS_URL"]);
  if (url) {
    return { url: url.value, username: "default", source: "REDIS_URL" };
  }

  const host = firstSet(["REDIS_HOST", "REDISHOST"]);
  if (!host) return null;

  const port = firstSet(["REDIS_PORT", "REDISPORT"])?.value;
  const password = firstSet(["REDIS_PASSWORD", "REDISPASSWORD"])?.value;
  const username = firstSet(["REDIS_USERNAME", "REDISUSER"])?.value || "default";

  const parts = [
    firstSet(["REDIS_HOST", "REDISHOST"])?.name,
    firstSet(["REDIS_PORT", "REDISPORT"])?.name,
  ].filter(Boolean);

  return {
    host: host.value,
    port: port ? Number(port) : 6379,
    password,
    username,
    source: [...new Set(parts)].join("+"),
  };
}

// ── Required configuration ───────────────────────────────────────────────────
// `fatal: true` means the process cannot do its job at all without it.
// Everything else degrades a single feature and is reported as a warning, so a
// missing optional integration can never cause a restart loop.

const CHECKS = [
  { key: "BOT_TOKEN", fatal: true, hint: "Telegram bot token from @BotFather" },
  { key: "__MONGO__", fatal: true, hint: "MongoDB connection string (MONGO_URL)" },
  { key: "ADMINS", fatal: false, hint: "Comma-separated Telegram user IDs — without it NOBODY can use the admin panel" },
  { key: "GROUP_ID", fatal: false, hint: "Admin group chat id (negative) — required for the admin panel and receipt approval" },
  { key: "__REDIS__", fatal: false, hint: "Redis host/url — without it sessions and locks degrade (payments still settle correctly)" },
  { key: "WIZARD_API_URL", fatal: false, hint: "VPN panel base URL" },
  { key: "VPN_API_KEY", fatal: false, hint: "VPN panel API key" },
  { key: "HOOSHPAY_API_KEY", fatal: false, hint: "HooshPay API key" },
  { key: "HOOSHPAY_WEBHOOK_SECRET", fatal: false, hint: "HMAC secret — without it EVERY HooshPay webhook is rejected" },
  { key: "WEBHOOK_BASE_URL", fatal: false, hint: "Public HTTPS origin, no trailing slash" },
  { key: "CARD_NUMBER", fatal: false, hint: "16-digit card number for manual transfers" },
  { key: "TRX_WALLET", fatal: false, hint: "Tron address (starts with T, 34 chars)" },
];

/**
 * Inspect the environment and return a report.
 * @returns {{ missing: Array<{key:string,fatal:boolean,hint:string}>, fatalCount: number,
 *             mongo: object|null, redis: object|null }}
 */
export function inspectEnv() {
  const mongo = resolveMongoUrl();
  const redis = resolveRedisConfig();

  const missing = [];
  for (const check of CHECKS) {
    if (check.key === "__MONGO__") {
      if (!mongo) missing.push(check);
      continue;
    }
    if (check.key === "__REDIS__") {
      if (!redis) missing.push(check);
      continue;
    }
    const found = firstSet([check.key]);
    if (!found) missing.push(check);
  }

  return {
    missing,
    fatalCount: missing.filter((m) => m.fatal).length,
    mongo,
    redis,
  };
}

/**
 * Log a readable configuration report.
 * @param {{ exitOnFatal?: boolean }} [opts]
 * @returns {boolean} true when there are no fatal problems
 */
export function assertRequiredEnv({ exitOnFatal = true } = {}) {
  const { missing, fatalCount, mongo, redis } = inspectEnv();

  console.log("─────────────── configuration ───────────────");
  console.log(
    mongo
      ? `  ✔ MongoDB   resolved from ${mongo.source}`
      : "  ✖ MongoDB   NOT CONFIGURED"
  );
  console.log(
    redis
      ? `  ✔ Redis     resolved from ${redis.source}`
      : "  ✖ Redis     NOT CONFIGURED (degraded mode)"
  );

  if (missing.length === 0) {
    console.log("  ✔ All required variables are present");
    console.log("─────────────────────────────────────────────");
    return true;
  }

  const fatal = missing.filter((m) => m.fatal);
  const rest = missing.filter((m) => !m.fatal);

  if (fatal.length > 0) {
    console.error("");
    console.error("❌ FATAL — these variables are missing or empty:");
    for (const m of fatal) console.error(`     • ${m.key.padEnd(24)} ${m.hint}`);
  }
  if (rest.length > 0) {
    console.warn("");
    console.warn("⚠️  Missing optional variables (features will be disabled):");
    for (const m of rest) console.warn(`     • ${m.key.padEnd(24)} ${m.hint}`);
  }

  console.log("");
  console.log("  On Railway: Service → Variables → add each one. Database values are");
  console.log("  reference variables, e.g.");
  console.log("      MONGO_URL        = ${{MongoDB.MONGO_URL}}");
  console.log("      REDIS_URL        = ${{Redis.REDIS_URL}}");
  console.log("      REDIS_HOST       = ${{Redis.REDISHOST}}");
  console.log("      REDIS_PORT       = ${{Redis.REDISPORT}}");
  console.log("      REDIS_USERNAME   = ${{Redis.REDISUSER}}");
  console.log("      REDIS_PASSWORD   = ${{Redis.REDISPASSWORD}}");
  console.log("  (The raw names REDISHOST / REDISPORT / REDISUSER / REDISPASSWORD are");
  console.log("   also accepted directly — no renaming needed.)");
  console.log("  See .env.example for the full list.");
  console.log("─────────────────────────────────────────────");

  if (fatal.length > 0 && exitOnFatal) {
    console.error("❌ Startup aborted — fix the FATAL variables above and redeploy.");
    process.exit(1);
  }
  return fatal.length === 0;
}

export default { resolveMongoUrl, resolveRedisConfig, inspectEnv, assertRequiredEnv };
