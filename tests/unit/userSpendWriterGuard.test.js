/**
 * Detects future code that completes a wallet purchase without feeding the persisted spend counters.
 *
 * Static scan of the application sources (tests, vendor and build output excluded) for code that WRITES
 * `status: "completed"`. The expected writer set is what ships in the repository: exactly one live writer,
 * services/buyService/purchaseLedger.js, which schedules the recompute. A new writer fails this test.
 *
 * services/manualFulfillment.js is local, unpublished work that is not part of the repository (untracked, so it is
 * absent from a clean checkout) and this test must not depend on it either way: it passes with or without that file
 * present. It is therefore excluded from the writer list only; if it is ever wired into the application, the
 * importer check below requires it to feed the counters.
 *
 * The sweeper would still repair the counters for any missed writer; this test makes the omission visible at review
 * time. Limitation: a status built dynamically (not a literal "completed") is invisible to a static scan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", "node-compile-cache", ".git", ".next", "tests", "admin-panel", "storefront", "docs", ".githooks", "public"]);

function sources(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.(js|mjs)$/.test(entry)) found.push(full);
  }
  return found;
}

const WRITE = /(\$set|\$setOnInsert|\.create|insertOne|insertMany|updateOne|findOneAndUpdate)\b[^;]{0,700}?\bstatus\s*:\s*["']completed["']/s;
const rel = (file) => relative(root, file).split(sep).join("/");
const all = sources(root).map((file) => ({ path: rel(file), text: readFileSync(file, "utf8") }));

// Local, untracked work in progress: not part of the committed sources, so never part of the expected writer set.
const UNPUBLISHED_LOCAL_MODULE = "services/manualFulfillment.js";

test("the detector recognises every way a purchase can be written as completed, and not mere reads", () => {
  const writes = [
    'await Model.updateOne({ id }, { $set: { status: "completed" } })',
    "Model.findOneAndUpdate({ purchaseId }, { $set: { walletDebitStatus: 'finalized', status: 'completed' } })",
    'await Model.create({ purchaseId, status: "completed" })',
    'collection.insertOne({ status:"completed" })',
  ];
  const reads = ['Model.find({ status: "completed" })', 'Model.countDocuments({ status: "completed" })', '{ $match: { status: "completed" } }'];
  for (const sample of writes) assert.match(sample, WRITE, sample);
  for (const sample of reads) assert.doesNotMatch(sample, WRITE, sample);
});

test("every code path that writes status 'completed' in the committed sources is the known, hooked writer", () => {
  const writers = all.filter((file) => WRITE.test(file.text)).map((file) => file.path).filter((path) => path !== UNPUBLISHED_LOCAL_MODULE).sort();
  assert.deepEqual(writers, ["services/buyService/purchaseLedger.js"],
    "a new file writes status 'completed': it must call scheduleUserSpendRecompute() after the write (services/users/userSpend.js)");
});

test("the live completion writer schedules the persisted-spend recompute, after the commit and never awaited", () => {
  const ledger = all.find((file) => file.path === "services/buyService/purchaseLedger.js").text;
  assert.match(ledger, /import \{ scheduleUserSpendRecompute \} from "\.\.\/users\/userSpend\.js"/);
  assert.match(ledger, /^\s*scheduleUserSpendRecompute\(/m);
  assert.doesNotMatch(ledger, /await\s+scheduleUserSpendRecompute/);
  assert.ok(ledger.indexOf("scheduleUserSpendRecompute(") > ledger.indexOf('status: "completed"'), "scheduled after the completion write");
});

test("the unpublished manual fulfillment module is not wired into the application; if it ever is, it must feed the counters", () => {
  const manual = all.find((file) => file.path === UNPUBLISHED_LOCAL_MODULE);
  const importers = all.filter((file) => file.path !== UNPUBLISHED_LOCAL_MODULE && /manualFulfillment(\.js)?["']/.test(file.text)).map((file) => file.path);
  if (importers.length === 0 || !manual) return;                       // not wired in (or not present): nothing to enforce
  assert.match(manual.text, /scheduleUserSpendRecompute/, `${importers.join(", ")} import services/manualFulfillment.js, which completes purchases without updating the spend counters`);
});

test("no other module writes the spend counters", () => {
  const writers = all.filter((file) => /\b(totalSpent|completedOrderCount)\b\s*:/.test(file.text) && /\$set|\$inc|\$max|bulkWrite|updateOne|findOneAndUpdate/.test(file.text))
    .map((file) => file.path)
    .filter((path) => !["services/users/userSpend.js", "services/users/userSpendSweeper.js", "services/users/userSpendMaintenance.js", "services/admin/users.js", "services/admin/analytics.js", "services/admin/analyticsReport.js", "services/admin/dashboard.js", "services/admin/collectionStats.js", "models/User.js"].includes(path))
    .sort();
  assert.deepEqual(writers, []);
});
