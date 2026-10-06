function valuesAtPath(document, path) {
  let values = [document];
  for (const segment of path.split(".")) {
    values = values.flatMap((value) => {
      if (Array.isArray(value)) return value.map((entry) => entry?.[segment]).filter((entry) => entry !== undefined);
      return value?.[segment] === undefined ? [] : [value[segment]];
    });
  }
  return values;
}

function matches(document, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or") {
      if (!condition.some((entry) => matches(document, entry))) return false;
      continue;
    }
    if (key === "$and") {
      if (!condition.every((entry) => matches(document, entry))) return false;
      continue;
    }

    const values = valuesAtPath(document, key);
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (Object.hasOwn(condition, "$gte") && !values.some((value) => Number(value) >= Number(condition.$gte))) return false;
      if (Object.hasOwn(condition, "$lt") && !values.some((value) => new Date(value) < new Date(condition.$lt))) return false;
      if (Object.hasOwn(condition, "$ne") && values.some((value) => {
        const list = Array.isArray(value) ? value : [value];
        return list.some((entry) => String(entry) === String(condition.$ne));
      })) return false;
      if (Object.hasOwn(condition, "$in") && !condition.$in.some((candidate) => values.some((value) => String(value) === String(candidate)))) return false;
      if (Object.hasOwn(condition, "$eq") && !values.some((value) => String(value) === String(condition.$eq))) return false;
      continue;
    }

    if (!values.some((value) => {
      const list = Array.isArray(value) ? value : [value];
      return list.some((entry) => String(entry) === String(condition));
    })) return false;
  }
  return true;
}

function setPath(document, path, value) {
  const parts = path.split(".");
  let target = document;
  for (const segment of parts.slice(0, -1)) target = target[segment] ||= {};
  target[parts.at(-1)] = value;
}

function applyUpdate(document, update) {
  for (const [path, value] of Object.entries(update.$set || {})) setPath(document, path, value);
  for (const [path, amount] of Object.entries(update.$inc || {})) {
    const current = valuesAtPath(document, path)[0] || 0;
    setPath(document, path, Number(current) + Number(amount));
  }
  for (const [path, value] of Object.entries(update.$addToSet || {})) {
    const current = valuesAtPath(document, path)[0];
    const list = Array.isArray(current) ? current : [];
    if (!list.some((entry) => String(entry) === String(value))) list.push(value);
    setPath(document, path, list);
  }
  for (const [path, value] of Object.entries(update.$push || {})) {
    const current = valuesAtPath(document, path)[0];
    const list = Array.isArray(current) ? current : [];
    list.push(value);
    setPath(document, path, list);
  }
  for (const path of Object.keys(update.$unset || {})) {
    const parts = path.split(".");
    let target = document;
    for (const segment of parts.slice(0, -1)) target = target?.[segment];
    if (target) delete target[parts.at(-1)];
  }
}

class FakeQuery {
  constructor(read) { this.read = read; }
  select() { return this; }
  lean() { return Promise.resolve(this.read()); }
  then(resolve, reject) { return this.lean().then(resolve, reject); }
}

/** Lightweight deterministic store for unit testing service orchestration only. */
export function makeFakeWalletModels(initialUsers = []) {
  const users = new Map(initialUsers.map((user) => [String(user.telegramId), {
    telegramId: String(user.telegramId),
    balance: Number(user.balance || 0),
    successfulPayments: 0,
    appliedPaymentKeys: [],
    appliedAdminBalanceKeys: [],
    appliedPurchaseReservations: [],
    refundedPurchaseIds: [],
    completedPurchaseIds: [],
    totalServices: 0,
    services: [],
    ...user,
  }]));
  const purchases = new Map();

  const userModel = {
    async findOneAndUpdate(filter, update) {
      const user = users.get(String(filter.telegramId));
      if (!user || !matches(user, filter)) return null;
      applyUpdate(user, update);
      return user;
    },
    findOne(filter) {
      return new FakeQuery(() => [...users.values()].find((user) => matches(user, filter)) || null);
    },
    async exists(filter) {
      return [...users.values()].some((user) => matches(user, filter)) ? { _id: "fake-user" } : null;
    },
  };

  const purchaseModel = {
    async create(fields) {
      if (purchases.has(fields.purchaseId)) {
        const error = new Error("duplicate purchase ID");
        error.code = 11000;
        throw error;
      }
      const purchase = {
        status: "reserving",
        walletDebitStatus: "not_debited",
        refundStatus: "none",
        recoveryStatus: "none",
        createdAt: new Date(),
        ...fields,
      };
      purchases.set(purchase.purchaseId, purchase);
      return purchase;
    },
    async findOneAndUpdate(filter, update) {
      const purchase = [...purchases.values()].find((item) => matches(item, filter));
      if (!purchase) return null;
      applyUpdate(purchase, update);
      return purchase;
    },
    findOne(filter) {
      return new FakeQuery(() => [...purchases.values()].find((purchase) => matches(purchase, filter)) || null);
    },
    async updateOne(filter, update) {
      const purchase = [...purchases.values()].find((item) => matches(item, filter));
      if (!purchase) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(purchase, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  return { userModel, purchaseModel, users, purchases };
}
