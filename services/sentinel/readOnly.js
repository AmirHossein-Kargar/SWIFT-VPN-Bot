/**
 * The only door from Sentinel to the money collections, and it opens one way.
 *
 * Every detection, projection and investigation query goes through these wrappers, which expose read methods and nothing
 * else: a mutator is simply not there, and any other property access throws. Aggregations are checked for write stages.
 * tests/unit/sentinelReadOnly.test.js proves this and scans services/sentinel so a direct model import cannot slip in.
 */
import User from "../../models/User.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import BankInvoice from "../../models/invoice.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import PaymentTombstone from "../../models/PaymentTombstone.js";
import AdminAuditLog from "../../models/AdminAuditLog.js";

const READ_METHODS = new Set(["find", "findOne", "findById", "countDocuments", "estimatedDocumentCount", "exists", "distinct"]);
const WRITE_STAGES = new Set(["$out", "$merge"]);

export class SentinelWriteRefused extends Error {
  constructor(member) {
    super(`Sentinel has read-only access to money records; "${String(member)}" is not available`);
    this.name = "SentinelWriteRefused";
  }
}

export function readOnlyModel(model) {
  const allowed = {
    modelName: model.modelName,
    aggregate(pipeline = []) {
      for (const stage of pipeline) {
        for (const name of Object.keys(stage || {})) {
          if (WRITE_STAGES.has(name)) throw new SentinelWriteRefused(name);
        }
      }
      return model.aggregate(pipeline);
    },
  };
  for (const method of READ_METHODS) {
    if (typeof model[method] === "function") allowed[method] = (...args) => model[method](...args);
  }
  return new Proxy(Object.freeze(allowed), {
    get(target, member) {
      if (typeof member === "symbol") return undefined;
      if (member === "then") return undefined; // a wrapper is never awaited as a thenable
      if (Object.hasOwn(target, member)) return target[member];
      throw new SentinelWriteRefused(member);
    },
    set(_target, member) { throw new SentinelWriteRefused(member); },
    deleteProperty(_target, member) { throw new SentinelWriteRefused(member); },
  });
}

/** Tests inject memory models here; production uses the real collections, wrapped. */
export function readOnlySources(models = {}) {
  return Object.freeze({
    users: readOnlyModel(models.users || User),
    hooshpay: readOnlyModel(models.hooshpay || HooshPayInvoice),
    nowpayments: readOnlyModel(models.nowpayments || NowPaymentsInvoice),
    bank: readOnlyModel(models.bank || BankInvoice),
    trx: readOnlyModel(models.trx || CryptoInvoice),
    purchases: readOnlyModel(models.purchases || WalletPurchase),
    tombstones: readOnlyModel(models.tombstones || PaymentTombstone),
    audits: readOnlyModel(models.audits || AdminAuditLog),
  });
}

let defaults = null;
export function defaultSources() {
  defaults ||= readOnlySources();
  return defaults;
}
