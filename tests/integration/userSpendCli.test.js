/**
 * scripts/user-spend-backfill.mjs against a REAL, disposable MongoDB (a separate database next to the test
 * database; the helper refuses default ports and non-test database names).
 *
 *  - Connecting and running ANY mode must not build model indexes or create collections as a side effect
 *    (autoIndex/autoCreate off, as the bot does in production). A control proves the check can see an index build.
 *  - The documented writes hold: --dry-run takes and releases the lease (and nothing else), --verify writes the
 *    verification marker (and no counters), --backfill writes counters and its progress.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectTestDB, disconnectTestDB, TEST_MONGO_URL } from "../helpers/db.js";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const root = fileURLToPath(new URL("../..", import.meta.url));

const parts = TEST_MONGO_URL.match(/^(mongodb:\/\/[^/?]+)\/([^?]*)(\?.*)?$/);
const withDb = (suffix) => `${parts[1]}/${parts[2]}${suffix}${parts[3] || ""}`;
const CLI_DB = withDb("_cli");
const CONTROL_DB = withDb("_cli_control");

if (dbAvailable) {
  // A second, independent guard: this suite spawns a process that WRITES, so it only ever targets a disposable database.
  const url = new URL(CLI_DB);
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname), "loopback only");
  assert.ok(url.port && !["27017", "6379"].includes(url.port), "an explicit non-default port is required");
  assert.match(url.pathname, /test/i, "the database name must contain 'test'");
}

let User, JobCheckpoint, lease, conn, db;
const names = async (collection) => (await db.collection(collection).indexes().catch(() => [])).map((index) => index.name);
const collectionNames = async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
const run = (mode, extra = []) => spawnSync(process.execPath, ["scripts/user-spend-backfill.mjs", mode, "--sleep-ms", "0", "--settle-ms", "0", ...extra], {
  cwd: root, env: { ...process.env, MONGO_URL: CLI_DB }, encoding: "utf8", timeout: 60_000,
});
const json = (result) => JSON.parse(result.stdout);
const noIndexesBeyondId = async (label) => {
  for (const collection of ["users", "walletpurchases", "jobcheckpoints"]) assert.deepEqual(await names(collection), ["_id_"], `${label}: ${collection} has only its _id index`);
};

describe("user spend CLI", () => {
  before(async () => {
    if (!dbAvailable) return;
    ({ default: User } = await import("../../models/User.js"));
    ({ default: JobCheckpoint } = await import("../../models/JobCheckpoint.js"));
    lease = await import("../../services/jobLease.js");
    conn = await mongoose.createConnection(CLI_DB, { autoIndex: false, autoCreate: false }).asPromise();
    db = conn.db;
    await db.dropDatabase();
    await db.collection("users").insertMany(["c1", "c2", "c3", "c4", "c5"].map((id) => ({ telegramId: id, createdAt: new Date(), balance: 0 })));
    await db.collection("walletpurchases").insertMany([
      { purchaseId: "cli-1", telegramId: "c1", amount: 25_000, status: "completed", completedAt: new Date(), createdAt: new Date() },
      { purchaseId: "cli-2", telegramId: "c1", amount: 15_000, status: "completed", completedAt: new Date(), createdAt: new Date() },
      { purchaseId: "cli-3", telegramId: "c2", amount: 99_000, status: "failed", createdAt: new Date() },
    ]);
  });
  after(async () => {
    if (dbAvailable) {
      await db.dropDatabase();
      await conn.close();
      await disconnectTestDB();
    }
  });

  skip("control: connecting with default options builds model indexes, so the checks below can detect it", async () => {
    const control = await mongoose.createConnection(CONTROL_DB).asPromise();
    try {
      await control.model("UserControl", User.schema, "users").init();
      const created = (await control.db.collection("users").indexes()).map((index) => index.name);
      assert.ok(created.includes("telegramId_1"), `an index was built (${created.join(", ")})`);
    } finally {
      await control.db.dropDatabase();
      await control.close();
    }
  });

  skip("--dry-run creates no index and no collection; its only writes are taking and releasing the lease", async () => {
    const before = await collectionNames();
    const result = run("--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual({ completed: json(result).completed, wouldRaise: json(result).wouldRaise, raised: json(result).raised }, { completed: true, wouldRaise: 5, raised: 0 });

    await noIndexesBeyondId("after --dry-run");
    assert.deepEqual(before, ["users", "walletpurchases"]);
    assert.deepEqual(await collectionNames(), ["jobcheckpoints", "users", "walletpurchases"], "only the lease document's collection appeared");
    assert.equal(await db.collection("users").countDocuments({ totalSpent: { $exists: true } }), 0, "no counter was written");
    const docs = await db.collection("jobcheckpoints").find({}).toArray();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, "user-spend-backfill");
    assert.equal(docs[0].leaseOwner, null, "the lease was released");
    assert.equal(docs[0].leaseUntil, null);
    assert.deepEqual(docs[0].state, {}, "no progress (cursor, startedAt, completedAt) was recorded");
  });

  skip("--verify on un-backfilled data exits 1, writes only the verification marker, and creates no index", async () => {
    const result = run("--verify");
    assert.equal(result.status, 1, result.stderr);
    const report = json(result);
    assert.deepEqual([report.ok, report.users, report.missing], [false, 5, 5]);
    await noIndexesBeyondId("after --verify");
    assert.equal(await db.collection("users").countDocuments({ totalSpent: { $exists: true } }), 0, "verify wrote no counters");
    const marker = await db.collection("jobcheckpoints").findOne({ name: "user-spend-verify" });
    assert.equal(marker.state.ok, false);
    assert.equal(marker.state.missing, 5);
  });

  skip("--dry-run is refused while another backfill holds the lease, and leaves that lease untouched", async () => {
    const cliCheckpoints = conn.model("JobCheckpointCli", JobCheckpoint.schema, "jobcheckpoints");
    const held = await lease.acquireLease(cliCheckpoints, "user-spend-backfill", "another-operator", 60_000);
    assert.ok(held);
    try {
      const refused = run("--dry-run");
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /BACKFILL_ALREADY_RUNNING/);
      assert.equal((await db.collection("jobcheckpoints").findOne({ name: "user-spend-backfill" })).leaseOwner, "another-operator");
    } finally {
      await lease.releaseLease(cliCheckpoints, held);
    }
    assert.equal(run("--dry-run").status, 0, "and it works again once the lease is free");
  });

  skip("--backfill writes the counters and its progress, still creates no index, and a clean --verify then exits 0", async () => {
    const backfill = run("--backfill", ["--chunk", "2"]);
    assert.equal(backfill.status, 0, backfill.stderr);
    assert.deepEqual({ completed: json(backfill).completed, chunks: json(backfill).chunks, users: json(backfill).users }, { completed: true, chunks: 3, users: 5 });
    const users = Object.fromEntries((await db.collection("users").find({}).toArray()).map((u) => [u.telegramId, [u.totalSpent, u.completedOrderCount]]));
    assert.deepEqual(users, { c1: [40_000, 2], c2: [0, 0], c3: [0, 0], c4: [0, 0], c5: [0, 0] });
    const progress = await db.collection("jobcheckpoints").findOne({ name: "user-spend-backfill" });
    assert.ok(progress.state.completedAt, "completion was recorded");
    assert.equal(progress.state.cursor, undefined);
    assert.equal(progress.leaseOwner, null);
    await noIndexesBeyondId("after --backfill");

    const verify = run("--verify");
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(json(verify).ok, true);
    assert.equal((await db.collection("jobcheckpoints").findOne({ name: "user-spend-verify" })).state.ok, true);
    await noIndexesBeyondId("after the clean --verify");
  });

  skip("--verify rejects a --grace-ms that is invalid or wider than 5 minutes, before touching the database", async () => {
    const markerBefore = await db.collection("jobcheckpoints").findOne({ name: "user-spend-verify" });
    for (const bad of ["300001", "999999999", "-1", "abc"]) {
      const refused = run("--verify", ["--grace-ms", bad]);
      assert.equal(refused.status, 2, `--grace-ms ${bad}`);
      assert.equal(refused.stdout, "");
    }
    assert.equal(run("--verify", ["--grace-ms", "300000"]).status, 0, "the maximum itself is accepted");
    const markerAfter = await db.collection("jobcheckpoints").findOne({ name: "user-spend-verify" });
    assert.equal(markerAfter.state.graceMs, 300_000);
    assert.equal(markerBefore.state.graceMs, 30_000, "the default window is recorded in the marker");
  });
});
