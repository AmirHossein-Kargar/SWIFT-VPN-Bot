/**
 * The guarantee that detection and investigation cannot change money, enforced twice: at runtime by the read-only
 * wrappers, and statically by scanning the code, so a later edit that reaches around them fails here.
 * tests/integration/sentinel.mongo.test.js proves the same thing against stored bytes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SentinelWriteRefused, readOnlyModel, readOnlySources } from "../../services/sentinel/readOnly.js";

const root = join(fileURLToPath(import.meta.url), "../../..");
const folder = join(root, "services/sentinel");
const source = (name) => readFileSync(join(folder, name), "utf8");
const files = readdirSync(folder).filter((name) => name.endsWith(".js"));

const MUTATORS = ["updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "findByIdAndDelete", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "insertMany", "bulkWrite", "bulkSave", "create", "save", "remove", "syncIndexes", "collection", "db"];

describe("read-only wrappers", () => {
  const calls = [];
  const fake = {
    modelName: "Fake",
    find: () => { calls.push("find"); return "rows"; },
    aggregate: (pipeline) => { calls.push("aggregate"); return pipeline; },
  };
  for (const name of MUTATORS) fake[name] = () => { calls.push(name); return "written"; };
  const wrapped = readOnlyModel(fake);

  test("reads pass through", () => {
    assert.equal(wrapped.find(), "rows");
    assert.deepEqual(wrapped.aggregate([{ $match: {} }]), [{ $match: {} }]);
  });

  test("every mutator is refused and never reaches the model", () => {
    calls.length = 0;
    for (const name of MUTATORS) {
      assert.throws(() => wrapped[name](), SentinelWriteRefused, name);
    }
    assert.deepEqual(calls, []);
  });

  test("aggregations cannot write", () => {
    for (const stage of ["$out", "$merge"]) {
      assert.throws(() => wrapped.aggregate([{ $match: {} }, { [stage]: "elsewhere" }]), SentinelWriteRefused);
    }
  });

  test("the wrapper itself cannot be modified", () => {
    assert.throws(() => { wrapped.find = () => {}; }, SentinelWriteRefused);
    assert.throws(() => { delete wrapped.find; }, SentinelWriteRefused);
  });

  test("the default sources cover every money collection, all wrapped", () => {
    const sources = readOnlySources();
    assert.deepEqual(Object.keys(sources).sort(), ["audits", "bank", "hooshpay", "nowpayments", "purchases", "tombstones", "trx", "users"]);
    for (const model of Object.values(sources)) assert.throws(() => model.updateOne(), SentinelWriteRefused);
  });
});

describe("static guarantees over services/sentinel", () => {
  test("the scan sees the real files", () => {
    assert.ok(files.length >= 10, files.join());
    assert.ok(files.includes("findingsStore.js"));
  });

  test("only readOnly.js imports a money model as a model", () => {
    const moneyModel = /import\s+\w+\s+from\s+"[^"]*models\/(User|HooshPayInvoice|NowPaymentsInvoice|CryptoInvoice|invoice|WalletPurchase|PaymentTombstone|AdminAuditLog)\.js"/;
    for (const name of files.filter((file) => file !== "readOnly.js")) {
      assert.doesNotMatch(source(name), moneyModel, name);
    }
  });

  test("no Sentinel module imports code that moves money or talks to a provider", () => {
    const forbidden = /from\s+"[^"]*(walletCredit|purchaseLedger|purchaseService|reservedFulfillment|fulfillHooshOrder|confirmBankPayment|applyStatus|ipnHandler|wizardApi|manualFulfillment|hooshpayClient|nowpaymentsClient|trxWalletScanner|createTestService|admin\/users|admin\/payments|admin\/recovery|admin\/custody)(\.js)?"/;
    for (const name of [...files.map((file) => join("services/sentinel", file)), "services/admin/sentinel.js"]) {
      assert.doesNotMatch(readFileSync(join(root, name), "utf8"), forbidden, name);
    }
  });

  test("only findingsStore.js and the job's lease helpers write", () => {
    const write = new RegExp(`\\.(${MUTATORS.filter((name) => !["create", "save", "remove", "collection", "db"].includes(name)).join("|")})\\(`);
    for (const name of files.filter((file) => file !== "findingsStore.js")) {
      assert.doesNotMatch(source(name), write, name);
    }
  });

  test("findingsStore.js knows no model but SentinelFinding", () => {
    const imports = [...source("findingsStore.js").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(imports.filter((path) => path.includes("models/")), ["../../models/SentinelFinding.js"]);
  });

  test("the admin boundary uses the audit wrapper for every mutation and never accepts a money field", () => {
    const admin = readFileSync(join(root, "services/admin/sentinel.js"), "utf8");
    assert.equal((admin.match(/runAuditedAction\(/g) || []).length, 2);
    assert.doesNotMatch(admin, /\bbalance\b\s*:/);
  });
});
