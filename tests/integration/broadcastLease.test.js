/**
 * Broadcast lease failure modes. Starting a broadcast needs the one-active-broadcast lease in Redis, and BOTH failures
 * fail closed (nothing is sent) but must be reported truthfully:
 *   - Redis unreachable  -> 503 broadcast_lock_unavailable   (previously mislabelled "another broadcast is still running")
 *   - lock held elsewhere -> 409 broadcast_already_running   (unchanged)
 *
 * Part 1 never connects Redis, so it needs only MongoDB. Part 2 needs a DISPOSABLE loopback Redis
 * (REDIS_URL=redis://127.0.0.1:<port>, see docs/admin.md) and is reported as skipped without it.
 * A real Telegram bot never exists in tests, so nothing can be delivered to anyone.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { waitFor } from "../helpers/util.js";
import { redisTestsConfigured } from "../helpers/redisRequirement.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
const ADMIN = "424242";
const KEY = "admin:broadcast:active";
const dbAvailable = await connectTestDB();
const redisConfigured = redisTestsConfigured(); // throws under REQUIRE_REDIS_TESTS=1 when REDIS_URL is missing

let broadcast, AdminBroadcast, User, botInstance;
if (dbAvailable) {
  broadcast = await import("../../services/admin/broadcast.js");
  ({ default: AdminBroadcast } = await import("../../models/AdminBroadcast.js"));
  ({ default: User } = await import("../../models/User.js"));
  ({ default: botInstance } = await import("../../config/botInstance.js"));
}

let seq = 0;
const op = () => `lease-test-op-${String(++seq).padStart(6, "0")}-abcd`;
const tid = () => String(300000 + Math.floor(Math.random() * 600000));
const start = async (operationId = op()) => {
  const id = tid();
  await User.create({ telegramId: id });
  return { operationId, run: () => broadcast.createBroadcast({ actorId: ADMIN, operationId, message: "Lease test announcement", audience: "custom", customTelegramIds: [id] }) };
};

after(async () => { await disconnectTestDB(); });

describe("Redis unreachable (this file never connects the shared client)", () => {
  test("starting a broadcast fails closed with a truthful 503, sends nothing and leaves no running broadcast", { skip: dbAvailable ? false : "MongoDB unavailable" }, async () => {
    assert.equal(botInstance.bot, null, "no real bot can exist in this test");
    const { operationId, run } = await start();
    await assert.rejects(run, (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "broadcast_lock_unavailable");
      assert.notEqual(error.code, "broadcast_already_running", "must not blame another broadcast when the lock service is down");
      return true;
    });
    const stored = await AdminBroadcast.findOne({ operationId }).lean();
    assert.ok(!stored || !["running", "completed"].includes(stored.status), `no broadcast ran: ${stored?.status}`);
    assert.ok(!stored || !(stored.succeeded > 0 || stored.processed > 0), "nothing was processed or delivered");
  });
});

describe("lease held by another broadcast (real disposable Redis)", () => {
  let redis;
  const gate = { skip: !dbAvailable ? "MongoDB unavailable" : (redisConfigured ? false : "Redis not configured: set REDIS_URL to a disposable loopback Redis (docs/admin.md)") };

  before(async () => {
    if (!dbAvailable || !redisConfigured) return;
    redis = await import("../../config/redisClient.js");
    await redis.connectRedis();
    await redis.default.del(KEY);
  });
  after(async () => {
    if (!redis) return;
    try { await redis.default.del(KEY); } finally { await redis.closeRedis(); }
  });

  test("a held lease gives a 409, is left untouched, and nothing is sent", gate, async () => {
    assert.equal(botInstance.bot, null);
    assert.equal(await redis.default.set(KEY, "foreign-owner-token", { NX: true, EX: 60 }), "OK");
    const { operationId, run } = await start();
    await assert.rejects(run, (error) => error.status === 409 && error.code === "broadcast_already_running");
    assert.equal(await redis.default.get(KEY), "foreign-owner-token", "another owner's lease is never stolen or deleted");
    const stored = await AdminBroadcast.findOne({ operationId }).lean();
    assert.ok(!stored || !["running", "completed"].includes(stored.status));
  });

  test("once the lease is free a broadcast starts, completes (no bot => recorded as not delivered) and releases the lease", gate, async () => {
    await redis.default.del(KEY);
    const { operationId, run } = await start();
    const result = await run();
    assert.equal(result.started, true);
    const status = await waitFor(() => broadcast.getBroadcastStatus({ actorId: ADMIN, operationId }).then((value) => (["completed", "failed", "cancelled"].includes(value.status) ? value : null)), { timeoutMs: 10_000 });
    assert.ok(status, "broadcast must finish");
    assert.equal(status.succeeded, 0, "nothing was delivered without a bot");
    assert.equal(await waitFor(() => redis.default.get(KEY).then((value) => (value === null ? true : null)), { timeoutMs: 5000 }), true, "lease released");
  });

  test("two broadcasts started at the same moment: exactly one takes the lease", gate, async () => {
    await redis.default.del(KEY);
    const first = await start();
    const second = await start();
    const outcomes = await Promise.allSettled([first.run(), second.run()]);
    const started = outcomes.filter((entry) => entry.status === "fulfilled" && entry.value.started === true);
    const refused = outcomes.filter((entry) => entry.status === "rejected" && entry.reason.code === "broadcast_already_running");
    assert.equal(started.length + refused.length, 2, JSON.stringify(outcomes.map((entry) => entry.status === "fulfilled" ? "started" : entry.reason?.code)));
    assert.ok(started.length >= 1, "at least one broadcast runs");
    // let whatever started finish so the lease is released before cleanup
    await waitFor(() => redis.default.get(KEY).then((value) => (value === null ? true : null)), { timeoutMs: 10_000 });
  });

  // ── The lease primitives themselves (owner-token Lua scripts, TTL, takeover) with short intervals: the broadcast's own
  // 60s heartbeat is too slow to exercise a mid-run takeover, so this pins the behavior it relies on. Same connection. ──
  const PRIM_KEY = "admin:test:lease-primitives";
  let lease;
  before(async () => { if (redisConfigured) { lease = await import("../../services/redisLease.js"); await redis.default.del(PRIM_KEY); } });

  test("a second holder cannot acquire a held lease; the owner's release frees it", gate, async () => {
    const first = await lease.acquireRedisLease(PRIM_KEY, 30);
    assert.ok(first, "first acquire succeeds");
    assert.equal(await lease.acquireRedisLease(PRIM_KEY, 30), null, "a held lease is refused (null, not an error)");
    assert.equal(await lease.releaseRedisLease(first), true);
    assert.equal(await redis.default.exists(PRIM_KEY), 0);
    const second = await lease.acquireRedisLease(PRIM_KEY, 30);
    assert.ok(second, "free again after release");
    await lease.releaseRedisLease(second);
  });

  test("renewal extends the TTL for the owner only", gate, async () => {
    const mine = await lease.acquireRedisLease(PRIM_KEY, 5);
    assert.ok(await redis.default.pTTL(PRIM_KEY) <= 5000);
    assert.equal(await lease.renewRedisLease(mine, 60), true);
    assert.ok(await redis.default.pTTL(PRIM_KEY) > 5000, "TTL was extended");
    await redis.default.set(PRIM_KEY, "someone-else", { EX: 30 }); // takeover
    assert.equal(await lease.renewRedisLease(mine, 60), false, "a non-owner's renewal is refused");
    assert.equal(await redis.default.get(PRIM_KEY), "someone-else");
    await redis.default.del(PRIM_KEY);
  });

  test("a stale holder's release never deletes the new owner's lease", gate, async () => {
    const stale = await lease.acquireRedisLease(PRIM_KEY, 30);
    await redis.default.set(PRIM_KEY, "new-owner-token", { EX: 30 });
    assert.equal(await lease.releaseRedisLease(stale), false);
    assert.equal(await redis.default.get(PRIM_KEY), "new-owner-token", "the new owner's lease is untouched");
    await redis.default.del(PRIM_KEY);
  });

  test("the heartbeat reports a lost lease (takeover mid-run) so the broadcast loop can stop sending", gate, async () => {
    const mine = await lease.acquireRedisLease(PRIM_KEY, 30);
    let lost = null;
    const stop = lease.startRedisLeaseHeartbeat(mine, { ttlSeconds: 30, intervalMs: 100, onLost: async (error) => { lost = error; } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(lost, null, "a healthy lease is renewed, not reported lost");
      await redis.default.set(PRIM_KEY, "thief-token", { EX: 30 });
      const reported = await waitFor(() => lost, { timeoutMs: 3000, intervalMs: 50 });
      assert.match(String(reported.message), /lost/i);
    } finally {
      stop();
      await redis.default.del(PRIM_KEY);
    }
  });

  test("a crashed holder cannot block broadcasts forever: the lease expires by TTL", gate, async () => {
    const crashed = await lease.acquireRedisLease(PRIM_KEY, 1); // holder never renews or releases
    assert.ok(crashed);
    assert.equal(await lease.acquireRedisLease(PRIM_KEY, 1), null);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const next = await lease.acquireRedisLease(PRIM_KEY, 30);
    assert.ok(next, "acquirable after the TTL elapsed");
    await lease.releaseRedisLease(next);
  });
});
