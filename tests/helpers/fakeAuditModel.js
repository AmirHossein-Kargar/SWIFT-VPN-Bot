/**
 * In-memory stand-in for the AdminAuditLog Mongoose model, covering exactly what runAuditedAction and the
 * API-purchase ledger use: create (unique operationId -> E11000), findOne, updateOne, and find with equality,
 * $in and $nin filters plus the sort/limit/select/lean chain. Nothing here touches MongoDB.
 *
 * Persistence is faithful to Mongoose: `docs` holds the PERSISTED records, while create()/findOne() hand out
 * separate mutable documents. Changing a document in memory does not change the stored record until save()
 * succeeds, so a failed save() leaves the persisted row exactly as it was.
 *
 * Query semantics mirrored from MongoDB: equality, $in, and $nin (which also matches a missing field);
 * updateOne applies a single-record conditional update and reports modifiedCount 1 only when the filter still matched,
 * which is the compare-and-set primitive the reconciliation recovery relies on.
 *
 * Fault injection (`state`): failCreate / failFind / failSave / failUpdate (everything), or the predicate forms
 * failCreateIf(fields) / failFindIf(filter) / failFindOneIf(query) / failUpdateIf(query, update) to fail selected calls.
 */
export function makeAuditModel({ failCreate = false, failFind = false, failSave = false, failUpdate = false } = {}) {
  const docs = new Map();
  let seq = 0;
  const state = {
    failCreate, failFind, failSave, failUpdate,
    failCreateIf: null, failFindIf: null, failFindOneIf: null, failUpdateIf: null,
  };

  const matches = (doc, filter) => Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) return expected.$in.includes(doc[key]);
    if (expected && typeof expected === "object" && "$nin" in expected) return !expected.$nin.includes(doc[key]);
    return doc[key] === expected;
  });

  const toDocument = (row) => {
    const doc = { ...row };
    doc.save = async () => {
      if (state.failSave) throw Object.assign(new Error("connection lost"), { name: "MongoNetworkError" });
      const { save, ...plain } = doc;
      Object.assign(row, plain);
      return doc;
    };
    return doc;
  };

  return {
    docs,
    state,
    all: () => [...docs.values()],
    byAction: (action) => [...docs.values()].filter((row) => row.action === action),
    async create(fields) {
      if (state.failCreate || state.failCreateIf?.(fields)) throw new Error("audit store unavailable");
      if (docs.has(fields.operationId)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      seq += 1;
      const row = { createdAt: new Date(Date.now() + seq), result: null, errorCode: null, completedAt: null, ...fields, _id: `audit_${seq}`, status: fields.status ?? "started" };
      docs.set(fields.operationId, row);
      return toDocument(row);
    },
    async findOne(query) {
      if (state.failFindOneIf?.(query)) throw new Error("audit store unavailable");
      const row = [...docs.values()].find((candidate) => matches(candidate, query));
      return row ? toDocument(row) : null;
    },
    async updateOne(query, update) {
      if (state.failUpdate || state.failUpdateIf?.(query, update)) throw new Error("audit store unavailable");
      const row = [...docs.values()].find((candidate) => matches(candidate, query));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, update.$set || {});
      return { modifiedCount: 1 };
    },
    find(filter = {}) {
      if (state.failFind || state.failFindIf?.(filter)) throw new Error("audit store unavailable");
      const chain = { _sort: null, _limit: null };
      chain.sort = (spec) => { chain._sort = spec; return chain; };
      chain.limit = (count) => { chain._limit = count; return chain; };
      chain.select = () => chain;
      chain.lean = async () => {
        let items = [...docs.values()].filter((row) => matches(row, filter));
        if (chain._sort) {
          const [[key, direction]] = Object.entries(chain._sort);
          items = items.sort((a, b) => (new Date(a[key]) - new Date(b[key])) * direction);
        }
        if (chain._limit) items = items.slice(0, chain._limit);
        return items.map((row) => ({ ...row }));
      };
      return chain;
    },
  };
}
