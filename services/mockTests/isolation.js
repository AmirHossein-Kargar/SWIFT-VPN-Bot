/**
 * Runtime isolation for mock-test runs.
 *
 * A mock run executes inside an AsyncLocalStorage context. While that context
 * is active, every static query/mutation on the production Mongoose models and
 * every outbound HTTP(S)/fetch request throws a MockIsolationError and is
 * recorded as a violation. Outside a mock context the wrappers are a plain
 * pass-through, so customer traffic in the same process is unaffected.
 *
 * Scenarios inject in-memory models and fake provider adapters explicitly; the
 * guard is the second line of defence that turns any accidental fall-through
 * to a real model, a real provider, or Telegram into a hard, reported failure
 * instead of a silent production write.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";

const context = new AsyncLocalStorage();

const GUARDED_STATICS = Object.freeze([
  "find", "findOne", "findById", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete",
  "findByIdAndDelete", "findOneAndReplace", "updateOne", "updateMany", "replaceOne", "create",
  "insertMany", "deleteOne", "deleteMany", "countDocuments", "estimatedDocumentCount", "exists",
  "bulkWrite", "aggregate", "distinct",
]);

const guardedModels = new WeakSet();
let networkGuarded = false;

export class MockIsolationError extends Error {
  constructor(target) {
    super(`Mock isolation violation: ${target} is not reachable during a mock-test run`);
    this.name = "MockIsolationError";
    this.code = "MOCK_ISOLATION_VIOLATION";
  }
}

function trip(target) {
  const store = context.getStore();
  if (!store?.mock) return;
  if (store.violations.length < 50) store.violations.push(target);
  throw new MockIsolationError(target);
}

export function isMockContext() {
  return Boolean(context.getStore()?.mock);
}

/** Wrap a production model's statics and document save() with the tripwire. */
export function guardModel(model, label = model?.modelName || "model") {
  if (!model || guardedModels.has(model)) return model;
  for (const name of GUARDED_STATICS) {
    const original = model[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(model, name, {
      configurable: true,
      writable: true,
      value: function guardedStatic(...args) {
        trip(`${label}.${name}`);
        return original.apply(this, args);
      },
    });
  }
  const proto = model.prototype;
  if (proto && typeof proto.save === "function") {
    const originalSave = proto.save;
    Object.defineProperty(proto, "save", {
      configurable: true,
      writable: true,
      value: function guardedSave(...args) {
        trip(`${label}#save`);
        return originalSave.apply(this, args);
      },
    });
  }
  guardedModels.add(model);
  return model;
}

/** Block outbound network I/O (axios, Telegram, fetch) inside mock contexts. */
export function guardNetwork() {
  if (networkGuarded) return;
  for (const [label, module] of [["http", http], ["https", https]]) {
    for (const method of ["request", "get"]) {
      const original = module[method];
      module[method] = function guardedRequest(...args) {
        trip(`${label}.${method}`);
        return original.apply(this, args);
      };
    }
  }
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(...args) {
      trip("fetch");
      return originalFetch.apply(this, args);
    };
  }
  networkGuarded = true;
}

let installed = null;

/**
 * Install guards on every production model. Imported lazily so this module
 * stays cheap to load and the model list is resolved once.
 */
export async function installIsolationGuards() {
  if (installed) return installed;
  installed = (async () => {
    const modules = await Promise.all([
      import("../../models/User.js"),
      import("../../models/WalletPurchase.js"),
      import("../../models/HooshPayInvoice.js"),
      import("../../models/NowPaymentsInvoice.js"),
      import("../../models/CryptoInvoice.js"),
      import("../../models/invoice.js"),
      import("../../models/AdminAuditLog.js"),
      import("../../models/AdminAccount.js"),
      import("../../models/AdminProduct.js"),
      import("../../models/AdminBroadcast.js"),
      import("../../models/PaymentTombstone.js"),
      import("../../models/SystemHealth.js"),
    ]);
    const labels = [];
    for (const module of modules) {
      const model = module.default;
      guardModel(model);
      labels.push(model?.modelName || "model");
    }
    guardNetwork();
    return labels;
  })();
  try {
    return await installed;
  } catch (error) {
    installed = null;
    throw error;
  }
}

/**
 * Run `fn` inside an isolated mock context. Returns the function result plus
 * every isolation violation observed — including ones swallowed by a
 * production `.catch(() => {})`.
 */
export async function runIsolated(meta, fn) {
  const store = { mock: true, ...meta, violations: [] };
  try {
    const value = await context.run(store, fn);
    return { value, violations: [...store.violations] };
  } catch (error) {
    error.isolationViolations = [...store.violations];
    throw error;
  }
}

export default { installIsolationGuards, runIsolated, isMockContext, guardModel, guardNetwork, MockIsolationError };
