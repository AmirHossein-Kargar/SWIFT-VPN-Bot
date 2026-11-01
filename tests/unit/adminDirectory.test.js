/**
 * What the admin directory may claim, without a database: when an admin reads as online, how records merge, what a filter
 * matches, and that the presence record can never affect a request. tests/integration/adminDirectory.mongo.test.js covers
 * the same service against real records and index plans.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";

const { buildProfile, derivePresence, deriveStatus, matchesDirectoryFilters, normalizeDirectoryFilters, sortProfiles, summarizeProfiles } = await import("../../services/admin/adminDirectory.js");
const { PRESENCE_WINDOW_SECONDS, notePanelRequest, readPanelPresence, resetAdminPresenceForTests, trackAdminPresence } = await import("../../services/admin/adminPresence.js");

const repo = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
const NOW = Date.parse("2026-11-01T12:00:00Z");
const ago = (seconds) => new Date(NOW - seconds * 1000);
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function loadPanelLib() {
  const { outputText } = ts.transpileModule(repo("admin-panel/lib/admin-directory.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

describe("presence takes positive evidence", () => {
  const window = PRESENCE_WINDOW_SECONDS;

  test("a request inside the window is online, one past it is offline", () => {
    assert.equal(derivePresence({ lastSeenAt: ago(window - 1), now: NOW }).state, "online");
    assert.equal(derivePresence({ lastSeenAt: ago(window + 1), now: NOW }).state, "offline");
  });

  test("no record is unknown, never offline", () => {
    assert.deepEqual(derivePresence({ now: NOW }), { state: "unknown", reason: "no_record" });
  });

  test("an unreadable store is unknown even with a timestamp in hand", () => {
    assert.deepEqual(derivePresence({ lastSeenAt: ago(1), available: false, now: NOW }), { state: "unknown", reason: "unavailable" });
  });

  test("signing out ends it straight away", () => {
    assert.equal(derivePresence({ lastSeenAt: ago(60), lastLogoutAt: ago(30), now: NOW }).state, "offline");
  });

  test("a later request after signing out elsewhere is online again", () => {
    assert.equal(derivePresence({ lastSeenAt: ago(10), lastLogoutAt: ago(60), now: NOW }).state, "online");
  });

  test("a removed admin is never online", () => {
    assert.equal(derivePresence({ lastSeenAt: ago(1), active: false, now: NOW }).state, "offline");
    assert.equal(derivePresence({ active: false, now: NOW }).state, "offline");
  });
});

describe("merging an admin's records", () => {
  const user = { telegramId: "1001", firstName: "Ada", lastName: "Fake", username: "ada_fake", createdAt: ago(9000) };
  const account = { telegramId: "1001", role: "admin", displayName: "Support", addedBy: "424242", addedAt: ago(4000), removedAt: null };

  test("every source lands in its own field", () => {
    const profile = buildProfile({ telegramId: "1001", source: "database", active: true, account, user, audit: { lastLoginAt: ago(50), lastActionAt: ago(40), eventsLast30Days: 3 }, presence: { lastSeenAt: ago(20) }, now: NOW });
    assert.equal(profile.name, "Ada Fake");
    assert.equal(profile.displayName, "Support");
    assert.equal(profile.username, "ada_fake");
    assert.equal(profile.status, "active");
    assert.equal(profile.hasBotProfile, true);
    assert.equal(profile.joinedAt.getTime(), ago(9000).getTime());
    assert.equal(profile.adminSince.getTime(), ago(4000).getTime());
    assert.equal(profile.lastActivityAt.getTime(), ago(20).getTime());
    assert.equal(profile.eventsLast30Days, 3);
  });

  test("an admin the bot has never met has nulls, not invented values", () => {
    const profile = buildProfile({ telegramId: "424242", source: "environment", active: true, ownerIds: ["424242"], now: NOW });
    assert.equal(profile.role, "owner");
    assert.equal(profile.hasBotProfile, false);
    for (const field of ["name", "displayName", "username", "joinedAt", "adminSince", "addedBy", "lastLoginAt", "lastActivityAt", "block"]) assert.equal(profile[field], null, field);
    assert.equal(profile.eventsLast30Days, 0);
  });

  test("the join date is never offered as activity", () => {
    const profile = buildProfile({ telegramId: "1001", source: "database", active: true, account, user: { ...user, lastActivityAt: ago(5) }, now: NOW });
    assert.equal(profile.lastActivityAt, null);
    assert.equal("lastActivity" in profile, false);
  });

  test("the customer wallet and services never enter a profile", () => {
    const profile = buildProfile({ telegramId: "1001", source: "database", active: true, account, user: { ...user, balance: 5, services: [{}], phoneNumber: "x" }, now: NOW });
    for (const field of ["balance", "services", "phoneNumber"]) assert.equal(field in profile, false, field);
  });

  test("the role comes from the environment first, as authorization does", () => {
    assert.equal(buildProfile({ telegramId: "1001", source: "database", active: true, account, ownerIds: ["1001"], now: NOW }).role, "owner");
    assert.equal(buildProfile({ telegramId: "1001", source: "database", active: true, account: { ...account, role: "owner" }, now: NOW }).role, "owner");
    assert.equal(buildProfile({ telegramId: "1002", source: "environment", active: true, account: { ...account, role: "owner" }, now: NOW }).role, "admin");
  });

  test("removal details are shown only while the admin is removed", () => {
    const removed = { ...account, removedAt: ago(10), removedBy: "424242" };
    assert.equal(buildProfile({ telegramId: "1001", source: "database", active: false, account: removed, now: NOW }).removedBy, "424242");
    // Listed in ADMINS again after a removal: the old row must not read as removed.
    assert.equal(buildProfile({ telegramId: "1001", source: "environment", active: true, account: removed, now: NOW }).removedAt, null);
  });
});

describe("account status", () => {
  test("removed outranks a block, and a block leaves the admin listed as current", () => {
    assert.equal(deriveStatus({ active: false, user: { isBanned: true } }), "removed");
    assert.equal(deriveStatus({ active: true, user: { isBanned: true } }), "blocked");
    assert.equal(deriveStatus({ active: true, user: null }), "active");
  });

  test("a block by an admin and an account that blocked the bot stay distinct", () => {
    const profile = (user) => buildProfile({ telegramId: "1001", source: "database", active: true, user, now: NOW });
    assert.equal(profile({ isBanned: true, blockedBy: "424242", blockReason: "test" }).block.kind, "by_admin");
    const system = profile({ isBanned: true, blockedBy: "system" }).block;
    assert.equal(system.kind, "bot_blocked_by_account");
    assert.equal(system.by, null);
  });
});

describe("search and filters", () => {
  const base = { role: "admin", status: "active", name: null, displayName: null, username: null };
  const admin = { ...base, telegramId: "771", name: "Sara Fake", displayName: "Night shift", username: "sara_fake" };
  const filters = (input) => normalizeDirectoryFilters(input);

  test("matches name, display name, username and Telegram ID, ignoring case and a leading @", () => {
    for (const search of ["sara", "SARA F", "night", "@Sara_fake", "77"]) assert.equal(matchesDirectoryFilters(admin, filters({ search })), true, search);
    assert.equal(matchesDirectoryFilters(admin, filters({ search: "nobody" })), false);
  });

  test("role and status narrow together with the search", () => {
    assert.equal(matchesDirectoryFilters(admin, filters({ role: "owner" })), false);
    assert.equal(matchesDirectoryFilters(admin, filters({ status: "removed" })), false);
    assert.equal(matchesDirectoryFilters(admin, filters({ role: "admin", status: "active", search: "sara" })), true);
  });

  test("a missing field is skipped, not matched as text", () => {
    assert.equal(matchesDirectoryFilters({ ...base, telegramId: "9" }, filters({ search: "null" })), false);
  });

  test("hostile or malformed input cannot reach a query", () => {
    assert.deepEqual(filters({ search: { $ne: 1 }, role: ["owner"], status: "drop" }), { search: "", role: "all", status: "all" });
    assert.equal(filters({ search: "x".repeat(500) }).search.length, 64);
    assert.equal(matchesDirectoryFilters(admin, filters({ search: ".*" })), false);
  });
});

describe("ordering and totals", () => {
  const row = (telegramId, status, role, lastActivityAt, state = "offline") => ({ telegramId, status, role, lastActivityAt, presence: { state } });

  test("current admins first, the owner leading, then the most recently active", () => {
    const sorted = sortProfiles([row("1", "removed", "admin", ago(1)), row("2", "active", "admin", ago(90)), row("3", "active", "admin", ago(10)), row("4", "active", "owner", null), row("5", "blocked", "admin", ago(1))]);
    assert.deepEqual(sorted.map((item) => item.telegramId), ["4", "3", "2", "5", "1"]);
  });

  test("online is not counted when it cannot be known", () => {
    const rows = [row("1", "active", "owner", null, "online"), row("2", "removed", "admin", null), row("3", "blocked", "admin", null)];
    assert.deepEqual(summarizeProfiles(rows, true), { total: 3, active: 2, blocked: 1, removed: 1, online: 1 });
    assert.equal(summarizeProfiles(rows, false).online, null);
  });
});

describe("the presence record", () => {
  beforeEach(() => resetAdminPresenceForTests());

  test("writes at most once a minute per admin", async () => {
    const redis = makeFakeRedis();
    let writes = 0;
    const counted = { ...redis, set: async (...args) => { writes += 1; return redis.set(...args); } };
    notePanelRequest("1001", { redis: counted, now: () => NOW });
    notePanelRequest("1001", { redis: counted, now: () => NOW + 59_000 });
    notePanelRequest("1002", { redis: counted, now: () => NOW + 59_000 });
    notePanelRequest("1001", { redis: counted, now: () => NOW + 60_000 });
    await flush();
    assert.equal(writes, 3);
  });

  test("a failed write is swallowed and the next request tries again", async () => {
    let attempts = 0;
    const failing = { set: async () => { attempts += 1; throw new Error("redis down"); } };
    notePanelRequest("1001", { redis: failing, now: () => NOW });
    await flush();
    notePanelRequest("1001", { redis: failing, now: () => NOW + 1 });
    await flush();
    assert.equal(attempts, 2);
  });

  test("a client that throws synchronously cannot break the caller", () => {
    assert.doesNotThrow(() => notePanelRequest("1001", { redis: { set() { throw new Error("closed"); } }, now: () => NOW }));
  });

  test("the middleware always continues, whatever the store does", () => {
    let continued = 0;
    trackAdminPresence({ adminActorId: "1001" }, {}, () => { continued += 1; });
    trackAdminPresence({ adminActorId: null }, {}, () => { continued += 1; });
    assert.equal(continued, 2);
  });

  test("round-trips through the store and reports a missing record as absent", async () => {
    const redis = makeFakeRedis();
    notePanelRequest("1001", { redis, now: () => NOW });
    await flush();
    const { available, lastSeen } = await readPanelPresence(["1001", "1002"], { redis });
    assert.equal(available, true);
    assert.equal(lastSeen.get("1001").getTime(), NOW);
    assert.equal(lastSeen.has("1002"), false);
  });

  test("a damaged value is ignored", async () => {
    const redis = makeFakeRedis();
    await redis.set("admin:web:presence:1001", "not-a-time");
    assert.equal((await readPanelPresence(["1001"], { redis })).lastSeen.size, 0);
  });

  test("no store, a failing store and a hung store all read as unavailable", async () => {
    assert.equal((await readPanelPresence(["1"], { redis: null })).available, false);
    assert.equal((await readPanelPresence(["1"], { redis: { mGet: async () => { throw new Error("down"); } } })).available, false);
    assert.equal((await readPanelPresence(["1"], { redis: { mGet: () => new Promise(() => {}) }, timeoutMs: 10 })).available, false);
  });

  test("an empty list does not send an empty MGET, which Redis rejects", async () => {
    let called = false;
    const result = await readPanelPresence([], { redis: { mGet: async () => { called = true; return []; } } });
    assert.equal(result.available, true);
    assert.equal(called, false);
  });
});

describe("the boundaries of this feature", () => {
  const router = repo("web/adminRouter.js");

  test("the presence record is read after the session guards, so an unauthenticated request leaves no trace", () => {
    const at = (text) => { const index = router.indexOf(text); assert.ok(index >= 0, text); return index; };
    assert.ok(at("router.use(requireAdminSession);") < at("router.use(trackAdminPresence);"));
    assert.ok(at("router.use(requireCsrfToken);") < at("router.use(trackAdminPresence);"));
  });

  test("the directory routes sit behind those guards and are reads", () => {
    assert.ok(router.indexOf("router.use(requireAdminSession);") < router.indexOf('router.get("/admins/directory"'));
    assert.doesNotMatch(router, /router\.(post|patch|put|delete)\("\/admins\/directory/);
  });

  test("the directory writes nothing", () => {
    const write = /\.(create|save|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|replaceOne|deleteOne|deleteMany|bulkWrite)\(/;
    assert.doesNotMatch(repo("services/admin/adminDirectory.js"), write);
  });

  test("presence stays out of authentication and authorization", () => {
    for (const path of ["services/admin/auth.js", "services/admin/authorization.js", "web/adminMiddleware.js", "utils/auth.js"]) assert.doesNotMatch(repo(path), /adminPresence|admin:web:presence/, path);
  });

  test("the stale customer activity field is not read", () => {
    assert.doesNotMatch(repo("services/admin/adminDirectory.js").replace(/\/\*\*[\s\S]*?\*\//g, ""), /lastActivityAt:\s*user|user\??\.lastActivityAt|USER_FIELDS = "[^"]*lastActivityAt/);
  });
});

describe("panel wording", () => {
  const { actionLabel, adminLabel, auditedEvents, blockExplanation, formatSince, presenceLabel, telegramProfileUrl } = loadPanelLib();
  const at = "2026-11-01T12:00:00.000Z";
  const before = (ms) => new Date(Date.parse(at) - ms).toISOString();

  test("the best name on record wins, down to the ID", () => {
    const empty = { name: null, displayName: null, username: null, telegramId: "9" };
    assert.equal(adminLabel({ ...empty, name: "N", displayName: "D", username: "u" }), "N");
    assert.equal(adminLabel({ ...empty, displayName: "D", username: "u" }), "D");
    assert.equal(adminLabel({ ...empty, username: "u" }), "@u");
    assert.equal(adminLabel(empty), "9");
  });

  test("an unknown state never reads as offline", () => {
    assert.equal(presenceLabel({ state: "online", reason: null }), "Online");
    assert.equal(presenceLabel({ state: "offline", reason: null }), "Offline");
    assert.equal(presenceLabel({ state: "unknown", reason: "no_record" }), "Not seen in panel");
    assert.equal(presenceLabel({ state: "unknown", reason: "unavailable" }), "Status unavailable");
  });

  test("elapsed time is measured from the server's clock", () => {
    assert.equal(formatSince(null, at), null);
    assert.equal(formatSince("garbage", at), null);
    assert.equal(formatSince(before(10_000), at), "Just now");
    assert.equal(formatSince(before(5 * 60_000), at), "5 min ago");
    assert.equal(formatSince(before(3 * 3_600_000), at), "3 hr ago");
    assert.equal(formatSince(before(86_400_000), at), "1 day ago");
    assert.equal(formatSince(before(10 * 86_400_000), at), "10 days ago");
    assert.equal(formatSince(before(60 * 86_400_000), at), "2 mo ago");
    assert.equal(formatSince(before(400 * 86_400_000), at), "1 yr ago");
  });

  test("only a real Telegram username becomes a link", () => {
    assert.equal(telegramProfileUrl("ada_fake"), "https://t.me/ada_fake");
    for (const value of [null, "ab", "x/../evil", "a b", 'a"><script>']) assert.equal(telegramProfileUrl(value), null, String(value));
  });

  test("audit actions read as words, and counts agree with their noun", () => {
    assert.equal(actionLabel("ADMIN_ADDED"), "Admin added");
    assert.equal(auditedEvents(0), "0 audited events");
    assert.equal(auditedEvents(1), "1 audited event");
    assert.equal(auditedEvents(1200), "1,200 audited events");
  });

  test("each kind of block says what it means", () => {
    assert.match(blockExplanation({ kind: "by_admin", at: null, by: null, reason: null }), /not gated/);
    assert.match(blockExplanation({ kind: "bot_blocked_by_account", at: null, by: null, reason: null }), /sign-in codes/);
  });
});
