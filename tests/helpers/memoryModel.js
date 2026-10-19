/**
 * Tiny in-memory stand-in for the Mongoose calls used by the cleanup service.
 * It implements just the operators those queries use ($in, $ne, $lte, $type,
 * $not, $set, $setOnInsert, $inc, $push) so the filters are really evaluated,
 * not stubbed away.
 */
function typeOf(value) {
  if (value instanceof Date) return "date";
  if (value === null || value === undefined) return "null";
  return typeof value;
}

function matchField(value, condition) {
  if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
    return Object.entries(condition).every(([op, expected]) => {
      switch (op) {
        case "$in": return expected.some((item) => (item === null ? value == null : item === value));
        case "$nin": return !expected.some((item) => (item === null ? value == null : item === value));
        case "$ne": return value !== expected && !(expected === null && value == null);
        case "$lte": return value instanceof Date ? value <= expected : value <= expected;
        case "$type": return typeOf(value) === expected;
        case "$not": return !matchField(value, expected);
        default: throw new Error(`unsupported operator ${op}`);
      }
    });
  }
  return value === condition || (condition === null && value == null);
}

export function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((sub) => matches(doc, sub));
    return matchField(doc[key], condition);
  });
}

export function makeMemoryModel(initial = []) {
  const docs = initial.map((doc, index) => ({ _id: doc._id ?? `id${index}`, ...doc }));
  const calls = { deleteOne: 0, find: 0 };
  return {
    docs,
    calls,
    find(filter = {}) {
      calls.find += 1;
      let rows = docs.filter((doc) => matches(doc, filter));
      const query = {
        sort(spec) {
          const [[key, dir]] = Object.entries(spec);
          rows = [...rows].sort((a, b) => ((a[key] > b[key]) - (a[key] < b[key])) * dir);
          return query;
        },
        limit(n) { rows = rows.slice(0, n); return query; },
        async lean() { return rows.map((row) => ({ ...row })); },
      };
      return query;
    },
    async countDocuments(filter = {}) { return docs.filter((doc) => matches(doc, filter)).length; },
    async findOne(filter = {}) { return docs.find((doc) => matches(doc, filter)) || null; },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const doc of docs.filter((d) => matches(d, filter))) {
        Object.assign(doc, update.$set || {});
        modifiedCount += 1;
      }
      return { modifiedCount };
    },
    async updateOne(filter, update, options = {}) {
      let doc = docs.find((d) => matches(d, filter));
      if (!doc && options.upsert) {
        doc = { _id: `new${docs.length}`, ...Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== "object" || v instanceof Date)), ...(update.$setOnInsert || {}) };
        docs.push(doc);
      } else if (doc) {
        // $setOnInsert only applies on insert.
      } else {
        return { modifiedCount: 0 };
      }
      Object.assign(doc, update.$set || {});
      for (const [key, by] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + by;
      for (const [key, spec] of Object.entries(update.$push || {})) {
        doc[key] = [...(doc[key] || []), ...(spec.$each || [spec])].slice(spec.$slice || undefined);
      }
      return { modifiedCount: 1 };
    },
    async deleteOne(filter) {
      calls.deleteOne += 1;
      const index = docs.findIndex((doc) => matches(doc, filter) && (filter._id === undefined || doc._id === filter._id));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

export default { makeMemoryModel, matches };
