import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242,424243";

const { resetTestServiceEligibility, testServiceSummary } = await import("../../services/admin/users.js");
const { createThrottle } = await import("../../services/admin/throttle.js");

function makeUserModel(initial) {
  const users = new Map(initial.map((u) => [u.telegramId, { ...u }]));
  const calls = { updates: 0 };
  const matches = (user, filter) => {
    if (user.telegramId !== filter.telegramId) return false;
    if (filter.testServiceStatus?.$nin && filter.testServiceStatus.$nin.includes(user.testServiceStatus ?? null)) return false;
    if (filter.testServiceNotificationPending?.$ne !== undefined && Boolean(user.testServiceNotificationPending) === filter.testServiceNotificationPending.$ne) return false;
    return true;
  };
  const chain = (value) => ({ select() { return this; }, async lean() { return value ? { ...value } : null; } });
  return {
    users,
    calls,
    findOne(filter) { return chain(users.get(filter.telegramId)); },
    findOneAndUpdate(filter, update) {
      const user = users.get(filter.telegramId);
      if (!user || !matches(user, filter)) return chain(null);
      calls.updates += 1;
      Object.assign(user, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete user[key];
      return chain(user);
    },
  };
}

function makeAuditModel() {
  const docs = new Map();
  return {
    docs,
    async create(fields) {
      if (docs.has(fields.operationId)) throw Object.assign(new Error("dup"), { code: 11000 });
      const doc = { ...fields, status: "started", async save() { /* in-memory */ } };
      docs.set(fields.operationId, doc);
      return doc;
    },
    async findOne({ operationId }) { return docs.get(operationId) || null; },
    async updateOne() { return {}; },
  };
}

const OP = (n) => `test-operation-${String(n).padStart(8, "0")}`;
const REASON = "support approved a second trial";

describe("admin test-service eligibility reset", () => {
  let users;
  let audit;
  beforeEach(() => {
    users = makeUserModel([
      { telegramId: "1001", hasReceivedTest: true, testServiceStatus: "completed", testServiceAttemptId: "att-1", testServiceNotificationPending: false, testServiceUsername: "u1" },
      { telegramId: "1002", hasReceivedTest: false, testServiceStatus: null },
      { telegramId: "1003", hasReceivedTest: true, testServiceStatus: "provisioning" },
      { telegramId: "1004", hasReceivedTest: true, testServiceStatus: "manual_review" },
      { telegramId: "1005", hasReceivedTest: true, testServiceStatus: "completed", testServiceNotificationPending: true },
      { telegramId: "1006", hasReceivedTest: true, testServiceStatus: "failed" },
    ]);
    audit = makeAuditModel();
  });
  const run = (overrides = {}) => resetTestServiceEligibility({
    actorId: 424242, operationId: OP(1), telegramId: "1001", reason: REASON, userModel: users, auditModel: audit, ...overrides,
  });

  test("restores eligibility on the existing fields without issuing a service", async () => {
    const result = await run();
    assert.equal(result.eligible, true);
    assert.equal(result.alreadyEligible, false);
    const user = users.users.get("1001");
    assert.equal(user.hasReceivedTest, false);
    assert.equal(user.testServiceStatus, null);
    assert.equal(user.testServiceAttemptId, null);
    assert.equal(user.testServiceUsername, "u1", "history of the earlier test is kept");
    assert.equal(testServiceSummary(user).eligible, true);
  });

  test("a failed earlier attempt can be restored too", async () => {
    const result = await run({ telegramId: "1006" });
    assert.equal(result.eligible, true);
    assert.equal(users.users.get("1006").hasReceivedTest, false);
  });

  test("the action is audited with admin, target and reason, and no secret fields", async () => {
    await run();
    const record = audit.docs.get(OP(1));
    assert.equal(record.action, "USER_TEST_ELIGIBILITY_RESET");
    assert.equal(record.actorTelegramId, "424242");
    assert.equal(record.targetUserId, "1001");
    assert.equal(record.metadata.reason, REASON);
    assert.equal(record.status, "succeeded");
    assert.deepEqual(record.result, { previousStatus: "completed", hadReceivedTest: true });
  });

  test("non-admins are refused before any data is touched", async () => {
    await assert.rejects(() => run({ actorId: 999 }), (e) => e.code === "forbidden");
    await assert.rejects(() => run({ actorId: "424242; drop" }), (e) => e.code === "forbidden");
    assert.equal(users.calls.updates, 0);
    assert.equal(audit.docs.size, 0);
  });

  test("invalid and unknown users are rejected", async () => {
    for (const telegramId of ["", "abc", "0", "-5", "12.5", "1e3", "9".repeat(30)]) {
      await assert.rejects(() => run({ telegramId, operationId: OP(Math.random() * 1e6 | 0) }), (e) => e.code === "invalid_user_id", telegramId);
    }
    await assert.rejects(() => run({ telegramId: "7777", operationId: OP(2) }), (e) => e.code === "user_not_found");
    assert.equal(users.calls.updates, 0);
  });

  test("a reason is mandatory", async () => {
    await assert.rejects(() => run({ reason: "" }), (e) => e.code === "invalid_reason");
    await assert.rejects(() => run({ reason: "x" }), (e) => e.code === "invalid_reason");
  });

  test("never resets while a test service is provisioning, in manual review, or undelivered", async () => {
    for (const [telegramId, code] of [["1003", "test_service_in_progress"], ["1004", "test_service_in_progress"], ["1005", "test_service_delivery_pending"]]) {
      await assert.rejects(() => run({ telegramId, operationId: OP(telegramId) }), (e) => e.code === code, telegramId);
    }
    assert.equal(users.users.get("1003").testServiceStatus, "provisioning");
    assert.equal(users.calls.updates, 0);
  });

  test("an already eligible user is a safe no-op", async () => {
    const result = await run({ telegramId: "1002" });
    assert.equal(result.alreadyEligible, true);
    assert.equal(users.calls.updates, 0);
  });

  test("a repeated click with the same operation key does not execute twice", async () => {
    await run();
    const replay = await run();
    assert.equal(replay.replayed, true);
    assert.equal(users.calls.updates, 1);
    // A different key for the same user after the reset finds nothing left to do.
    const second = await run({ operationId: OP(3) });
    assert.equal(second.alreadyEligible, true);
    assert.equal(users.calls.updates, 1);
  });

  test("an operation key cannot be reused by another admin", async () => {
    await run();
    await assert.rejects(() => run({ actorId: 424243 }), (e) => e.code === "idempotency_conflict");
  });

  test("a concurrent state change between the check and the write is refused", async () => {
    const original = users.findOneAndUpdate.bind(users);
    users.findOneAndUpdate = (filter, update) => {
      users.users.get("1001").testServiceStatus = "provisioning"; // another request claimed it
      return original(filter, update);
    };
    await assert.rejects(() => run(), (e) => e.code === "test_service_state_changed");
    assert.equal(users.users.get("1001").hasReceivedTest, true);
  });
});

describe("admin throttle", () => {
  test("blocks the call over the limit and recovers after the window", () => {
    let now = 0;
    const throttle = createThrottle({ limit: 3, windowMs: 1000, now: () => now });
    assert.deepEqual([1, 2, 3, 4].map(() => throttle.check("a")), [true, true, true, false]);
    assert.equal(throttle.check("b"), true, "keys are independent");
    now = 1001;
    assert.equal(throttle.check("a"), true);
    assert.equal(throttle.check(""), false);
    assert.throws(() => createThrottle({ limit: 0, windowMs: 1 }), TypeError);
  });
});
