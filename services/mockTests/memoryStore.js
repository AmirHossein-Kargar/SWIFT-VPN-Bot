/**
 * In-memory stand-in for the subset of the Mongoose model API that the money
 * paths use. Mock-test scenarios inject these models into the real production
 * services (purchasePlan, applyNowPaymentsUpdate, fulfillHooshOrder, ...) so the
 * real business rules run while nothing is written to MongoDB.
 *
 * Every operation is applied synchronously to one document after a microtask
 * yield, which mirrors MongoDB's single-document atomicity while still letting
 * concurrent callers interleave between operations. Unique indexes are enforced
 * (as sparse indexes: null/missing values are not indexed) and report E11000.
 */
import { randomBytes } from "node:crypto";

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function isOperatorObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key.startsWith("$"));
}

/** All values reachable at a dotted path; arrays are traversed like MongoDB does. */
function valuesAt(doc, path) {
  let values = [doc];
  for (const segment of path.split(".")) {
    const next = [];
    for (const value of values) {
      if (Array.isArray(value)) {
        for (const item of value) if (item != null && Object.hasOwn(Object(item), segment)) next.push(item[segment]);
        if (/^\d+$/.test(segment) && value[Number(segment)] !== undefined) next.push(value[Number(segment)]);
      } else if (value != null && typeof value === "object" && Object.hasOwn(value, segment)) {
        next.push(value[segment]);
      }
    }
    values = next;
  }
  return values;
}

function scalarEquals(a, b) {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a != null && b != null && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** Equality against a field: an array field matches when any element matches. */
function fieldEquals(values, expected) {
  if (expected === null) return values.length === 0 || values.some((value) => value == null);
  return values.some((value) => scalarEquals(value, expected)
    || (Array.isArray(value) && value.some((item) => scalarEquals(item, expected))));
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function compareSome(values, expected, predicate) {
  const target = comparable(expected);
  if (target == null) return false;
  const flat = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  return flat.some((value) => {
    const current = comparable(value);
    return current != null && typeof current === typeof target && predicate(current, target);
  });
}

function typeName(value) {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  return typeof value;
}

function matchOperators(values, operators) {
  return Object.entries(operators).every(([operator, expected]) => {
    switch (operator) {
      case "$eq": return fieldEquals(values, expected);
      case "$ne": return !fieldEquals(values, expected);
      case "$in": return expected.some((candidate) => fieldEquals(values, candidate));
      case "$nin": return !expected.some((candidate) => fieldEquals(values, candidate));
      case "$gt": return compareSome(values, expected, (a, b) => a > b);
      case "$gte": return compareSome(values, expected, (a, b) => a >= b);
      case "$lt": return compareSome(values, expected, (a, b) => a < b);
      case "$lte": return compareSome(values, expected, (a, b) => a <= b);
      case "$exists": return expected ? values.length > 0 : values.length === 0;
      case "$not": return !matchOperators(values, expected);
      case "$type": return values.some((value) => typeName(value) === expected);
      case "$size": return values.some((value) => Array.isArray(value) && value.length === expected);
      case "$elemMatch": return values.some((value) => Array.isArray(value) && value.some((item) => (
        isPlainObject(item) && !isOperatorObject(expected) ? matchesFilter(item, expected) : matchOperators([item], expected)
      )));
      case "$regex": {
        const pattern = expected instanceof RegExp ? expected : new RegExp(expected, operators.$options || "");
        return values.some((value) => typeof value === "string" && pattern.test(value));
      }
      case "$options": return true;
      default: throw new Error(`memoryStore: unsupported query operator ${operator}`);
    }
  });
}

export function matchesFilter(doc, filter = {}) {
  return Object.entries(filter || {}).every(([key, condition]) => {
    if (key === "$or") return condition.some((sub) => matchesFilter(doc, sub));
    if (key === "$and") return condition.every((sub) => matchesFilter(doc, sub));
    if (key === "$nor") return !condition.some((sub) => matchesFilter(doc, sub));
    const values = valuesAt(doc, key);
    if (condition instanceof RegExp) return values.some((value) => typeof value === "string" && condition.test(value));
    if (isOperatorObject(condition)) return matchOperators(values, condition);
    return fieldEquals(values, condition);
  });
}

function setPath(doc, path, value) {
  const parts = path.split(".");
  let target = doc;
  for (const segment of parts.slice(0, -1)) {
    if (target[segment] == null || typeof target[segment] !== "object") target[segment] = {};
    target = target[segment];
  }
  target[parts.at(-1)] = value;
}

function getPath(doc, path) {
  return path.split(".").reduce((value, segment) => (value == null ? undefined : value[segment]), doc);
}

function unsetPath(doc, path) {
  const parts = path.split(".");
  let target = doc;
  for (const segment of parts.slice(0, -1)) {
    target = target?.[segment];
    if (target == null) return;
  }
  delete target[parts.at(-1)];
}

function applyUpdate(doc, update, { inserting = false } = {}) {
  const ops = isOperatorObject(update) ? update : { $set: update };
  for (const [operator, fields] of Object.entries(ops)) {
    for (const [path, raw] of Object.entries(fields || {})) {
      const value = clone(raw);
      switch (operator) {
        case "$set": setPath(doc, path, value); break;
        case "$setOnInsert": if (inserting) setPath(doc, path, value); break;
        case "$unset": unsetPath(doc, path); break;
        case "$inc": setPath(doc, path, Number(getPath(doc, path) || 0) + Number(value)); break;
        case "$min": if (getPath(doc, path) == null || value < getPath(doc, path)) setPath(doc, path, value); break;
        case "$max": if (getPath(doc, path) == null || value > getPath(doc, path)) setPath(doc, path, value); break;
        case "$push": {
          const list = Array.isArray(getPath(doc, path)) ? getPath(doc, path) : [];
          const items = isPlainObject(value) && Object.hasOwn(value, "$each") ? value.$each : [value];
          list.push(...items);
          const slice = isPlainObject(value) ? value.$slice : undefined;
          setPath(doc, path, Number.isInteger(slice) ? (slice < 0 ? list.slice(slice) : list.slice(0, slice)) : list);
          break;
        }
        case "$addToSet": {
          const list = Array.isArray(getPath(doc, path)) ? getPath(doc, path) : [];
          const items = isPlainObject(value) && Object.hasOwn(value, "$each") ? value.$each : [value];
          for (const item of items) if (!list.some((existing) => scalarEquals(existing, item))) list.push(item);
          setPath(doc, path, list);
          break;
        }
        case "$pull": {
          const list = Array.isArray(getPath(doc, path)) ? getPath(doc, path) : [];
          setPath(doc, path, list.filter((item) => (isPlainObject(value) ? !matchesFilter(item, value) : !scalarEquals(item, value))));
          break;
        }
        default: throw new Error(`memoryStore: unsupported update operator ${operator}`);
      }
    }
  }
  return doc;
}

function duplicateKeyError(model, fields) {
  const error = new Error(`E11000 duplicate key error collection: ${model} index: ${fields.join("_")}`);
  error.code = 11000;
  error.name = "MongoServerError";
  return error;
}

function sortRows(rows, spec) {
  const keys = Object.entries(spec || {});
  return [...rows].sort((a, b) => {
    for (const [key, direction] of keys) {
      const left = comparable(getPath(a, key)) ?? -Infinity;
      const right = comparable(getPath(b, key)) ?? -Infinity;
      if (left < right) return direction < 0 ? 1 : -1;
      if (left > right) return direction < 0 ? -1 : 1;
    }
    return 0;
  });
}

const microtask = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {string} name   Collection label used in errors and reports.
 * @param {object} [options]
 * @param {string[][]} [options.unique]  Unique (sparse) indexes, e.g. [["purchaseId"]].
 * @param {() => object} [options.defaults]  Schema-like defaults applied on insert.
 * @param {{ failNext?: (op: string, filter: object) => Error|null }} [options.faults]  Fault injection hook.
 */
export function createMemoryModel(name, { unique = [], defaults = () => ({}), faults = null } = {}) {
  const rows = [];
  const stats = { reads: 0, writes: 0 };

  function maybeFault(operation, filter) {
    const error = faults?.failNext?.(operation, filter) || null;
    if (error) throw error;
  }

  function assertUnique(candidate, ignoreId = null) {
    for (const fields of unique) {
      const values = fields.map((field) => getPath(candidate, field));
      if (values.some((value) => value == null)) continue;
      const clash = rows.find((row) => row._id !== ignoreId
        && fields.every((field, index) => scalarEquals(getPath(row, field), values[index])));
      if (clash) throw duplicateKeyError(name, fields);
    }
  }

  function hydrate(row) {
    if (!row) return null;
    const doc = clone(row);
    Object.defineProperties(doc, {
      toObject: { value: () => stripMethods(doc), enumerable: false },
      save: {
        enumerable: false,
        value: async () => {
          await microtask();
          stats.writes += 1;
          const index = rows.findIndex((r) => r._id === doc._id);
          const next = stripMethods(doc);
          assertUnique(next, doc._id);
          if (index === -1) rows.push(next); else rows[index] = next;
          return doc;
        },
      },
    });
    return doc;
  }

  function stripMethods(doc) {
    return clone({ ...doc });
  }

  function query(execute, { single }) {
    let lean = false;
    let sortSpec = null;
    let skipCount = 0;
    let limitCount = null;
    const run = async () => {
      await microtask();
      stats.reads += 1;
      let result = execute();
      if (Array.isArray(result)) {
        if (sortSpec) result = sortRows(result, sortSpec);
        result = result.slice(skipCount, limitCount == null ? undefined : skipCount + limitCount);
        return result.map((row) => (lean ? clone(row) : hydrate(row)));
      }
      if (result && typeof result === "object" && !single) return result;
      if (!result) return null;
      return lean ? clone(result) : hydrate(result);
    };
    const chain = {
      lean() { lean = true; return chain; },
      select() { return chain; },
      populate() { return chain; },
      sort(spec) { sortSpec = spec; return chain; },
      skip(n) { skipCount = Number(n) || 0; return chain; },
      limit(n) { limitCount = Number(n) || null; return chain; },
      session() { return chain; },
      exec: run,
      then(resolve, reject) { return run().then(resolve, reject); },
      catch(reject) { return run().catch(reject); },
    };
    return chain;
  }

  function insert(fields) {
    const row = applyUpdate({ ...clone(defaults()), _id: randomBytes(12).toString("hex") }, {}, { inserting: true });
    Object.assign(row, clone(fields));
    if (fields?._id != null) row._id = String(fields._id);
    if (!row.createdAt) row.createdAt = new Date();
    if (!row.updatedAt) row.updatedAt = row.createdAt;
    assertUnique(row);
    rows.push(row);
    return row;
  }

  function upsertSeed(filter) {
    const seed = {};
    for (const [key, value] of Object.entries(filter || {})) {
      if (key.startsWith("$") || isOperatorObject(value)) continue;
      setPath(seed, key, clone(value));
    }
    return seed;
  }

  function updateRow(row, update) {
    const next = applyUpdate(clone(row), update);
    next.updatedAt = isPlainObject(update) && update.$set?.updatedAt ? next.updatedAt : new Date();
    assertUnique(next, row._id);
    Object.keys(row).forEach((key) => delete row[key]);
    Object.assign(row, next);
    return row;
  }

  const model = {
    modelName: name,
    rows,
    stats,
    async create(fields) {
      await microtask();
      maybeFault("create", fields);
      stats.writes += 1;
      if (Array.isArray(fields)) return fields.map((entry) => hydrate(insert(entry)));
      return hydrate(insert(fields));
    },
    find(filter = {}) {
      return query(() => rows.filter((row) => matchesFilter(row, filter)), { single: false });
    },
    findOne(filter = {}) {
      return query(() => {
        maybeFault("findOne", filter);
        return rows.find((row) => matchesFilter(row, filter)) || null;
      }, { single: true });
    },
    findById(id) {
      return query(() => rows.find((row) => String(row._id) === String(id)) || null, { single: true });
    },
    findOneAndUpdate(filter = {}, update = {}, options = {}) {
      return query(() => {
        maybeFault("findOneAndUpdate", filter);
        stats.writes += 1;
        const returnNew = options.new === true || options.returnDocument === "after";
        let row = rows.find((candidate) => matchesFilter(candidate, filter));
        if (!row) {
          if (!options.upsert) return null;
          row = applyUpdate({ ...clone(defaults()), _id: randomBytes(12).toString("hex"), ...upsertSeed(filter) }, update, { inserting: true });
          row.createdAt ||= new Date();
          assertUnique(row);
          rows.push(row);
          return returnNew ? row : null;
        }
        const before = clone(row);
        updateRow(row, update);
        return returnNew ? row : before;
      }, { single: true });
    },
    findByIdAndUpdate(id, update, options = {}) {
      return model.findOneAndUpdate({ _id: String(id) }, update, options);
    },
    async updateOne(filter = {}, update = {}, options = {}) {
      await microtask();
      maybeFault("updateOne", filter);
      stats.writes += 1;
      const row = rows.find((candidate) => matchesFilter(candidate, filter));
      if (!row) {
        if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        const created = applyUpdate({ ...clone(defaults()), _id: randomBytes(12).toString("hex"), ...upsertSeed(filter) }, update, { inserting: true });
        created.createdAt ||= new Date();
        assertUnique(created);
        rows.push(created);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
      }
      updateRow(row, update);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },
    async updateMany(filter = {}, update = {}) {
      await microtask();
      stats.writes += 1;
      const matched = rows.filter((row) => matchesFilter(row, filter));
      for (const row of matched) updateRow(row, update);
      return { acknowledged: true, matchedCount: matched.length, modifiedCount: matched.length };
    },
    async countDocuments(filter = {}) {
      await microtask();
      return rows.filter((row) => matchesFilter(row, filter)).length;
    },
    exists(filter = {}) {
      return query(() => {
        const row = rows.find((candidate) => matchesFilter(candidate, filter));
        return row ? { _id: row._id } : null;
      }, { single: false });
    },
    async deleteOne(filter = {}) {
      await microtask();
      const index = rows.findIndex((row) => matchesFilter(row, filter));
      if (index === -1) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter = {}) {
      await microtask();
      const keep = rows.filter((row) => !matchesFilter(row, filter));
      const deletedCount = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { deletedCount };
    },
    /** Synchronous snapshot helpers for assertions (never used by production code). */
    snapshot(filter = {}) { return rows.filter((row) => matchesFilter(row, filter)).map(clone); },
    peek(filter = {}) { const row = rows.find((candidate) => matchesFilter(candidate, filter)); return row ? clone(row) : null; },
  };
  return model;
}

/**
 * The isolated data set for one mock scenario. Indexes mirror the production
 * schemas that the scenarios depend on for idempotency.
 */
export function createMockDataset({ faults = {} } = {}) {
  return {
    users: createMemoryModel("users", {
      unique: [["telegramId"]],
      defaults: () => ({
        balance: 0,
        successfulPayments: 0,
        appliedPaymentKeys: [],
        appliedAdminBalanceKeys: [],
        appliedPurchaseReservations: [],
        refundedPurchaseIds: [],
        completedPurchaseIds: [],
        services: [],
        totalServices: 0,
        hasReceivedTest: false,
      }),
      faults: faults.users,
    }),
    purchases: createMemoryModel("walletpurchases", {
      unique: [["purchaseId"]],
      defaults: () => ({ status: "reserving", walletDebitStatus: "not_debited", refundStatus: "none", recoveryStatus: "none" }),
      faults: faults.purchases,
    }),
    nowpayments: createMemoryModel("nowpaymentsinvoices", {
      unique: [["orderId"], ["openCreateKey"], ["invoiceId"], ["paymentId"]],
      defaults: () => ({ balanceCredited: false, recoveryStatus: "none", ipnLog: [] }),
      faults: faults.nowpayments,
    }),
    hooshpay: createMemoryModel("hooshpayinvoices", {
      unique: [["orderId"], ["uid"], ["openCreateKey"]],
      defaults: () => ({ fulfilled: false, balanceCredited: false, recoveryStatus: "none", webhookLog: [], notificationPending: false, notificationClaimedAt: null }),
      faults: faults.hooshpay,
    }),
    bank: createMemoryModel("invoices", {
      unique: [["paymentId"]],
      defaults: () => ({ balanceCredited: false, notificationPending: false, notificationClaimedAt: null }),
      faults: faults.bank,
    }),
    audit: createMemoryModel("adminauditlogs", {
      unique: [["operationId"]],
      defaults: () => ({ status: "started", metadata: {} }),
      faults: faults.audit,
    }),
  };
}

export default { createMemoryModel, createMockDataset, matchesFilter };
