/**
 * In-memory stand-in for the NowPaymentsInvoice model: the subset of Mongo filter and
 * update operators the NOWPayments services use. Atomicity here is single-threaded JS
 * (each call runs to completion), which is what the services' compare-and-set filters assume.
 * `failOn(predicate)` makes matching updateOne calls reject, to simulate a database outage.
 */
export function matches(document, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((entry) => matches(document, entry));
    if (key === "$and") return condition.every((entry) => matches(document, entry));
    const value = key.split(".").reduce((current, part) => current?.[part], document);
    if (condition == null) return value == null;
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (Object.hasOwn(condition, "$in")) return condition.$in.some((item) => (item == null ? value == null : String(value) === String(item)));
      if (Object.hasOwn(condition, "$nin")) return !condition.$nin.some((item) => (item == null ? value == null || value === "" : String(value) === String(item)));
      if (Object.hasOwn(condition, "$lt")) return new Date(value) < new Date(condition.$lt);
      if (Object.hasOwn(condition, "$lte")) return value != null && new Date(value) <= new Date(condition.$lte);
      if (Object.hasOwn(condition, "$ne")) return String(value) !== String(condition.$ne);
      return false;
    }
    return String(value) === String(condition);
  });
}

export function applyUpdate(document, update) {
  for (const [path, value] of Object.entries(update.$set || {})) document[path] = value;
  for (const path of Object.keys(update.$unset || {})) delete document[path];
  for (const [path, value] of Object.entries(update.$inc || {})) document[path] = (Number(document[path]) || 0) + value;
  for (const [path, value] of Object.entries(update.$push || {})) {
    const values = value && typeof value === "object" && Array.isArray(value.$each) ? value.$each : [value];
    document[path] = [...(document[path] || []), ...values];
    if (value?.$slice != null) document[path] = value.$slice < 0 ? document[path].slice(value.$slice) : document[path].slice(0, value.$slice);
  }
}

export function makeFakeInvoiceModel(seed = []) {
  const docs = new Map(seed.map((doc, index) => [doc.orderId, { _id: `invoice-${index}`, ipnLog: [], balanceCredited: false, ...doc }]));
  let failPredicate = null;
  return {
    docs,
    failOn(predicate) { failPredicate = predicate; },
    async create(fields) {
      if ([...docs.values()].some((doc) => doc.openCreateKey && doc.openCreateKey === fields.openCreateKey)) {
        const error = new Error("duplicate open create");
        error.code = 11000;
        throw error;
      }
      docs.set(fields.orderId, { _id: `invoice-${docs.size}`, ipnLog: [], balanceCredited: false, ...fields });
      return docs.get(fields.orderId);
    },
    findOne(filter) {
      return { lean: async () => [...docs.values()].find((doc) => matches(doc, filter)) || null };
    },
    async updateOne(filter, update) {
      if (failPredicate?.(filter, update)) throw Object.assign(new Error("simulated database outage"), { name: "MongoNetworkError" });
      const doc = [...docs.values()].find((item) => matches(item, filter));
      if (!doc) return { modifiedCount: 0 };
      applyUpdate(doc, update);
      return { modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update) {
      const doc = [...docs.values()].find((item) => matches(item, filter));
      if (!doc) return null;
      applyUpdate(doc, update);
      return doc;
    },
    find(filter) {
      const found = [...docs.values()].filter((doc) => matches(doc, filter));
      return { limit() { return this; }, lean: async () => found };
    },
  };
}
