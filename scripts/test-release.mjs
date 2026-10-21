#!/usr/bin/env node
/**
 * Release / CI verification: the full test suite against a DISPOSABLE MongoDB and Redis, with nothing allowed to skip.
 *
 *   TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test REDIS_URL=redis://127.0.0.1:<port> npm run test:release
 *
 * Refuses to start unless both targets are provably disposable:
 *   - loopback host, an explicit NON-default port (27017 / 6379 are where real local services live), database name contains "test";
 *   - the MongoDB server holds only system databases and swiftvpn_test* databases (read-only listing);
 *   - the Redis server is empty (DBSIZE 0).
 * Then runs `node --test` with REQUIRE_MONGO_TESTS=1 and REQUIRE_REDIS_TESTS=1 (unavailable => failure, not skip) and exits
 * non-zero on any failure OR any skipped test: a skip is "not verified", never "passed".
 */
import { spawn } from "node:child_process";
import mongoose from "mongoose";
import { createClient } from "redis";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SYSTEM_DBS = new Set(["admin", "config", "local"]);
const refuse = (message) => { console.error(`✖ test:release refused: ${message}`); process.exit(2); };

function parse(name, value, { defaultPort, protocols }) {
  if (!value) refuse(`${name} is not set`);
  let url;
  try { url = new URL(value); } catch { refuse(`${name} is not a valid URL`); }
  if (!protocols.includes(url.protocol)) refuse(`${name} must use ${protocols.join(" or ")}`);
  if (!LOOPBACK.has(url.hostname)) refuse(`${name} must point at a loopback host, not "${url.hostname}"`);
  if (!url.port) refuse(`${name} must name an explicit port`);
  if (Number(url.port) === defaultPort) refuse(`${name} uses default port ${defaultPort}, where a real local service may live; start a disposable instance on another port`);
  return url;
}

const mongoUrl = parse("TEST_MONGO_URL", process.env.TEST_MONGO_URL, { defaultPort: 27017, protocols: ["mongodb:"] });
const dbName = mongoUrl.pathname.replace(/^\//, "");
if (!/test/i.test(dbName)) refuse('TEST_MONGO_URL database name must contain "test"');
const redisUrl = parse("REDIS_URL", process.env.REDIS_URL, { defaultPort: 6379, protocols: ["redis:"] });

// Read-only probes: prove the servers are disposable before any test touches them.
try {
  const connection = await mongoose.createConnection(`${mongoUrl.protocol}//${mongoUrl.host}/admin`, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const { databases } = await connection.db.admin().listDatabases({ nameOnly: true });
  await connection.close();
  const foreign = databases.map((entry) => entry.name).filter((name) => !SYSTEM_DBS.has(name) && !/^swiftvpn_test/i.test(name));
  if (foreign.length) refuse(`the MongoDB server holds non-disposable databases (${foreign.slice(0, 5).join(", ")}); refusing to run tests on it`);
} catch (error) {
  if (error?.exitCode !== undefined) throw error;
  refuse(`MongoDB is not reachable at ${mongoUrl.host} (${error?.name || "error"})`);
}
{
  const client = createClient({ url: redisUrl.toString(), socket: { connectTimeout: 4000, reconnectStrategy: false } });
  client.on("error", () => {});
  try {
    await client.connect();
    if ((await client.ping()) !== "PONG") refuse("Redis did not answer PING");
    const size = await client.dbSize();
    if (size !== 0) refuse(`the Redis server holds ${size} key(s); refusing to run tests on a non-empty Redis`);
  } catch (error) {
    refuse(`Redis is not reachable at ${redisUrl.host} (${error?.name || "error"})`);
  } finally {
    try { await client.quit(); } catch { /* ignore */ }
  }
}

console.log(`test:release targets: MongoDB ${mongoUrl.host} (disposable, db "${dbName}"), Redis ${redisUrl.host} (empty). Skips are treated as failures.`);
const child = spawn(process.execPath, ["--test", "tests/**/*.test.js"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, REQUIRE_MONGO_TESTS: "1", REQUIRE_REDIS_TESTS: "1" },
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.on("close", (code) => {
  const count = (label) => Number((output.match(new RegExp(`^ℹ ${label} (\\d+)`, "m")) || [])[1] ?? NaN);
  const summary = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), cancelled: count("cancelled") };
  console.log(`\ntest:release summary: ${JSON.stringify(summary)}`);
  if (code !== 0) { console.error("✖ test:release FAILED: the test run reported failures"); process.exit(code || 1); }
  if (!(summary.tests > 0) || summary.skipped !== 0 || summary.cancelled !== 0) {
    console.error(`✖ test:release FAILED: ${summary.skipped} skipped / ${summary.cancelled} cancelled (a skip is not a pass)`);
    process.exit(1);
  }
  console.log("✔ test:release passed: every test ran and passed against disposable MongoDB and Redis");
});
