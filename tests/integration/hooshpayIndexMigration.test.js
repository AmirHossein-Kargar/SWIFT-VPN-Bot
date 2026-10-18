/**
 * Legacy HooshPay `uid` index migration — REAL MongoDB.
 *
 * Reproduces the production failure end to end: a `uid_1` index that exists
 * on disk as unique-but-NOT-sparse makes the schema's `createIndexes()` fail
 * with IndexOptionsConflict (code 85), which used to abort every startup
 * before Telegram polling could begin.
 *
 * Skipped automatically when no MongoDB is reachable.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

// Availability must be known BEFORE the test cases are declared, because the
// `skip` option is evaluated at declaration time.
const dbAvailable = await connectTestDB();

let HooshPayInvoice;
let migrateLegacyIndex;
let LegacyIndexConflictError;
let LEGACY_HOOSHPAY_UID_INDEX;
if (dbAvailable) {
  ({ default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js"));
  ({
    migrateLegacyIndex,
    LegacyIndexConflictError,
    LEGACY_HOOSHPAY_UID_INDEX,
  } = await import("../../config/mongoIndexMigration.js"));
}

after(async () => {
  await disconnectTestDB();
});

const opts = () => ({ skip: dbAvailable ? false : "MongoDB not reachable" });
const collection = () => mongoose.connection.db.collection("hooshpayinvoices");
const quietLogger = { log: () => {} };

/** Drop every index of the collection; a missing collection is not an error. */
async function resetIndexes() {
  try {
    await collection().dropIndexes();
  } catch (error) {
    if (error?.code !== 26) throw error; // NamespaceNotFound
  }
}

async function indexInfo(name = "uid_1") {
  const indexes = await collection().indexes();
  return indexes.find((index) => index.name === name) || null;
}

describe("HooshPay uid index migration — real MongoDB", () => {
  test("the legacy index really does break the schema's index creation", opts(), async () => {
    await resetIndexes();
    // The legacy shape: unique, but NOT sparse.
    await collection().createIndex({ uid: 1 }, { unique: true, name: "uid_1" });

    const legacy = await indexInfo();
    assert.equal(legacy.unique, true);
    assert.notEqual(legacy.sparse, true, "the legacy index must not be sparse");

    await assert.rejects(
      () => HooshPayInvoice.createIndexes(),
      (error) => {
        // MongoDB refuses to redefine an existing index: 85 = options
        // conflict, 86 = key specification conflict.
        assert.ok([85, 86].includes(error.code), `expected an index conflict, got code ${error.code}`);
        return true;
      }
    );
  });

  test("replaces the legacy index and lets the schema create its indexes", opts(), async () => {
    await resetIndexes();
    await collection().createIndex({ uid: 1 }, { unique: true, name: "uid_1" });
    await collection().insertOne({ orderId: "HP-legacy-1", userId: 1, amount: 1000, status: "pending" });

    const result = await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, {
      collection: collection(),
      logger: quietLogger,
    });

    assert.equal(result.action, "migrated");

    const migrated = await indexInfo();
    assert.equal(migrated.unique, true);
    assert.equal(migrated.sparse, true);
    assert.deepEqual(migrated.key, { uid: 1 });

    // The failure that used to abort every startup is gone.
    await HooshPayInvoice.createIndexes();

    // Documents are untouched by the migration.
    const stored = await collection().findOne({ orderId: "HP-legacy-1" });
    assert.ok(stored, "the invoice must survive the index migration");
    assert.equal(stored.amount, 1000);
  });

  test("a sparse unique index allows several invoices without a uid", opts(), async () => {
    await resetIndexes();
    await collection().createIndex({ uid: 1 }, { unique: true, name: "uid_1" });
    await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection: collection(), logger: quietLogger });

    // The legacy (non-sparse) unique index forbade a second document without
    // a uid; the sparse one allows it.
    await collection().insertOne({ orderId: "HP-no-uid-1", userId: 2, amount: 1000, status: "pending" });
    await collection().insertOne({ orderId: "HP-no-uid-2", userId: 3, amount: 1000, status: "pending" });

    const count = await collection().countDocuments({ uid: { $exists: false } });
    assert.equal(count, 2);
  });

  test("is a no-op when the required index already exists", opts(), async () => {
    await resetIndexes();
    await collection().createIndex({ uid: 1 }, { unique: true, sparse: true, name: "uid_1" });

    const result = await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, {
      collection: collection(),
      logger: quietLogger,
    });

    assert.equal(result.action, "already-migrated");
    const indexes = await collection().indexes();
    assert.equal(indexes.filter((index) => index.name === "uid_1").length, 1);
  });

  test("fails closed on a custom uid index and leaves it untouched", opts(), async () => {
    await resetIndexes();
    await collection().createIndex(
      { uid: 1 },
      { unique: true, name: "uid_1", partialFilterExpression: { status: { $eq: "pending" } } }
    );

    await assert.rejects(
      () => migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection: collection(), logger: quietLogger }),
      LegacyIndexConflictError
    );

    // The custom index must still be there, untouched.
    const custom = await indexInfo();
    assert.ok(custom.partialFilterExpression, "the custom index must not be dropped");
  });

  test("unrelated indexes survive the migration", opts(), async () => {
    await resetIndexes();
    await collection().createIndex({ uid: 1 }, { unique: true, name: "uid_1" });
    await collection().createIndex({ orderId: 1 }, { unique: true, name: "orderId_1" });
    await collection().createIndex({ status: 1, createdAt: 1 }, { name: "idx_expiry_cron" });

    await migrateLegacyIndex(LEGACY_HOOSHPAY_UID_INDEX, { collection: collection(), logger: quietLogger });

    const names = (await collection().indexes()).map((index) => index.name);
    assert.ok(names.includes("orderId_1"));
    assert.ok(names.includes("idx_expiry_cron"));
  });
});
