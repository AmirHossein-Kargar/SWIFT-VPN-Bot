/**
 * Environment resolution tests — REAL config/env.js.
 *
 * Regression guard for the deployment failure where Railway provides
 * MONGO_URL / REDIS_URL / REDISHOST / REDISPORT / REDISUSER / REDISPASSWORD,
 * which do not match this app's own REDIS_HOST / REDIS_PORT naming.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveMongoUrl, resolveRedisConfig, inspectEnv } from "../../config/env.js";

const KEYS = [
  "MONGO_URL", "MONGODB_URI", "MONGO_URI", "DATABASE_URL",
  "MONGOHOST", "MONGOPORT", "MONGOUSER", "MONGOPASSWORD", "MONGO_HOST", "MONGO_PORT",
  "REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_USERNAME", "REDIS_PASSWORD",
  "REDISHOST", "REDISPORT", "REDISUSER", "REDISPASSWORD",
  "BOT_TOKEN", "ADMINS", "GROUP_ID", "WIZARD_API_URL", "VPN_API_KEY",
  "HOOSHPAY_API_KEY", "HOOSHPAY_WEBHOOK_SECRET", "WEBHOOK_BASE_URL",
  "CARD_NUMBER", "TRX_WALLET", "MONGO_DB_NAME", "REDIS_TLS", "PORT",
  "WEBHOOK_RATE_LIMIT_PER_MIN", "NODE_ENV", "HOOSHPAY_API_BASE_URL",
];

let saved;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveMongoUrl", () => {
  test("returns null when nothing is configured", () => {
    assert.equal(resolveMongoUrl(), null);
  });

  test("reads MONGO_URL and reports it as the source", () => {
    process.env.MONGO_URL = "mongodb://host:27017/swiftvpn";
    const r = resolveMongoUrl();
    assert.equal(r.url, "mongodb://host:27017/swiftvpn");
    assert.equal(r.source, "MONGO_URL");
  });

  test("appends a deterministic database name when the URI has none", () => {
    process.env.MONGO_URL = "mongodb://host:27017";
    assert.equal(resolveMongoUrl().url, "mongodb://host:27017/swiftvpn");
  });

  test("appends the database name before the query string", () => {
    process.env.MONGO_URL = "mongodb://host:27017?retryWrites=true";
    assert.equal(resolveMongoUrl().url, "mongodb://host:27017/swiftvpn?retryWrites=true");
  });

  test("does not override a database name that is already present", () => {
    process.env.MONGO_URL = "mongodb+srv://user:pw@cluster.mongodb.net/mydb?retryWrites=true";
    assert.equal(
      resolveMongoUrl().url,
      "mongodb+srv://user:pw@cluster.mongodb.net/mydb?retryWrites=true"
    );
  });

  test("accepts common aliases (MONGODB_URI / MONGO_URI / DATABASE_URL)", () => {
    process.env.MONGODB_URI = "mongodb://a/db1";
    assert.equal(resolveMongoUrl().source, "MONGODB_URI");
    delete process.env.MONGODB_URI;

    process.env.MONGO_URI = "mongodb://b/db2";
    assert.equal(resolveMongoUrl().source, "MONGO_URI");
    delete process.env.MONGO_URI;

    process.env.DATABASE_URL = "mongodb://c/db3";
    assert.equal(resolveMongoUrl().source, "DATABASE_URL");
  });

  test("prefers MONGO_URL over the discrete Railway parts", () => {
    process.env.MONGO_URL = "mongodb://winner:27017/swiftvpn";
    process.env.MONGOHOST = "loser";
    process.env.MONGOPORT = "27017";
    assert.equal(resolveMongoUrl().url, "mongodb://winner:27017/swiftvpn");
  });

  test("builds a URI from MONGOHOST/MONGOPORT/MONGOUSER/MONGOPASSWORD", () => {
    process.env.MONGOHOST = "mongo.railway.internal";
    process.env.MONGOPORT = "27017";
    process.env.MONGOUSER = "mongo";
    process.env.MONGOPASSWORD = "p@ss:word/with specials";
    const r = resolveMongoUrl();
    // Credentials must be URL-encoded so specials cannot corrupt the URI.
    assert.equal(
      r.url,
      "mongodb://mongo:p%40ss%3Aword%2Fwith%20specials@mongo.railway.internal:27017/swiftvpn?authSource=admin"
    );
  });

  test("MONGOHOST alone is enough (port defaults to 27017)", () => {
    process.env.MONGOHOST = "localhost";
    assert.equal(resolveMongoUrl().url, "mongodb://localhost:27017/swiftvpn?authSource=admin");
  });

  test("empty strings count as unset", () => {
    process.env.MONGO_URL = "   ";
    assert.equal(resolveMongoUrl(), null);
  });
});

describe("resolveRedisConfig", () => {
  test("returns null when nothing is configured", () => {
    assert.equal(resolveRedisConfig(), null);
  });

  test("prefers REDIS_URL", () => {
    process.env.REDIS_URL = "redis://default:pw@redis.railway.internal:6379";
    process.env.REDISHOST = "ignored";
    const r = resolveRedisConfig();
    assert.equal(r.url, "redis://default:pw@redis.railway.internal:6379");
    assert.equal(r.source, "REDIS_URL");
  });

  test("reads the app's own names", () => {
    process.env.REDIS_HOST = "127.0.0.1";
    process.env.REDIS_PORT = "6380";
    process.env.REDIS_PASSWORD = "secret";
    process.env.REDIS_USERNAME = "appuser";
    const r = resolveRedisConfig();
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.port, 6380);
    assert.equal(r.password, "secret");
    assert.equal(r.username, "appuser");
  });

  test("reads Railway's native names without renaming", () => {
    process.env.REDISHOST = "redis.railway.internal";
    process.env.REDISPORT = "6379";
    process.env.REDISUSER = "default";
    process.env.REDISPASSWORD = "railwaypw";
    const r = resolveRedisConfig();
    assert.equal(r.host, "redis.railway.internal");
    assert.equal(r.port, 6379);
    assert.equal(r.password, "railwaypw");
    assert.equal(r.username, "default");
  });

  test("REDISHOST alone works, port defaults to 6379 and username to default", () => {
    process.env.REDISHOST = "localhost";
    const r = resolveRedisConfig();
    assert.equal(r.port, 6379);
    assert.equal(r.username, "default");
    assert.equal(r.password, undefined);
  });

  test("prefers the app's names when both schemes are present", () => {
    process.env.REDIS_HOST = "app-host";
    process.env.REDISHOST = "railway-host";
    assert.equal(resolveRedisConfig().host, "app-host");
  });
});

describe("inspectEnv", () => {
  test("reports missing runtime dependencies and business integrations as fatal", () => {
    const { missing, fatalCount } = inspectEnv();
    const fatalKeys = missing.filter((m) => m.fatal).map((m) => m.key);
    assert.ok(fatalKeys.includes("BOT_TOKEN"));
    assert.ok(fatalKeys.includes("__MONGO__"));
    assert.ok(fatalKeys.includes("__REDIS__"));
    assert.ok(fatalKeys.includes("WIZARD_API_URL"));
    assert.ok(fatalKeys.includes("HOOSHPAY_WEBHOOK_SECRET"));
    assert.ok(fatalCount >= 10);
  });

  test("missing admin and payment settings are not treated as optional", () => {
    process.env.BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    process.env.MONGO_URL = "mongodb://mongo.example.test/db";
    process.env.REDISHOST = "redis.example.test";
    const { missing, fatalCount } = inspectEnv();
    assert.ok(fatalCount > 0);
    const keys = missing.map((m) => m.key);
    assert.ok(keys.includes("ADMINS"));
    assert.ok(keys.includes("GROUP_ID"));
    assert.ok(keys.includes("HOOSHPAY_WEBHOOK_SECRET"));
  });

  test("a fully configured environment reports nothing missing", () => {
    process.env.BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    process.env.MONGO_URL = "mongodb://mongo.example.test/db";
    process.env.REDISHOST = "redis.example.test";
    process.env.ADMINS = "123456";
    process.env.GROUP_ID = "-100123456";
    process.env.WIZARD_API_URL = "https://wizard.example.test";
    process.env.VPN_API_KEY = "vpn-test-key";
    process.env.HOOSHPAY_API_KEY = "hoosh-test-key";
    process.env.HOOSHPAY_WEBHOOK_SECRET = "s".repeat(48);
    process.env.WEBHOOK_BASE_URL = "https://webhook.example.test";
    process.env.CARD_NUMBER = "6219861000000000";
    process.env.TRX_WALLET = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
    process.env.NODE_ENV = "production";

    const { missing, invalid, fatalCount } = inspectEnv();
    assert.equal(fatalCount, 0);
    assert.deepEqual(missing, [], "no missing settings expected");
    assert.deepEqual(invalid, [], "no malformed settings expected");
  });
});
