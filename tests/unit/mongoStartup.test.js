/**
 * MongoDB startup regression tests.
 *
 * These cover the production failure this repository hit: the HooshPay invoice
 * `uid` index existed on disk as a *unique, non-sparse* `uid_1` index while
 * the schema requires a *unique, sparse* one. MongoDB refuses to redefine an
 * index in place, so index creation failed on every startup and the bot never
 * reached Telegram polling.
 *
 * The tests run without a MongoDB server: the driver, the collection and the
 * models are fakes, and the fake collection reproduces MongoDB's
 * `IndexOptionsConflict` (code 85) when an index with the same name exists
 * with different options.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import connectDB, { MONGO_STARTUP_STAGES } from "../../config/db.js";
import {
  LEGACY_HOOSHPAY_UID_INDEX,
  TARGET_HOOSHPAY_UID_INDEX,
  LegacyIndexConflictError,
  classifyUidIndex,
  migrateLegacyIndex,
  migrateLegacyIndexes,
} from "../../config/mongoIndexMigration.js";
import { bootstrapCriticalDependencies } from "../../startBot.js";

const MONGO_ENV_KEYS = [
  "MONGO_URL", "MONGODB_URI", "MONGO_URI", "DATABASE_URL",
  "MONGOHOST", "MONGO_HOST", "MONGOPORT", "MONGO_PORT",
  "MONGOUSER", "MONGO_USER", "MONGOPASSWORD", "MONGO_PASSWORD",
  "MONGO_DB_NAME",
];

const SECRET_URL = "mongodb://appuser:sup3rSecretPw@mongo.internal:27017/swiftvpn?authSource=admin";

let savedEnv;

/** Minimal stand-in for a MongoDB collection, including the index conflict. */
function createFakeCollection(initialIndexes = []) {
  let indexes = initialIndexes.map((index) => ({ ...index }));
  const calls = { dropped: [], created: [] };

  return {
    calls,
    async indexes() {
      return indexes.map((index) => ({ ...index }));
    },
    async dropIndex(name) {
      calls.dropped.push(name);
      const before = indexes.length;
      indexes = indexes.filter((index) => index.name !== name);
      if (indexes.length === before) {
        const error = new Error(`index not found: ${name}`);
        error.code = 27;
        throw error;
      }
    },
    async createIndex(key, options = {}) {
      calls.created.push({ key, options });
      const name = options.name || Object.keys(key).join("_");
      const existing = indexes.find((index) => index.name === name);
      if (existing) {
        // MongoDB: same name, different options → IndexOptionsConflict (85).
        if (existing.unique !== Boolean(options.unique) || existing.sparse !== Boolean(options.sparse)) {
          const error = new Error("An existing index has the same name but different options");
          error.code = 85;
          throw error;
        }
        return name;
      }
      indexes.push({
        v: 2,
        key,
        name,
        ...(options.unique ? { unique: true } : {}),
        ...(options.sparse ? { sparse: true } : {}),
      });
      return name;
    },
  };
}

/** Stand-in for the mongoose instance used by config/db.js. */
function createFakeMongoose({
  connectError = null,
  pingError = null,
  indexError = null,
  models = {},
  collections = {},
} = {}) {
  const state = { connects: 0, disconnects: 0, pings: 0, createIndexesCalls: 0 };
  const connection = {
    db: {
      async command(command) {
        if (command?.ping === 1) {
          state.pings += 1;
          if (pingError) throw pingError;
        }
        return { ok: 1 };
      },
      collection(name) {
        if (!collections[name]) collections[name] = createFakeCollection();
        return collections[name];
      },
    },
  };

  const registered = {};
  for (const [modelName, collectionName] of Object.entries(models)) {
    registered[modelName] = { collection: { collectionName } };
  }

  return {
    state,
    models: registered,
    connection,
    async connect() {
      state.connects += 1;
      if (connectError) throw connectError;
      return connection;
    },
    async disconnect() {
      state.disconnects += 1;
    },
    modelNames: () => Object.keys(models),
    model: (name) => ({
      collection: { collectionName: models[name] },
      async createIndexes() {
        state.createIndexesCalls += 1;
        if (indexError) throw indexError;
        return [];
      },
    }),
  };
}

function createLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.map(String).join(" ")),
    warn: (...args) => lines.push(args.map(String).join(" ")),
    error: (...args) => lines.push(args.map(String).join(" ")),
    has: (needle) => lines.some((line) => line.includes(needle)),
  };
}

const LEGACY_INDEX = { v: 2, key: { uid: 1 }, name: "uid_1", unique: true };
const TARGET_INDEX = { v: 2, key: { uid: 1 }, name: "uid_1", unique: true, sparse: true };

beforeEach(() => {
  savedEnv = {};
  for (const key of MONGO_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MONGO_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("legacy HooshPay uid index migration", () => {
  test("replaces the exact legacy index with the required unique+sparse index", async () => {
    const collection = createFakeCollection([LEGACY_INDEX]);

    const result = await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() });

    assert.equal(result.action, "migrated");
    assert.deepEqual(collection.calls.dropped, ["uid_1"]);
    assert.equal(collection.calls.created.length, 1);
    assert.deepEqual(collection.calls.created[0].key, { uid: 1 });
    assert.equal(collection.calls.created[0].options.unique, true);
    assert.equal(collection.calls.created[0].options.sparse, true);
    assert.equal(collection.calls.created[0].options.name, "uid_1");

    const indexes = await collection.indexes();
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].sparse, true);
    assert.equal(indexes[0].unique, true);
  });

  test("is a no-op when the required index already exists (already-migrated recovery)", async () => {
    const collection = createFakeCollection([TARGET_INDEX]);

    const result = await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() });

    assert.equal(result.action, "already-migrated");
    assert.deepEqual(collection.calls.dropped, []);
    assert.deepEqual(collection.calls.created, []);
  });

  test("creates the required index when no uid index exists (interrupted migration recovery)", async () => {
    const collection = createFakeCollection([]);

    const result = await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() });

    assert.equal(result.action, "created");
    assert.deepEqual(collection.calls.dropped, []);
    assert.equal(collection.calls.created.length, 1);
    assert.equal(collection.calls.created[0].options.sparse, true);
  });

  test("fails closed on an unknown/custom index and drops nothing", async () => {
    const custom = {
      v: 2,
      key: { uid: 1 },
      name: "uid_1",
      unique: true,
      partialFilterExpression: { status: { $eq: "pending" } },
    };
    const collection = createFakeCollection([custom]);

    await assert.rejects(
      () => migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() }),
      (error) => {
        assert.ok(error instanceof LegacyIndexConflictError);
        assert.equal(error.stage, MONGO_STARTUP_STAGES.INDEX_MIGRATION);
        assert.match(error.message, /left untouched/);
        return true;
      }
    );
    assert.deepEqual(collection.calls.dropped, []);
    assert.deepEqual(collection.calls.created, []);
  });

  test("fails closed when a non-unique uid index occupies the required name", async () => {
    const collection = createFakeCollection([{ v: 2, key: { uid: 1 }, name: "uid_1" }]);

    await assert.rejects(
      () => migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() }),
      LegacyIndexConflictError
    );
    assert.deepEqual(collection.calls.dropped, []);
  });

  test("fails closed when the required name is taken by a different key", async () => {
    const collection = createFakeCollection([{ v: 2, key: { uid: 1, createdAt: -1 }, name: "uid_1" }]);

    await assert.rejects(
      () => migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() }),
      LegacyIndexConflictError
    );
    assert.deepEqual(collection.calls.dropped, []);
  });

  test("never touches unrelated indexes", async () => {
    const collection = createFakeCollection([
      LEGACY_INDEX,
      { v: 2, key: { orderId: 1 }, name: "orderId_1", unique: true },
      { v: 2, key: { status: 1, createdAt: 1 }, name: "idx_expiry_cron" },
      { v: 2, key: { userId: 1, createdAt: -1 }, name: "idx_user_recent" },
    ]);

    await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection, logger: createLogger() });

    assert.deepEqual(collection.calls.dropped, ["uid_1"]);
    const indexes = await collection.indexes();
    assert.ok(indexes.some((index) => index.name === "orderId_1"));
    assert.ok(indexes.some((index) => index.name === "idx_expiry_cron"));
    assert.ok(indexes.some((index) => index.name === "idx_user_recent"));
  });

  test("classifies only the known legacy and target definitions as replaceable", () => {
    assert.equal(classifyUidIndex(LEGACY_INDEX), "legacy");
    assert.equal(classifyUidIndex(TARGET_INDEX), "target");
    assert.equal(classifyUidIndex({ v: 2, key: { uid: 1 }, name: "uid_custom" }), "unknown");
    assert.equal(classifyUidIndex({ v: 2, key: { uid: 1 }, name: "uid_1", unique: true, collation: { locale: "en" } }), "unknown");
    assert.equal(classifyUidIndex({ v: 2, key: { orderId: 1 }, name: "orderId_1", unique: true }), "unknown");
  });

  test("migrateLegacyIndexes resolves the collection through the registered model", async () => {
    const collection = createFakeCollection([LEGACY_INDEX]);
    const db = { collection: (name) => (name === "hooshpayinvoices" ? collection : createFakeCollection()) };

    const results = await migrateLegacyIndexes({
      db,
      models: { HooshPayInvoice: { collection: { collectionName: "hooshpayinvoices" } } },
      logger: createLogger(),
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "migrated");
    assert.equal(results[0].model, "HooshPayInvoice");
    assert.deepEqual(collection.calls.dropped, ["uid_1"]);
  });
});

describe("connectDB startup attribution", () => {
  test("connects, pings, migrates and creates the indexes", async () => {
    process.env.MONGO_URL = "mongodb://mongo.internal:27017/swiftvpn";
    const collection = createFakeCollection([LEGACY_INDEX]);
    const mongooseInstance = createFakeMongoose({ models: { HooshPayInvoice: "hooshpayinvoices" }, collections: { hooshpayinvoices: collection } });
    const logger = createLogger();

    const connection = await connectDB({ logger, mongooseInstance });

    assert.equal(connection, mongooseInstance.connection);
    assert.equal(mongooseInstance.state.connects, 1);
    assert.equal(mongooseInstance.state.pings, 1);
    assert.equal(mongooseInstance.state.createIndexesCalls, 1);
    assert.equal(mongooseInstance.state.disconnects, 0);
    assert.ok(logger.has("MongoDB connected and indexes checked"));
  });

  test("reports a missing configuration without touching the driver", async () => {
    const mongooseInstance = createFakeMongoose();
    const logger = createLogger();

    await assert.rejects(
      () => connectDB({ logger, mongooseInstance }),
      (error) => {
        assert.equal(error.stage, MONGO_STARTUP_STAGES.CONFIG);
        assert.equal(error.dependency, "mongodb");
        assert.match(error.message, /not configured/);
        return true;
      }
    );
    assert.equal(mongooseInstance.state.connects, 0);
    assert.equal(mongooseInstance.state.disconnects, 0);
  });

  test("attributes a connection failure and disconnects", async () => {
    process.env.MONGO_URL = "mongodb://mongo.internal:27017/swiftvpn";
    const connectError = new Error("connection to mongodb://appuser:sup3rSecretPw@mongo.internal timed out");
    connectError.name = "MongooseServerSelectionError";
    connectError.code = "ECONNREFUSED";
    const mongooseInstance = createFakeMongoose({ connectError });

    await assert.rejects(
      () => connectDB({ logger: createLogger(), mongooseInstance }),
      (error) => {
        assert.equal(error.stage, MONGO_STARTUP_STAGES.CONNECT);
        assert.equal(error.code, "ECONNREFUSED");
        assert.equal(error.errorType, "MongooseServerSelectionError");
        return true;
      }
    );
    assert.equal(mongooseInstance.state.disconnects, 1);
  });

  test("attributes a ping failure and disconnects", async () => {
    process.env.MONGO_URL = "mongodb://mongo.internal:27017/swiftvpn";
    const pingError = new Error("ping failed");
    pingError.name = "MongoNetworkError";
    pingError.code = 89;
    const mongooseInstance = createFakeMongoose({ pingError });

    await assert.rejects(
      () => connectDB({ logger: createLogger(), mongooseInstance }),
      (error) => {
        assert.equal(error.stage, MONGO_STARTUP_STAGES.PING);
        assert.equal(error.code, 89);
        return true;
      }
    );
    assert.equal(mongooseInstance.state.disconnects, 1);
  });

  test("attributes an index migration failure and disconnects", async () => {
    process.env.MONGO_URL = "mongodb://mongo.internal:27017/swiftvpn";
    const custom = { v: 2, key: { uid: 1 }, name: "uid_1", unique: true, hidden: true };
    const collection = createFakeCollection([custom]);
    const mongooseInstance = createFakeMongoose({ models: { HooshPayInvoice: "hooshpayinvoices" }, collections: { hooshpayinvoices: collection } });

    await assert.rejects(
      () => connectDB({ logger: createLogger(), mongooseInstance }),
      (error) => {
        assert.equal(error.stage, MONGO_STARTUP_STAGES.INDEX_MIGRATION);
        assert.equal(error.dependency, "mongodb");
        // The conflicting index must be named so an operator can act on it.
        assert.match(error.message, /uid_1/);
        assert.match(error.message, /left untouched/);
        return true;
      }
    );
    assert.equal(mongooseInstance.state.disconnects, 1);
    assert.equal(mongooseInstance.state.createIndexesCalls, 0);
    assert.deepEqual(collection.calls.dropped, []);
  });

  test("attributes an index initialization failure and disconnects", async () => {
    process.env.MONGO_URL = "mongodb://mongo.internal:27017/swiftvpn";
    const indexError = new Error("IndexOptionsConflict");
    indexError.name = "MongoServerError";
    indexError.code = 85;
    const mongooseInstance = createFakeMongoose({ models: { HooshPayInvoice: "hooshpayinvoices" }, indexError });

    await assert.rejects(
      () => connectDB({ logger: createLogger(), mongooseInstance }),
      (error) => {
        assert.equal(error.stage, MONGO_STARTUP_STAGES.INDEX_INIT);
        assert.equal(error.code, 85);
        return true;
      }
    );
    assert.equal(mongooseInstance.state.disconnects, 1);
  });

  test("replaces the legacy index before the schema indexes are created", async () => {
    // This is the exact production failure: without the migration the schema's
    // createIndex() call collides with the legacy uid_1 index (code 85).
    process.env.MONGO_URL = "mongodb://mongo.internal:27017/swiftvpn";
    const collection = createFakeCollection([LEGACY_INDEX]);
    const mongooseInstance = createFakeMongoose({ models: { HooshPayInvoice: "hooshpayinvoices" }, collections: { hooshpayinvoices: collection } });

    await connectDB({ logger: createLogger(), mongooseInstance });

    assert.deepEqual(collection.calls.dropped, ["uid_1"]);
    const indexes = await collection.indexes();
    assert.equal(indexes[0].sparse, true);
    assert.equal(indexes[0].unique, true);
    assert.equal(mongooseInstance.state.createIndexesCalls, 1);
  });

  test("never leaks the connection string or credentials", async () => {
    process.env.MONGO_URL = SECRET_URL;
    const connectError = new Error(`cannot connect to ${SECRET_URL}`);
    connectError.name = "MongooseError";
    const mongooseInstance = createFakeMongoose({ connectError });
    const logger = createLogger();

    const error = await connectDB({ logger, mongooseInstance }).then(
      () => null,
      (thrown) => thrown
    );

    assert.ok(error, "the connection failure must be reported");
    assert.ok(!error.message.includes("sup3rSecretPw"), "the password must not appear in the message");
    assert.ok(!error.message.includes("mongodb://"), "the URI must not appear in the message");
    for (const line of logger.lines) {
      assert.ok(!line.includes("sup3rSecretPw"), "the password must not appear in the logs");
      assert.ok(!line.includes("mongodb://"), "the URI must not appear in the logs");
    }
  });
});

describe("startup ordering", () => {
  test("aborts the startup when MongoDB fails and never reaches Redis", async () => {
    const calls = [];
    const failure = Object.assign(new Error("MongoDB connection failed"), {
      stage: MONGO_STARTUP_STAGES.CONNECT,
      dependency: "mongodb",
    });

    await assert.rejects(
      () =>
        bootstrapCriticalDependencies({
          connect: async () => {
            calls.push("mongo");
            throw failure;
          },
          seed: async () => {
            calls.push("seed");
            return 0;
          },
          connectRedisClient: async () => {
            calls.push("redis");
          },
          logger: createLogger(),
        }),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error.stage, MONGO_STARTUP_STAGES.CONNECT);
        return true;
      }
    );

    assert.deepEqual(calls, ["mongo"]);
  });

  test("connects MongoDB before Redis", async () => {
    const calls = [];
    await bootstrapCriticalDependencies({
      connect: async () => {
        calls.push("mongo");
      },
      seed: async () => {
        calls.push("seed");
        return 2;
      },
      connectRedisClient: async () => {
        calls.push("redis");
      },
      logger: createLogger(),
    });

    assert.deepEqual(calls, ["mongo", "seed", "redis"]);
  });

  test("startBot connects MongoDB before Telegram polling starts", () => {
    const source = readFileSync(fileURLToPath(new URL("../../startBot.js", import.meta.url)), "utf8");
    const dbIndex = source.indexOf("await bootstrapCriticalDependencies()");
    const botIndex = source.indexOf("new TelegramBot(");
    const pollingIndex = source.indexOf("polling: { autoStart: false }");

    assert.ok(dbIndex > -1, "startBot must await the critical dependencies");
    assert.ok(botIndex > dbIndex, "the Telegram bot must be created after MongoDB is ready");
    assert.ok(pollingIndex > botIndex, "Telegram polling must not start before the bot exists");
  });

  test("bot.js starts polling only after every update handler is registered", () => {
    // The library drops an update with no listener, so polling any earlier loses whatever was queued during a restart.
    const source = readFileSync(fileURLToPath(new URL("../../bot.js", import.meta.url)), "utf8");
    const startPolling = source.indexOf("bot.startPolling()");

    assert.ok(startPolling > -1, "bot.js must start polling itself: startBot.js creates the bot with autoStart off");
    for (const handler of ['bot.on("message"', 'bot.on("callback_query"', 'bot.on("photo"', 'bot.on("video"', 'registerUnsupportedMedia("document"']) {
      const last = source.lastIndexOf(handler);
      assert.ok(last > -1 && last < startPolling, `${handler} must be registered before polling starts`);
    }
  });
});
