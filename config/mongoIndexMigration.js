/**
 * Narrow, safe migration for the legacy HooshPay `uid` index.
 *
 * Why this exists
 * ---------------
 * `HooshPayInvoice.uid` used to be declared `unique: true` WITHOUT
 * `sparse: true`. MongoDB keeps the index definition that was created on
 * disk, so the collection still carries a `uid_1` index that is unique but
 * NOT sparse. The current schema requires a unique SPARSE index, and MongoDB
 * refuses to redefine an existing index in place:
 *
 *     IndexOptionsConflict (85) — an existing index has the same name but
 *     different options
 *
 * `Model.createIndexes()` therefore fails on every startup, and the bot never
 * reaches Telegram polling.
 *
 * Safety rules
 * ------------
 * • Exactly ONE index definition is replaceable: `hooshpayinvoices.uid_1`
 *   with key `{ uid: 1 }`, `unique: true`, not sparse, and without any
 *   partial/TTL/collation/weight options — the legacy shape this repository
 *   shipped. Anything else is never dropped.
 * • An index that would collide with the required definition but does not
 *   match the known legacy shape (custom name, custom options, non-unique)
 *   makes the migration FAIL CLOSED: nothing is dropped and startup stops
 *   with an actionable message, so an operator decides what to do.
 * • Replacing the legacy index can only RELAX the constraint (a sparse unique
 *   index allows many documents without `uid`), so the replacement can never
 *   produce a duplicate-key error. This matters in practice: an invoice is
 *   written BEFORE the provider assigns its `uid`, so a non-sparse unique
 *   index would reject the second pending invoice of the collection.
 * • The migration is idempotent: a collection that already carries the target
 *   index is left untouched, and a collection without any `uid` index gets the
 *   target index created (this also repairs a run that was interrupted between
 *   the drop and the create).
 * • Every other index in the collection is ignored — it is neither dropped
 *   nor inspected for options.
 */
import { MONGO_STARTUP_STAGES, StartupDependencyError, safeErrorDetail } from "./startupDiagnostics.js";

const FIELD = "uid";

/**
 * Index options that change index semantics. Their presence means the index
 * is a custom one and must not be dropped automatically.
 */
const SEMANTIC_OPTIONS = Object.freeze([
  "partialFilterExpression",
  "expireAfterSeconds",
  "collation",
  "weights",
  "wildcardProjection",
  "storageEngine",
  "hidden",
  "prepareUnique",
]);

/** The single legacy index definition this migration is allowed to replace. */
export const LEGACY_HOOSHPAY_UID_INDEX = Object.freeze({
  model: "HooshPayInvoice",
  collection: "hooshpayinvoices",
  name: "uid_1",
  key: Object.freeze({ uid: 1 }),
  unique: true,
  sparse: false,
});

/** The index definition the current schema requires. */
export const TARGET_HOOSHPAY_UID_INDEX = Object.freeze({
  name: "uid_1",
  key: Object.freeze({ uid: 1 }),
  unique: true,
  sparse: true,
});

/** Registry of replaceable legacy indexes. Keep this list minimal. */
export const LEGACY_INDEX_MIGRATIONS = Object.freeze([LEGACY_HOOSHPAY_UID_INDEX]);

/** Raised when an unknown/custom index blocks the required definition. */
export class LegacyIndexConflictError extends StartupDependencyError {
  constructor(message, { cause, index } = {}) {
    super(MONGO_STARTUP_STAGES.INDEX_MIGRATION, message, {
      cause,
      dependency: "mongodb",
    });
    this.name = "LegacyIndexConflictError";
    if (index?.name) this.indexName = index.name;
  }
}

function indexKey(index) {
  const key = index?.key;
  return key && typeof key === "object" ? key : {};
}

function isTargetKey(key) {
  const fields = Object.keys(key);
  return fields.length === 1 && fields[0] === FIELD && Number(key[FIELD]) === 1;
}

function semanticOptionsOf(index) {
  return SEMANTIC_OPTIONS.filter((option) => index?.[option] !== undefined);
}

/**
 * Sanitized description of an index: name, key fields, unique/sparse flags.
 * No option values, no document data.
 */
export function describeIndex(index) {
  const key = indexKey(index);
  const fields = Object.keys(key)
    .sort()
    .map((field) => `${field}: ${key[field]}`);
  return {
    name: typeof index?.name === "string" ? index.name : "(unnamed)",
    key: fields.length ? `{ ${fields.join(", ")} }` : "(none)",
    unique: index?.unique === true,
    sparse: index?.sparse === true,
  };
}

/**
 * Classify an index that could collide with the required `uid` definition.
 * @returns {"target"|"legacy"|"unknown"}
 */
export function classifyUidIndex(index) {
  const key = indexKey(index);
  const name = typeof index?.name === "string" ? index.name : "";
  const customOptions = semanticOptionsOf(index);

  // Only the exact known name may be replaced; a different name is a custom
  // index and is never dropped.
  if (name !== TARGET_HOOSHPAY_UID_INDEX.name) return "unknown";
  if (!isTargetKey(key)) return "unknown";
  if (customOptions.length > 0) return "unknown";

  const unique = index?.unique === true;
  const sparse = index?.sparse === true;
  if (unique && sparse) return "target";
  if (unique && !sparse) return "legacy";
  return "unknown";
}

/** An index that could collide with the required definition. */
function isUidCandidate(index) {
  const name = typeof index?.name === "string" ? index.name : "";
  return name === TARGET_HOOSHPAY_UID_INDEX.name || isTargetKey(indexKey(index));
}

async function listIndexes(collection) {
  try {
    const indexes = await collection.indexes();
    return Array.isArray(indexes) ? indexes : [];
  } catch (error) {
    // A collection that does not exist yet simply has no indexes.
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

/**
 * Replace the known legacy index with the definition the schema requires.
 *
 * @param {object} spec      One entry of LEGACY_INDEX_MIGRATIONS.
 * @param {object} options
 * @param {object} options.collection  A MongoDB collection (indexes/dropIndex/createIndex).
 * @param {object} [options.logger]
 * @returns {Promise<{action:string, index:object}>}
 */
export async function migrateLegacyIndex(spec, { collection, logger = console } = {}) {
  if (!collection || typeof collection.indexes !== "function") {
    throw new Error("migrateLegacyIndex requires a MongoDB collection");
  }

  const indexes = await listIndexes(collection);
  const candidates = indexes.filter(isUidCandidate);
  const conflicts = candidates.filter((index) => classifyUidIndex(index) === "unknown");

  if (conflicts.length > 0) {
    // Fail closed: an index this migration does not manage occupies the
    // migrated field. It is left exactly as it is.
    const described = conflicts.map(describeIndex);
    throw new LegacyIndexConflictError(
      `MongoDB index conflict on ${spec.collection}: an index named "${described[0].name}" ` +
        `(key: ${described[0].key}, unique: ${described[0].unique}, sparse: ${described[0].sparse}) already exists on the migrated field ` +
        `but is not a definition this migration manages. It was left untouched — reconcile it manually before restarting.`,
      { index: described[0] }
    );
  }

  const legacy = candidates.find((index) => classifyUidIndex(index) === "legacy");
  const target = candidates.find((index) => classifyUidIndex(index) === "target");

  if (legacy) {
    await collection.dropIndex(legacy.name);
    await collection.createIndex(TARGET_HOOSHPAY_UID_INDEX.key, {
      unique: TARGET_HOOSHPAY_UID_INDEX.unique,
      sparse: TARGET_HOOSHPAY_UID_INDEX.sparse,
      name: TARGET_HOOSHPAY_UID_INDEX.name,
    });
    logger.log?.(
      `MongoDB index migration: replaced the legacy ${spec.model}.${legacy.name} index with the current unique+sparse definition`
    );
    return { action: "migrated", index: describeIndex(TARGET_HOOSHPAY_UID_INDEX) };
  }

  if (target) {
    // Already migrated (or never legacy) — nothing to replace.
    return { action: "already-migrated", index: describeIndex(target) };
  }

  // No `uid` index at all: make sure the required definition exists. This
  // also repairs an interrupted run that dropped the legacy index but died
  // before the replacement was created.
  await collection.createIndex(TARGET_HOOSHPAY_UID_INDEX.key, {
    unique: TARGET_HOOSHPAY_UID_INDEX.unique,
    sparse: TARGET_HOOSHPAY_UID_INDEX.sparse,
    name: TARGET_HOOSHPAY_UID_INDEX.name,
  });
  logger.log?.(
    `MongoDB index migration: created the required ${spec.model}.${TARGET_HOOSHPAY_UID_INDEX.name} index (unique+sparse)`
  );
  return { action: "created", index: describeIndex(TARGET_HOOSHPAY_UID_INDEX) };
}

/**
 * Run every registered legacy index migration.
 *
 * @param {object} options
 * @param {object} options.db       A MongoDB Db instance (driver level).
 * @param {object} [options.models] Registered mongoose models.
 * @param {object} [options.logger]
 */
export async function migrateLegacyIndexes({ db, models = {}, logger = console } = {}) {
  const results = [];
  for (const spec of LEGACY_INDEX_MIGRATIONS) {
    const model = models?.[spec.model];
    const collectionName = model?.collection?.collectionName || spec.collection;
    if (!db || typeof db.collection !== "function") {
      throw new Error("migrateLegacyIndexes requires a MongoDB database handle");
    }
    const collection = db.collection(collectionName);
    try {
      const result = await migrateLegacyIndex(spec, { collection, logger });
      results.push({ model: spec.model, collection: collectionName, ...result });
    } catch (error) {
      if (error instanceof LegacyIndexConflictError) throw error;
      throw new StartupDependencyError(
        MONGO_STARTUP_STAGES.INDEX_MIGRATION,
        `MongoDB index migration failed for ${spec.model}.${spec.name} (${safeErrorDetail(error)}). The migration did not complete — review the index definitions manually.`,
        { cause: error, dependency: "mongodb" }
      );
    }
  }
  return results;
}

export default migrateLegacyIndexes;
