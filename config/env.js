/**
 * Environment resolution and validation shared by startup and preflight.
 * Values are never included in validation output: several settings are secrets.
 */

const DEFAULT_MONGO_DB = "swiftvpn";

function firstSet(names, env = process.env) {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      return { name, value: String(raw).trim() };
    }
  }
  return null;
}

function databaseName(env = process.env) {
  const value = firstSet(["MONGO_DB_NAME"], env)?.value || DEFAULT_MONGO_DB;
  if (!/^[A-Za-z0-9._-]{1,63}$/.test(value)) {
    throw new Error("MONGO_DB_NAME must be 1–63 letters, digits, dot, underscore, or hyphen");
  }
  return value;
}

function withDatabaseName(uri, env = process.env) {
  if (typeof uri !== "string" || /[\s#]/.test(uri)) {
    throw new Error("MongoDB URI is malformed");
  }
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/i);
  if (!match) throw new Error("MongoDB URI must use mongodb:// or mongodb+srv:// and include a host");

  const [, authority, rawPath = "", query = ""] = match;
  const path = rawPath.replace(/^\/+/, "");
  if (path && path.includes("/")) throw new Error("MongoDB URI must contain at most one database path segment");
  return path ? uri : `${authority}/${databaseName(env)}${query}`;
}

/**
 * Resolve Railway's MongoDB URI aliases or discrete host credentials.
 * @returns {{url:string, source:string}|null}
 */
export function resolveMongoUrl(env = process.env) {
  const direct = firstSet(["MONGO_URL", "MONGODB_URI", "MONGO_URI"], env);
  if (direct) return { url: withDatabaseName(direct.value, env), source: direct.name };

  // Railway and adjacent services often provide DATABASE_URL for PostgreSQL;
  // treat it as Mongo only when it explicitly uses a MongoDB URI scheme.
  const genericDatabaseUrl = firstSet(["DATABASE_URL"], env);
  if (genericDatabaseUrl && /^mongodb(?:\+srv)?:\/\//i.test(genericDatabaseUrl.value)) {
    return { url: withDatabaseName(genericDatabaseUrl.value, env), source: genericDatabaseUrl.name };
  }

  const hostValue = firstSet(["MONGOHOST", "MONGO_HOST"], env);
  if (!hostValue) return null;
  const host = hostValue.value;
  if (/[\s/@?#]/.test(host)) throw new Error("MONGOHOST is malformed");

  const portValue = firstSet(["MONGOPORT", "MONGO_PORT"], env)?.value || "27017";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MONGOPORT must be an integer between 1 and 65535");
  }

  const user = firstSet(["MONGOUSER", "MONGO_USER"], env)?.value;
  const password = firstSet(["MONGOPASSWORD", "MONGO_PASSWORD"], env)?.value;
  if (user && !password) throw new Error("MONGOPASSWORD is required when MONGOUSER is set");
  if (!user && password) throw new Error("MONGOUSER is required when MONGOPASSWORD is set");

  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const credentials = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  const configuredDb = databaseName(env);
  const portName = firstSet(["MONGOPORT", "MONGO_PORT"], env)?.name;
  const source = [hostValue.name, portName, user ? "MONGOUSER" : null, password ? "MONGOPASSWORD" : null]
    .filter(Boolean)
    .join("+");

  return {
    url: `mongodb://${credentials}${authorityHost}:${port}/${configuredDb}?authSource=admin`,
    source,
  };
}

/**
 * Resolve Railway Redis URL or discrete host settings. Do not log `url`, since
 * it may contain credentials.
 * @returns {{url?:string, username:string, password?:string, host?:string, port?:number, tls?:boolean, source:string}|null}
 */
export function resolveRedisConfig(env = process.env) {
  const direct = firstSet(["REDIS_URL"], env);
  if (direct) {
    let parsed;
    try {
      parsed = new URL(direct.value);
    } catch {
      throw new Error("REDIS_URL is malformed");
    }
    if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("REDIS_URL must use redis:// or rediss:// and include a host");
    }
    if (parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)) {
      throw new Error("REDIS_URL contains an invalid port");
    }
    return {
      url: direct.value,
      username: decodeURIComponent(parsed.username || "default"),
      source: direct.name,
    };
  }

  const hostValue = firstSet(["REDIS_HOST", "REDISHOST"], env);
  if (!hostValue) return null;
  if (/[\s/@?#]/.test(hostValue.value)) throw new Error("REDIS_HOST is malformed");

  const portValue = firstSet(["REDIS_PORT", "REDISPORT"], env)?.value || "6379";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("REDIS_PORT must be an integer between 1 and 65535");
  }
  const tlsValue = firstSet(["REDIS_TLS"], env)?.value;
  if (tlsValue && !["true", "false", "1", "0"].includes(tlsValue.toLowerCase())) {
    throw new Error("REDIS_TLS must be true or false");
  }

  const password = firstSet(["REDIS_PASSWORD", "REDISPASSWORD"], env)?.value;
  const username = firstSet(["REDIS_USERNAME", "REDISUSER"], env)?.value || "default";
  const portName = firstSet(["REDIS_PORT", "REDISPORT"], env)?.name;
  return {
    host: hostValue.value,
    port,
    password,
    username,
    tls: tlsValue ? ["true", "1"].includes(tlsValue.toLowerCase()) : false,
    source: [hostValue.name, portName].filter(Boolean).join("+"),
  };
}

function isLoopback(host) {
  const normalized = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0" || normalized.startsWith("127.");
}

function hostFromMongoUrl(url) {
  const authority = url.match(/^mongodb(?:\+srv)?:\/\/([^/]+)/i)?.[1];
  if (!authority) return "";
  return authority.slice(authority.lastIndexOf("@") + 1).split(",")[0].replace(/:\d+$/, "");
}

function validatePublicHttps(value, name, { allowHttp = false, allowLoopback = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return `${name} must be a valid URL`;
  }
  const allowedProtocols = allowHttp ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(parsed.protocol)) return `${name} must use HTTPS`;
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return `${name} must be an origin/base URL without credentials, query, or fragment`;
  }
  if (!allowLoopback && isLoopback(parsed.hostname)) return `${name} cannot point to localhost or a loopback address`;
  return null;
}

const REQUIRED = [
  { key: "BOT_TOKEN", hint: "Telegram token from @BotFather" },
  { key: "__MONGO__", hint: "MongoDB URI or Railway MongoDB connection parts" },
  { key: "__REDIS__", hint: "Redis URL or Railway Redis connection parts" },
  { key: "ADMINS", hint: "Comma-separated numeric Telegram admin user IDs" },
  { key: "GROUP_ID", hint: "Negative Telegram admin-group chat ID" },
  { key: "WIZARD_API_URL", hint: "Wizard panel base URL" },
  { key: "VPN_API_KEY", hint: "Wizard panel bearer token" },
  { key: "HOOSHPAY_API_KEY", hint: "HooshPay API key" },
  { key: "HOOSHPAY_WEBHOOK_SECRET", hint: "HooshPay HMAC-SHA256 webhook secret (32+ characters)" },
  { key: "WEBHOOK_BASE_URL", hint: "Public HTTPS base URL for the webhook" },
  { key: "TRX_WALLET", hint: "TRON wallet address for TRX deposits" },
];

/** Inspect required and malformed settings without returning secret values. */
export function inspectEnv(env = process.env) {
  const missing = [];
  const invalid = [];
  let mongo = null;
  let redis = null;

  for (const check of REQUIRED) {
    if (check.key === "__MONGO__") {
      try {
        const resolved = resolveMongoUrl(env);
        if (resolved) {
          mongo = { source: resolved.source, configured: true };
          if (env.NODE_ENV === "production" && isLoopback(hostFromMongoUrl(resolved.url))) {
            invalid.push({ key: "MONGO_URL", fatal: true, hint: "Production MongoDB must not use a loopback/localhost host" });
          }
        } else {
          missing.push({ ...check, fatal: true });
        }
      } catch (error) {
        invalid.push({ key: "MONGO_URL", fatal: true, hint: error.message });
      }
      continue;
    }
    if (check.key === "__REDIS__") {
      try {
        const resolved = resolveRedisConfig(env);
        if (resolved) {
          redis = { source: resolved.source, configured: true };
          const redisHost = resolved.host || (() => {
            try { return new URL(resolved.url).hostname; } catch { return ""; }
          })();
          if (env.NODE_ENV === "production" && isLoopback(redisHost)) {
            invalid.push({ key: "REDIS_URL", fatal: true, hint: "Production Redis must not use a loopback/localhost host" });
          }
        } else {
          missing.push({ ...check, fatal: true });
        }
      } catch (error) {
        invalid.push({ key: "REDIS_URL", fatal: true, hint: error.message });
      }
      continue;
    }
    if (!firstSet([check.key], env)) missing.push({ ...check, fatal: true });
  }

  const botToken = firstSet(["BOT_TOKEN"], env)?.value;
  if (botToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    invalid.push({ key: "BOT_TOKEN", fatal: true, hint: "Expected the numeric-id:secret format from @BotFather" });
  }

  const admins = (firstSet(["ADMINS"], env)?.value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (admins.length && admins.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    invalid.push({ key: "ADMINS", fatal: true, hint: "Every admin ID must be a positive safe integer" });
  }

  const groupId = firstSet(["GROUP_ID"], env)?.value;
  if (groupId && (!/^-\d+$/.test(groupId) || !Number.isSafeInteger(Number(groupId)))) {
    invalid.push({ key: "GROUP_ID", fatal: true, hint: "GROUP_ID must be a negative integer chat ID" });
  }

  const allowHttp = env.NODE_ENV !== "production";
  const wizardUrl = firstSet(["WIZARD_API_URL"], env)?.value;
  if (wizardUrl) {
    const issue = validatePublicHttps(wizardUrl, "WIZARD_API_URL", {
      allowHttp,
      allowLoopback: env.NODE_ENV !== "production",
    });
    if (issue) invalid.push({ key: "WIZARD_API_URL", fatal: true, hint: issue });
  }

  const hooshBaseUrl = firstSet(["HOOSHPAY_API_BASE_URL"], env)?.value;
  if (hooshBaseUrl) {
    const issue = validatePublicHttps(hooshBaseUrl, "HOOSHPAY_API_BASE_URL", {
      allowHttp,
      allowLoopback: env.NODE_ENV !== "production",
    });
    if (issue) invalid.push({ key: "HOOSHPAY_API_BASE_URL", fatal: true, hint: issue });
  }

  const webhookUrl = firstSet(["WEBHOOK_BASE_URL"], env)?.value;
  if (webhookUrl) {
    const issue = validatePublicHttps(webhookUrl, "WEBHOOK_BASE_URL");
    if (issue) invalid.push({ key: "WEBHOOK_BASE_URL", fatal: true, hint: issue });
    else if (webhookUrl.endsWith("/")) invalid.push({ key: "WEBHOOK_BASE_URL", fatal: true, hint: "Remove the trailing slash" });
  }

  const secret = firstSet(["HOOSHPAY_WEBHOOK_SECRET"], env)?.value;
  if (secret && secret.length < 32) {
    invalid.push({ key: "HOOSHPAY_WEBHOOK_SECRET", fatal: true, hint: "Use at least 32 characters of random secret material" });
  }

  const cardNumber = firstSet(["CARD_NUMBER"], env)?.value;
  if (cardNumber && !/^\d{16}$/.test(cardNumber.replace(/[\s-]/g, ""))) {
    invalid.push({ key: "CARD_NUMBER", fatal: true, hint: "Use a 16-digit card number (spaces and hyphens are allowed)" });
  }

  const trxWallet = firstSet(["TRX_WALLET"], env)?.value;
  if (trxWallet && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trxWallet)) {
    invalid.push({ key: "TRX_WALLET", fatal: true, hint: "Use a valid 34-character Base58 TRON address" });
  }

  const port = firstSet(["PORT"], env)?.value;
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    invalid.push({ key: "PORT", fatal: true, hint: "PORT must be an integer between 1 and 65535" });
  }

  const rateLimit = firstSet(["WEBHOOK_RATE_LIMIT_PER_MIN"], env)?.value;
  if (rateLimit && (!/^\d+$/.test(rateLimit) || Number(rateLimit) > 100000)) {
    invalid.push({ key: "WEBHOOK_RATE_LIMIT_PER_MIN", fatal: true, hint: "Use an integer from 0 to 100000" });
  }

  return {
    missing,
    invalid,
    fatalCount: missing.filter((item) => item.fatal).length + invalid.filter((item) => item.fatal).length,
    mongo,
    redis,
  };
}

/** Print safe diagnostics and optionally exit on missing/invalid critical config. */
export function assertRequiredEnv({ exitOnFatal = true } = {}) {
  const report = inspectEnv();
  console.log("─────────────── configuration ───────────────");
  console.log(report.mongo ? `  ✔ MongoDB   resolved from ${report.mongo.source}` : "  ✖ MongoDB   NOT CONFIGURED");
  console.log(report.redis ? `  ✔ Redis     resolved from ${report.redis.source}` : "  ✖ Redis     NOT CONFIGURED");

  for (const item of report.missing) {
    console.error(`  ✖ ${item.key.padEnd(28)} ${item.hint}`);
  }
  for (const item of report.invalid) {
    console.error(`  ✖ ${item.key.padEnd(28)} ${item.hint}`);
  }

  if (report.fatalCount === 0) {
    console.log("  ✔ Required variables are present and structurally valid");
  } else {
    console.error(`  ❌ ${report.fatalCount} required configuration problem(s); values were not printed`);
    if (exitOnFatal) process.exit(1);
  }
  console.log("  See .env.example and DEPLOYMENT_CHECKLIST.md for Railway variable mapping.");
  console.log("─────────────────────────────────────────────");
  return report.fatalCount === 0;
}

export default { resolveMongoUrl, resolveRedisConfig, inspectEnv, assertRequiredEnv };
