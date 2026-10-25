/**
 * In-memory stand-ins for the support models and the Telegram bot. The model
 * fake evaluates the operators the support service really uses ($ne, $gt,
 * $in, $regex, $set, $inc, $max, $addToSet) and emulates unique-index violations
 * (code 11000), so ownership filters and idempotency are exercised for real.
 */
let counter = 0;

function matchValue(value, condition) {
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
    return Object.entries(condition).every(([op, expected]) => {
      switch (op) {
        case "$ne": return value !== expected;
        case "$gt": return value > expected;
        case "$lt": return value < expected;
        case "$nin": return !expected.includes(value);
        case "$in": return expected.includes(value);
        case "$regex": return new RegExp(expected, condition.$options || "").test(String(value ?? ""));
        case "$options": return true;
        default: throw new Error(`unsupported operator ${op}`);
      }
    });
  }
  if (Array.isArray(value)) return value.includes(condition);
  return value === condition;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => matchValue(doc[key], condition));
}

function applyUpdate(doc, update) {
  for (const [key, value] of Object.entries(update.$set || {})) doc[key] = value;
  for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + value;
  for (const [key, value] of Object.entries(update.$max || {})) doc[key] = Math.max(doc[key] || 0, value);
  for (const [key, value] of Object.entries(update.$addToSet || {})) {
    doc[key] = doc[key] || [];
    if (!doc[key].includes(value)) doc[key].push(value);
  }
}

export function makeFakeModel({ unique = [], defaults = () => ({}) } = {}) {
  const docs = [];
  const clone = (doc) => (doc ? structuredClone(doc) : doc);
  const cursor = (rows) => {
    let result = rows;
    const api = {
      sort(spec) {
        const [[key, dir]] = Object.entries(spec);
        result = [...result].sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
        return api;
      },
      skip(n) { result = result.slice(n); return api; },
      limit(n) { result = result.slice(0, n); return api; },
      async lean() { return result.map(clone); },
      then(resolve, reject) { return Promise.resolve(result.map(clone)).then(resolve, reject); },
    };
    return api;
  };
  const one = (doc) => ({
    async lean() { return clone(doc); },
    then(resolve, reject) { return Promise.resolve(clone(doc)).then(resolve, reject); },
  });
  return {
    docs,
    async create(fields) {
      for (const key of unique) {
        if (fields[key] !== undefined && docs.some((doc) => doc[key] === fields[key])) throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      counter += 1;
      const doc = { _id: counter.toString(16).padStart(24, "0"), createdAt: new Date(counter), ...defaults(), ...fields };
      docs.push(doc);
      return clone(doc);
    },
    findOne(filter) { return one(docs.find((doc) => matches(doc, filter))); },
    find(filter = {}) { return cursor(docs.filter((doc) => matches(doc, filter))); },
    async countDocuments(filter = {}) { return docs.filter((doc) => matches(doc, filter)).length; },
    findOneAndUpdate(filter, update) {
      const doc = docs.find((item) => matches(item, filter));
      if (doc) applyUpdate(doc, update);
      return one(doc);
    },
    async updateOne(filter, update) {
      const doc = docs.find((item) => matches(item, filter));
      if (doc) applyUpdate(doc, update);
      return { matchedCount: doc ? 1 : 0 };
    },
    async updateMany(filter, update) {
      const hit = docs.filter((item) => matches(item, filter));
      for (const doc of hit) {
        if (Array.isArray(update)) {
          // Aggregation-pipeline update: only the $set/$ifNull shape the migration uses.
          for (const stage of update) {
            for (const [key, value] of Object.entries(stage.$set || {})) {
              doc[key] = value && typeof value === "object" && value.$ifNull
                ? value.$ifNull.map((arg) => (typeof arg === "string" && arg.startsWith("$") ? doc[arg.slice(1)] : arg)).find((v) => v != null)
                : value;
            }
          }
        } else applyUpdate(doc, update);
      }
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    async deleteOne(filter) {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index >= 0) docs.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
  };
}

export function makeSupportDeps() {
  return {
    Ticket: makeFakeModel({ unique: ["ticketId", "createKey"], defaults: () => ({ unreadForAdmin: 0, unreadForCustomer: 0, messageCount: 0, closedAt: null, closedBy: null }) }),
    Message: makeFakeModel({ unique: ["dedupeKey"], defaults: () => ({ groupMessageIds: [], delivery: "pending", attachment: null, text: "" }) }),
  };
}

/** Recording Telegram bot. `failOn` makes the named method reject with a Telegram-shaped error. */
export function makeFakeBot({ failOn = [] } = {}) {
  let nextId = 1000;
  const calls = [];
  const record = (method) => async (...args) => {
    const call = { method, args, result: null };
    calls.push(call);
    if (failOn.includes(method)) throw Object.assign(new Error(`Telegram ${method} failed`), { response: { statusCode: 403 } });
    call.result = { message_id: ++nextId };
    return call.result;
  };
  const bot = {
    calls,
    sendMessage: record("sendMessage"),
    sendPhoto: record("sendPhoto"),
    sendVideo: record("sendVideo"),
    editMessageText: record("editMessageText"),
    deleteMessage: record("deleteMessage"),
    answerCallbackQuery: record("answerCallbackQuery"),
    of(method) { return calls.filter((call) => call.method === method); },
  };
  return bot;
}

/** In-memory stand-in for the Redis string commands used by the session store. */
export function makeSessionClient() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); return "OK"; },
    async del(key) { map.delete(key); return 1; },
  };
}
