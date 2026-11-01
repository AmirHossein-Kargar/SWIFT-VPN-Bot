/**
 * The admin directory against a REAL disposable MongoDB and the real models: what is joined, what stays null, that nothing
 * is written, and that the list is served by indexes instead of walking an admin's whole history.
 * Skipped (not passed) when no MongoDB is reachable.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242,424243";
process.env.OWNER_TELEGRAM_ID = "424242";
process.env.GROUP_ID = "";

const { default: AdminAccount } = await import("../../models/AdminAccount.js");
const { default: AdminAuditLog } = await import("../../models/AdminAuditLog.js");
const { default: User } = await import("../../models/User.js");
const { getAdminDirectory, getAdminDirectoryProfile } = await import("../../services/admin/adminDirectory.js");
const { addAdmin, removeAdmin, refreshAdminCache } = await import("../../services/admin/adminRegistry.js");

const connected = await connectTestDB();
const dbTest = connected ? test : test.skip;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms) => new Date(NOW - ms);
const OWNER = "424242";
const ENV_ADMIN = "424243";
const DB_ADMIN = "900101";
const REMOVED = "900102";
const NEVER_MET = "900103";

const presenceOf = (seen = {}) => async (ids) => ({ available: true, lastSeen: new Map(ids.filter((id) => seen[id]).map((id) => [id, seen[id]])) });
const list = (extra = {}) => getAdminDirectory({ actorId: OWNER, presenceReader: presenceOf(extra.seen), now: NOW, ...extra });
const detail = (telegramId, extra = {}) => getAdminDirectoryProfile({ actorId: OWNER, telegramId, presenceReader: presenceOf(extra.seen), now: NOW, ...extra });
const find = (data, id) => data.items.find((item) => item.telegramId === id);

function audit(actorTelegramId, action, createdAt, fields = {}) {
  return { operationId: randomUUID(), actorTelegramId, action, status: "succeeded", createdAt, ...fields };
}

async function seed() {
  await Promise.all([User.deleteMany({}), AdminAccount.deleteMany({}), AdminAuditLog.deleteMany({})]);
  await User.create([
    { telegramId: OWNER, firstName: "Olive", lastName: "Fake", username: "olive_fake", createdAt: ago(400 * DAY), balance: 999, services: [{ username: "svc" }] },
    { telegramId: DB_ADMIN, firstName: "Dana", username: "dana_fake", createdAt: ago(40 * DAY), isBanned: true, blockedBy: "system", blockedAt: ago(DAY) },
    { telegramId: ENV_ADMIN, firstName: "Eli", createdAt: ago(90 * DAY), isBanned: true, blockedBy: OWNER, blockedAt: ago(2 * DAY), blockReason: "test fixture" },
  ]);
  await AdminAccount.create([
    { telegramId: DB_ADMIN, role: "admin", displayName: "Support lead", addedBy: OWNER, addedAt: ago(30 * DAY) },
    { telegramId: NEVER_MET, role: "admin", displayName: "Newcomer", addedBy: OWNER, addedAt: ago(DAY) },
    { telegramId: REMOVED, role: "admin", displayName: "Former", addedBy: OWNER, addedAt: ago(60 * DAY), removedAt: ago(5 * DAY), removedBy: OWNER },
  ]);
  await AdminAuditLog.insertMany([
    audit(OWNER, "ADMIN_LOGIN", ago(3 * DAY), { ipAddress: "192.0.2.1", targetType: "session", targetId: "web", metadata: { channel: "web" } }),
    audit(OWNER, "ADMIN_LOGOUT", ago(2 * DAY), { ipAddress: "192.0.2.1", targetType: "session", targetId: "web" }),
    audit(OWNER, "ADMIN_LOGIN", ago(1000), { ipAddress: "192.0.2.2", targetType: "session", targetId: "web" }),
    audit(OWNER, "USER_BALANCE_CHANGED", ago(500), { targetType: "user", targetId: "1001", metadata: { reason: "private note", secretToken: "never-shown" } }),
    audit(OWNER, "USER_BALANCE_CHANGED", ago(10 * DAY), { targetType: "user", targetId: "1002", status: "failed", errorCode: "insufficient_balance" }),
    audit(OWNER, "BROADCAST_SENT", ago(40 * DAY), { targetType: "broadcast", targetId: "b1" }),
    audit(OWNER, "ADMIN_ADDED", ago(30 * DAY), { targetType: "admin", targetId: DB_ADMIN }),
    audit(OWNER, "ADMIN_ADDED", ago(60 * DAY), { targetType: "admin", targetId: REMOVED }),
    audit(OWNER, "ADMIN_REMOVED", ago(5 * DAY), { targetType: "admin", targetId: REMOVED }),
    audit(DB_ADMIN, "VPN_ACTION", ago(2000), { targetType: "vpn", targetId: "svc_fake" }),
    audit("555", "VPN_ACTION", ago(100), { targetType: "vpn", targetId: "not-an-admin" }),
  ]);
}

before(async () => {
  if (!connected) return;
  await Promise.all([AdminAccount.init(), AdminAuditLog.init(), User.init()]);
});
beforeEach(async () => { if (connected) await seed(); });
after(async () => { if (connected) await disconnectTestDB(); });

describe("the list", () => {
  dbTest("lists ADMINS, database admins and removed admins once each, current admins first", async () => {
    const data = await list();
    assert.deepEqual(data.items.map((item) => item.telegramId).sort(), [DB_ADMIN, ENV_ADMIN, NEVER_MET, OWNER, REMOVED].sort());
    assert.equal(data.items[0].telegramId, OWNER);
    assert.equal(data.items.at(-1).telegramId, REMOVED);
    assert.deepEqual(data.summary, { total: 5, active: 4, blocked: 2, removed: 1, online: 0 });
    assert.equal(data.truncated, false);
  });

  dbTest("joins each record to the right admin", async () => {
    const owner = find(await list(), OWNER);
    assert.equal(owner.name, "Olive Fake");
    assert.equal(owner.username, "olive_fake");
    assert.equal(owner.role, "owner");
    assert.equal(owner.source, "environment");
    assert.equal(owner.lastLoginAt.getTime(), ago(1000).getTime());
    assert.equal(owner.lastLogoutAt.getTime(), ago(2 * DAY).getTime());
    assert.equal(owner.lastActionAt.getTime(), ago(500).getTime());
    assert.equal(owner.eventsLast30Days, 7, "the 40- and 60-day-old rows fall outside the window");
  });

  dbTest("an admin the bot has never met has no invented values", async () => {
    const admin = find(await list(), NEVER_MET);
    assert.equal(admin.hasBotProfile, false);
    assert.equal(admin.name, null);
    assert.equal(admin.username, null);
    assert.equal(admin.joinedAt, null);
    assert.equal(admin.lastLoginAt, null);
    assert.equal(admin.lastActivityAt, null);
    assert.equal(admin.displayName, "Newcomer");
    assert.deepEqual(admin.presence, { state: "unknown", reason: "no_record" });
  });

  dbTest("presence joins the audit record: a later sign-out ends it", async () => {
    const data = await list({ seen: { [OWNER]: ago(30_000), [DB_ADMIN]: ago(30 * 60_000) } });
    assert.equal(find(data, OWNER).presence.state, "online");
    assert.equal(find(data, DB_ADMIN).presence.state, "offline");
    assert.equal(data.summary.online, 1);

    await AdminAuditLog.create(audit(OWNER, "ADMIN_LOGOUT", ago(5_000)));
    const after = await list({ seen: { [OWNER]: ago(30_000) } });
    assert.equal(find(after, OWNER).presence.state, "offline");
  });

  dbTest("an unreadable presence store degrades one field, not the page", async () => {
    const data = await list({ presenceReader: async () => ({ available: false, lastSeen: new Map() }) });
    assert.equal(data.presence.available, false);
    assert.equal(data.summary.online, null);
    assert.ok(data.items.every((item) => item.presence.state === "unknown" && item.presence.reason === "unavailable"));
    assert.equal(find(data, OWNER).lastLoginAt.getTime(), ago(1000).getTime());
  });

  dbTest("search and filters narrow the items and leave the totals alone", async () => {
    const ids = async (filters) => (await list(filters)).items.map((item) => item.telegramId);
    assert.deepEqual(await ids({ search: "OLIVE" }), [OWNER]);
    assert.deepEqual(await ids({ search: "@dana" }), [DB_ADMIN]);
    assert.deepEqual(await ids({ search: "support lead" }), [DB_ADMIN]);
    assert.deepEqual(await ids({ search: NEVER_MET }), [NEVER_MET]);
    assert.deepEqual(await ids({ role: "owner" }), [OWNER]);
    assert.deepEqual(await ids({ status: "removed" }), [REMOVED]);
    assert.deepEqual((await ids({ status: "blocked" })).sort(), [DB_ADMIN, ENV_ADMIN].sort());
    assert.deepEqual(await ids({ search: "no such admin" }), []);
    assert.equal((await list({ search: "no such admin" })).summary.total, 5);
  });

  dbTest("an ID in both ADMINS and AdminAccount appears once, as the environment entry", async () => {
    await AdminAccount.create({ telegramId: ENV_ADMIN, role: "admin", displayName: "Also a row", addedBy: OWNER, addedAt: ago(DAY), removedAt: ago(1000), removedBy: OWNER });
    const rows = (await list()).items.filter((item) => item.telegramId === ENV_ADMIN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "environment");
    assert.equal(rows[0].removedAt, null);
    assert.notEqual(rows[0].status, "removed");
  });

  dbTest("agrees with the real registry after an add and a remove", async () => {
    await addAdmin({ actorId: OWNER, operationId: randomUUID(), telegramId: "900200", displayName: "Fresh" });
    assert.equal(find(await list(), "900200").status, "active");
    await removeAdmin({ actorId: OWNER, operationId: randomUUID(), telegramId: "900200" });
    const removed = find(await list(), "900200");
    assert.equal(removed.status, "removed");
    assert.equal(removed.removedBy, OWNER);
    await refreshAdminCache();
  });

  dbTest("a non-admin is refused", async () => {
    await assert.rejects(() => getAdminDirectory({ actorId: "5" }), { code: "forbidden" });
    await assert.rejects(() => getAdminDirectoryProfile({ actorId: "5", telegramId: OWNER }), { code: "forbidden" });
  });
});

describe("the profile", () => {
  dbTest("counts activity by window and never mixes in another admin", async () => {
    const { stats } = await detail(OWNER);
    assert.equal(stats.totalEvents, 9);
    assert.equal(stats.eventsLast7Days, 5);
    assert.equal(stats.failedLast30Days, 1);
    assert.equal(stats.signInsLast30Days, 2);
    assert.equal(stats.topActions[0].action, "ADMIN_LOGIN");
    const balance = stats.topActions.find((row) => row.action === "USER_BALANCE_CHANGED");
    assert.deepEqual(balance, { action: "USER_BALANCE_CHANGED", count: 2, failed: 1 });
  });

  dbTest("separates actions from sign-ins, newest first, with the same redaction as the audit log", async () => {
    const data = await detail(OWNER);
    assert.equal(data.recentActions[0].action, "USER_BALANCE_CHANGED");
    assert.ok(data.recentActions.every((row) => !row.action.startsWith("ADMIN_LOG")));
    assert.deepEqual(data.sessionHistory.map((row) => row.action), ["ADMIN_LOGIN", "ADMIN_LOGOUT", "ADMIN_LOGIN"]);
    assert.equal(data.sessionHistory[0].ipAddress, "192.0.2.2");
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /never-shown|private note|999|svc"/);
    assert.ok(data.recentActions.every((row) => !("metadata" in row) && !("_id" in row)));
  });

  dbTest("shows changes made to this admin, by whom", async () => {
    const { accountHistory, profile } = await detail(REMOVED);
    assert.deepEqual(accountHistory.map((row) => row.action), ["ADMIN_REMOVED", "ADMIN_ADDED"]);
    assert.ok(accountHistory.every((row) => row.actorTelegramId === OWNER));
    assert.equal(profile.status, "removed");
    assert.equal(profile.removedBy, OWNER);
  });

  dbTest("an admin with no history gets empty lists, not an error", async () => {
    const data = await detail(NEVER_MET);
    assert.equal(data.stats.totalEvents, 0);
    assert.deepEqual(data.recentActions, []);
    assert.deepEqual(data.sessionHistory, []);
    assert.deepEqual(data.accountHistory, []);
    assert.deepEqual(data.stats.topActions, []);
  });

  dbTest("explains each kind of block on the bot account", async () => {
    assert.equal((await detail(DB_ADMIN)).profile.block.kind, "bot_blocked_by_account");
    const { block } = (await detail(ENV_ADMIN)).profile;
    assert.equal(block.kind, "by_admin");
    assert.equal(block.by, OWNER);
    assert.equal(block.reason, "test fixture");
  });

  dbTest("an ID that is not an admin is not found, so it cannot read a customer's or a stranger's audit trail", async () => {
    await assert.rejects(() => detail("555"), { code: "admin_not_found", status: 404 });
  });
});

describe("cost and safety", () => {
  // Only the plan that runs counts. rejectedPlans routinely hold a SORT or a scan that is never executed.
  const winning = (plan) => {
    const planner = plan.queryPlanner ?? plan.stages?.[0]?.$cursor?.queryPlanner ?? plan;
    return JSON.stringify(planner.winningPlan ?? planner);
  };
  const stage = (plan, name) => winning(plan).includes(`"${name}"`);
  const keysExamined = (plan) => Number(JSON.stringify(plan).match(/"totalKeysExamined":(\d+)/)?.[1] ?? Number.NaN);
  const history = (actor, count, action = "VPN_ACTION") => AdminAuditLog.insertMany(Array.from({ length: count }, (_, index) => audit(actor, action, ago(50 * DAY + index * 1000))));

  dbTest("reads write nothing", async () => {
    const snapshot = async () => JSON.stringify([
      await User.find({}).sort({ telegramId: 1 }).lean(),
      await AdminAccount.find({}).sort({ telegramId: 1 }).lean(),
      await AdminAuditLog.find({}).sort({ operationId: 1 }).lean(),
    ]);
    const before = await snapshot();
    await list();
    await detail(OWNER);
    assert.equal(await snapshot(), before);
  });

  dbTest("the latest sign-in per admin jumps to the newest row, however many sign-ins there are", async () => {
    await history(OWNER, 3_000, "ADMIN_LOGIN");
    const plan = await AdminAuditLog.aggregate([
      { $match: { actorTelegramId: { $in: [OWNER, DB_ADMIN] }, action: "ADMIN_LOGIN" } },
      { $sort: { actorTelegramId: 1, action: 1, createdAt: -1 } },
      { $group: { _id: "$actorTelegramId", at: { $first: "$createdAt" } } },
    ]).explain("executionStats");
    assert.ok(stage(plan, "DISTINCT_SCAN"), winning(plan));
    assert.match(winning(plan), /idx_admin_audit_actor_action_recent/);
    assert.ok(keysExamined(plan) < 20, `examined ${keysExamined(plan)} keys out of 3,000+`);
  });

  dbTest("the latest event per admin does the same on the actor index", async () => {
    await history(OWNER, 3_000);
    const plan = await AdminAuditLog.aggregate([
      { $match: { actorTelegramId: { $in: [OWNER, DB_ADMIN] } } },
      { $sort: { actorTelegramId: 1, createdAt: -1 } },
      { $group: { _id: "$actorTelegramId", at: { $first: "$createdAt" } } },
    ]).explain("executionStats");
    assert.ok(stage(plan, "DISTINCT_SCAN"), winning(plan));
    assert.ok(keysExamined(plan) < 20, `examined ${keysExamined(plan)} keys out of 3,000+`);
  });

  dbTest("recent actions and sign-ins read a page of the index, with no sort in memory", async () => {
    await history(OWNER, 3_000);
    const actor = { actorTelegramId: OWNER };
    const actions = await AdminAuditLog.find({ ...actor, action: { $nin: ["ADMIN_LOGIN", "ADMIN_LOGOUT"] } }).sort({ createdAt: -1 }).limit(15).explain("executionStats");
    const sessions = await AdminAuditLog.find({ ...actor, action: { $in: ["ADMIN_LOGIN", "ADMIN_LOGOUT"] } }).sort({ createdAt: -1 }).limit(15).explain("executionStats");
    for (const plan of [actions, sessions]) {
      assert.equal(stage(plan, "COLLSCAN"), false, winning(plan));
      assert.equal(stage(plan, "SORT"), false, winning(plan));
      assert.ok(keysExamined(plan) < 50, `examined ${keysExamined(plan)} keys out of 3,000+`);
    }
  });

  dbTest("the user lookup uses the unique index", async () => {
    const plan = await User.find({ telegramId: { $in: [OWNER, DB_ADMIN] } }).select("telegramId firstName -_id").lean().explain("queryPlanner");
    assert.equal(stage(plan, "COLLSCAN"), false, winning(plan));
  });
});
