/**
 * The dashboard must not be able to change money, orders or jobs, and must not be able to slow a payment down. Both are
 * enforced statically here, so a later edit that reaches around them fails. tests/integration/reliability.mongo.test.js proves
 * the first against stored bytes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../../..");
const folder = join(root, "services/reliability");
const files = readdirSync(folder).filter((name) => name.endsWith(".js"));
const source = (name) => readFileSync(join(folder, name), "utf8");
const repo = (path) => readFileSync(join(root, path), "utf8");

describe("services/reliability cannot change business records", () => {
  test("the scan sees the real files", () => {
    assert.ok(files.length >= 10, files.join());
    assert.ok(files.includes("store.js"));
  });

  test("no module imports a money model; records come through Sentinel's read-only wrappers", () => {
    const moneyModel = /from\s+"[^"]*models\/(User|HooshPayInvoice|NowPaymentsInvoice|CryptoInvoice|invoice|WalletPurchase|PaymentTombstone|AdminAuditLog)\.js"/;
    for (const name of files) assert.doesNotMatch(source(name), moneyModel, name);
  });

  test("no module imports code that moves money, provisions, or recovers", () => {
    const forbidden = /from\s+"[^"]*(walletCredit|purchaseLedger|purchaseService|reservedFulfillment|fulfillHooshOrder|confirmBankPayment|applyStatus|ipnHandler|wizardApi|manualFulfillment|hooshpayClient|nowpaymentsClient|trxWalletScanner|createTestService|admin\/users|admin\/payments|admin\/recovery|admin\/custody|admin\/vpns)(\.js)?"/;
    for (const name of [...files.map((file) => join("services/reliability", file)), "services/admin/reliability.js"]) {
      assert.doesNotMatch(repo(name), forbidden, name);
    }
  });

  test("only store.js writes, and it knows only its own three models", () => {
    const write = /\.(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|replaceOne|deleteOne|deleteMany|insertMany|bulkWrite|bulkSave)\(/;
    for (const name of files.filter((file) => file !== "store.js")) assert.doesNotMatch(source(name), write, name);
    const imports = [...source("store.js").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(imports.sort(), ["../../models/ReliabilityEvent.js", "../../models/ReliabilityIncident.js", "../../models/ReliabilityRollup.js"]);
  });

  test("the admin boundary has no mutation: no audited action, no POST route", () => {
    const admin = repo("services/admin/reliability.js");
    assert.doesNotMatch(admin, /runAuditedAction|operationId/);
    assert.doesNotMatch(admin, /\bbalance\b\s*:/);
    const routes = repo("web/adminRouter.js").split("\n").filter((line) => line.includes('"/reliability'));
    assert.ok(routes.length >= 8);
    for (const line of routes) assert.match(line, /router\.get\(/, line);
  });

  test("every reliability route sits behind the session and rate limit middleware", () => {
    const router = repo("web/adminRouter.js");
    assert.ok(router.indexOf("router.use(requireAdminSession)") < router.indexOf('"/reliability/snapshot"'));
    assert.ok(router.indexOf("rateLimitMiddleware({ limit: 300, scope: \"admin-api\" })") < router.indexOf('"/reliability/snapshot"'));
  });

  test("nothing in the payment, wallet or order code reads what the monitor stores", () => {
    const money = ["services/walletCredit.js", "services/buyService/purchaseLedger.js", "services/buyService/purchaseService.js", "services/buyService/reservedFulfillment.js", "services/hooshpay/fulfillHooshOrder.js", "services/nowpayments/applyStatus.js", "services/payments/confirmBankPayment.js"];
    for (const path of money) assert.doesNotMatch(repo(path), /Reliability(Event|Incident|Rollup)|reliability\/(queries|collector|store|health|rules)/, path);
  });
});

describe("telemetry stays out of the way of business operations", () => {
  test("the recorder imports nothing from the application", () => {
    const imports = [...source("telemetry.js").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(imports.filter((path) => path.startsWith(".")), ["./sanitize.js"]);
    assert.ok(imports.every((path) => path.startsWith("node:") || path === "./sanitize.js"), imports.join());
  });

  test("the recorder has no I/O and no await", () => {
    const text = source("telemetry.js");
    assert.doesNotMatch(text, /\bawait\b|\bfetch\(|mongoose|redis/i);
  });

  test("the money code only calls observers, and never awaits one", () => {
    for (const path of ["api/wizardApi.js", "services/hooshpay/hooshpayClient.js", "services/nowpayments/nowpaymentsClient.js", "services/buyService/purchaseLedger.js", "services/nowpayments/recovery.js", "services/payments/invoiceCleanup.js"]) {
      assert.doesNotMatch(repo(path), /await\s+observe/, path);
    }
  });

  test("the webhook handlers themselves are unchanged: the observer sits on the route", () => {
    const server = repo("server.js");
    assert.match(server, /app\.use\("\/api\/hooshpay\/webhook", observeWebhook\("hooshpay"\)\)/);
    assert.match(server, /app\.use\("\/api\/nowpayments\/ipn", observeWebhook\("nowpayments"\)\)/);
    const handler = server.slice(server.indexOf("export async function handleHooshWebhook"), server.indexOf('app.use("/api/hooshpay/webhook"'));
    assert.doesNotMatch(handler, /observe/);
  });

  test("a wizard call rethrows the caller's own error, and is never retried by telemetry", () => {
    const client = repo("api/wizardApi.js");
    const wrapper = client.slice(client.indexOf("async function request("), client.indexOf("async function sendRequest("));
    assert.equal((wrapper.match(/sendRequest\(/g) || []).length, 1);
    assert.match(wrapper, /throw error;/);
  });
});

describe("shutdown and scheduling", () => {
  test("streams close before the HTTP server, or a deploy would hang", () => {
    const start = repo("startBot.js");
    const shutdown = start.slice(start.indexOf("async function gracefulShutdown"));
    const streams = shutdown.indexOf("stopReliabilityCron()");
    const http = shutdown.indexOf("httpServer.close(");
    const mongo = shutdown.indexOf("mongoose.disconnect()");
    assert.ok(streams > -1 && streams < http, "before HTTP");
    assert.ok(streams < mongo, "the last flush needs the database");
  });

  test("the monitor has its own try block, so it cannot block the payment crons", () => {
    assert.match(repo("startBot.js"), /try \{\s+if \(startReliabilityCron\(\)\)/);
  });

  test("there is one scheduler: no timer in any route or query", () => {
    assert.doesNotMatch(source("queries.js"), /setInterval/);
    assert.doesNotMatch(repo("services/admin/reliability.js"), /setInterval|setTimeout/);
    assert.equal((source("collector.js").match(/setInterval\(/g) || []).length, 1);
  });

  test("a second start is refused, so a re-import cannot add a timer", () => {
    assert.match(source("collector.js"), /if \(!config\.enabled \|\| timer\) return false;/);
  });

  test("every timer lets the process exit", () => {
    for (const name of ["collector.js", "stream.js"]) {
      const text = source(name);
      const timers = (text.match(/= setInterval\(|= setTimeout\(/g) || []).length;
      assert.ok(timers <= (text.match(/\.unref\?\.\(\)/g) || []).length, name);
    }
  });
});

describe("the panel", () => {
  test("no route loading file under the section", () => {
    const folder = join(root, "admin-panel/app/(app)/reliability");
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [entry.name]));
    assert.ok(!walk(folder).includes("loading.tsx"));
  });

  test("no second palette and no 3D dependency", () => {
    const css = repo("admin-panel/app/globals.css");
    const own = css.slice(css.indexOf("Service Reliability Center"));
    assert.doesNotMatch(own, /#[0-9a-f]{3,8}\b|rgb\(|(?<!-)\bhsl\((?!var\()/i);
    const packageJson = JSON.parse(repo("package.json"));
    for (const name of ["three", "@react-three/fiber", "d3", "framer-motion", "motion"]) assert.equal(packageJson.dependencies[name], undefined, name);
  });

  test("the sidebar links the section", () => {
    assert.match(repo("admin-panel/components/layout/sidebar.tsx"), /href: "\/reliability"/);
  });
});
