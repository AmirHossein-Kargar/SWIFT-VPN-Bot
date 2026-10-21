/**
 * Multi-admin registry MUTATIONS against a REAL MongoDB.
 *
 * Requirement 10: owner adds/removes admins; server-side enforcement; admins
 * cannot self-elevate; owner-only actions protected; every change audited;
 * env ADMINS never weakened.
 *
 * Needs MongoDB (AdminAccount + AdminAuditLog collections); skips with an
 * explicit reason when the test database is not reachable.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

const OWNER = 910001;
const ENV_ADMIN = 910002; // secondary env admin (NOT the owner)
const EXTRA = 910100;

process.env.ADMINS = `${OWNER},${ENV_ADMIN}`;
delete process.env.OWNER_TELEGRAM_ID;

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let registry, AdminAccount, AdminAuditLog;
if (dbAvailable) {
  registry = await import("../../services/admin/adminRegistry.js");
  ({ default: AdminAccount } = await import("../../models/AdminAccount.js"));
  ({ default: AdminAuditLog } = await import("../../models/AdminAuditLog.js"));
}

beforeEach(async () => {
  if (!dbAvailable) return;
  await AdminAccount.deleteMany({});
  await AdminAuditLog.deleteMany({});
  registry.resetAdminRegistryForTests(null);
});

after(async () => {
  await disconnectTestDB();
});

describe("addAdmin (owner-only, audited, idempotent)", () => {
  skip("owner adds an admin; the new admin immediately authorizes and an audit record exists", async () => {
    const result = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-1-operation-0000", telegramId: String(EXTRA), displayName: "پشتیبان" });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPresent, undefined);

    assert.equal(registry.isRegisteredAdmin(String(EXTRA)), true);
    const { isAdminUser } = await import("../../utils/auth.js");
    assert.equal(isAdminUser(EXTRA), true, "database admin extends the allowlist");

    const audit = await AdminAuditLog.findOne({ operationId: "ADM-ADD-1-operation-0000" }).lean();
    assert.equal(audit.action, "ADMIN_ADDED");
    assert.equal(audit.actorTelegramId, String(OWNER));
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.targetType, "admin");
  });

  skip("non-owner (env secondary admin, or a database admin) can NEVER add admins", async () => {
    await assert.rejects(
      () => registry.addAdmin({ actorId: String(ENV_ADMIN), operationId: "ADM-ADD-2-operation-0000", telegramId: "910200" }),
      (error) => error.code === "owner_only" && /مالک اصلی/.test(error.message)
    );

    await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-2b-operation-0000", telegramId: String(EXTRA) });
    // A database-added admin tries to elevate someone else.
    await assert.rejects(
      () => registry.addAdmin({ actorId: String(EXTRA), operationId: "ADM-ADD-3-operation-0000", telegramId: "910300" }),
      (error) => error.code === "owner_only"
    );
    const count = await AdminAccount.countDocuments({ telegramId: "910300", removedAt: null });
    assert.equal(count, 0, "no self-propagation");
  });

  skip("adding the owner or an existing admin is a safe no-op conflict", async () => {
    await assert.rejects(
      () => registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-4-operation-0000", telegramId: String(OWNER) }),
      (error) => error.code === "admin_already_owner"
    );
    await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-5-operation-0000", telegramId: String(EXTRA) });
    const again = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-6-operation-0000", telegramId: String(EXTRA) });
    assert.equal(again.alreadyPresent, true);
    const active = await AdminAccount.countDocuments({ telegramId: String(EXTRA), removedAt: null });
    assert.equal(active, 1, "no duplicate rows");
  });

  skip("invalid telegram ids are rejected and never touch the database", async () => {
    for (const bad of ["", "abc", "-5", "0912", "123456789012345678901"]) {
      await assert.rejects(
        () => registry.addAdmin({ actorId: String(OWNER), operationId: `ADM-BAD-${bad.length}-operation-0000`, telegramId: bad }),
        (error) => error.code === "invalid_admin_id"
      );
    }
  });

  skip("the same operationId replays idempotently instead of double-adding", async () => {
    const first = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-IDEM-operation-0000", telegramId: String(EXTRA) });
    assert.equal(first.alreadyPresent, undefined, "the first call really creates the admin");
    const replay = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-IDEM-operation-0000", telegramId: String(EXTRA) });
    // A replay returns the outcome recorded by the first execution (it never re-runs the mutation). This line used
    // to assert alreadyPresent === true, which only held because the bug reported every first add that way.
    assert.equal(replay.telegramId, String(EXTRA), "replay returns the originally recorded outcome");
    assert.equal(replay.alreadyPresent, undefined, "and does not pretend the admin pre-existed");
    assert.equal(await AdminAccount.countDocuments({ telegramId: String(EXTRA), removedAt: null }), 1);
    assert.equal(await AdminAuditLog.countDocuments({ operationId: "ADM-IDEM-operation-0000" }), 1, "one audit record, not two");
  });
});

describe("removeAdmin (owner-only, protects owner and env admins)", () => {
  skip("owner removes a database admin; access drops immediately", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "RM-1-ADD-operation-0000", telegramId: String(EXTRA) });
    assert.equal((await import("../../utils/auth.js")).isAdminUser(EXTRA), true);

    const result = await registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-1-operation-0000", telegramId: String(EXTRA) });
    assert.equal(result.ok, true);

    registry.resetAdminRegistryForTests(null);
    await registry.refreshAdminCache();
    assert.equal((await import("../../utils/auth.js")).isAdminUser(EXTRA), false, "revoked admin loses access");
    const audit = await AdminAuditLog.findOne({ operationId: "RM-1-operation-0000" }).lean();
    assert.equal(audit.action, "ADMIN_REMOVED");
    assert.equal(audit.status, "succeeded");
  });

  skip("non-owners cannot remove anyone, not even themselves", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "RM-2-ADD-operation-0000", telegramId: String(EXTRA) });
    await assert.rejects(
      () => registry.removeAdmin({ actorId: String(EXTRA), operationId: "RM-2-operation-0000", telegramId: String(EXTRA) }),
      (error) => error.code === "owner_only"
    );
  });

  skip("the owner and env-configured admins are protected from removal", async () => {
    await assert.rejects(
      () => registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-3-operation-0000", telegramId: String(OWNER) }),
      (error) => error.code === "owner_protected" && /ADMINS/.test(error.message)
    );
    await assert.rejects(
      () => registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-4-operation-0000", telegramId: String(ENV_ADMIN) }),
      (error) => error.code === "admin_from_environment"
    );
  });

  skip("removing an unknown admin is an idempotent no-op", async () => {
    const result = await registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-5-operation-0000", telegramId: "919999" });
    assert.equal(result.alreadyRemoved, true);
  });
});

describe("listAdmins (merged view)", () => {
  skip("environment admins, the owner flag and database rows are all reported", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "LS-1-ADD-operation-0000", telegramId: String(EXTRA), displayName: "پشتیبان" });
    const list = await registry.listAdmins({ actorId: String(ENV_ADMIN) });
    const byId = new Map(list.map((admin) => [admin.telegramId, admin]));
    assert.equal(byId.get(String(OWNER)).role, "owner");
    assert.equal(byId.get(String(OWNER)).source, "environment");
    assert.equal(byId.get(String(ENV_ADMIN)).role, "admin");
    assert.equal(byId.get(String(EXTRA)).source, "database");
    assert.equal(byId.get(String(EXTRA)).displayName, "پشتیبان");
  });
});

// ── Regression: addAdmin must distinguish "no record" from "active record" and create/re-activate atomically ──
// (Previously `existing?.removedAt == null` was also true for a missing record, and the update had no upsert, so a
// brand-new admin was reported as "already present" and never stored.)
describe("addAdmin upsert semantics (real MongoDB)", () => {
  const op = (name) => `${name}-regression-0000`;
  const NEW_ID = "910555";
  const active = (id) => AdminAccount.find({ telegramId: String(id), removedAt: null }).lean();
  const rows = (id) => AdminAccount.find({ telegramId: String(id) }).lean();

  skip("the unique telegramId index the fix relies on really exists", async () => {
    await AdminAccount.init();
    const indexes = await AdminAccount.collection.indexes();
    assert.ok(indexes.some((index) => index.unique && index.key?.telegramId === 1 && Object.keys(index.key).length === 1), JSON.stringify(indexes.map((index) => index.name)));
    await AdminAccount.create({ telegramId: NEW_ID, addedBy: String(OWNER) });
    await assert.rejects(() => AdminAccount.collection.insertOne({ telegramId: NEW_ID, addedBy: "x", removedAt: null }), (error) => error.code === 11000);
  });

  skip("a previously nonexistent admin is created exactly once, active, audited and authorized immediately", async () => {
    const { isAdminUser } = await import("../../utils/auth.js");
    assert.equal(isAdminUser(NEW_ID), false);
    const result = await registry.addAdmin({ actorId: String(OWNER), operationId: op("NEW-1"), telegramId: NEW_ID, displayName: "  Support Agent  " });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPresent, undefined, "not reported as already present");
    assert.equal(result.reactivated, undefined);
    const stored = await rows(NEW_ID);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].role, "admin");
    assert.equal(stored[0].displayName, "Support Agent");
    assert.equal(stored[0].addedBy, String(OWNER));
    assert.equal(stored[0].removedAt, null);
    assert.ok(stored[0].addedAt instanceof Date);
    assert.equal(isAdminUser(NEW_ID), true);
    const audit = await AdminAuditLog.findOne({ operationId: op("NEW-1") }).lean();
    assert.equal(audit.action, "ADMIN_ADDED");
    assert.equal(audit.status, "succeeded");
  });

  skip("adding an already-active admin is a no-op: same single row, nothing overwritten", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: op("ACT-1"), telegramId: NEW_ID, displayName: "First Name" });
    const before = (await rows(NEW_ID))[0];
    const again = await registry.addAdmin({ actorId: String(OWNER), operationId: op("ACT-2"), telegramId: NEW_ID, displayName: "Different Name" });
    assert.equal(again.alreadyPresent, true);
    const after = await rows(NEW_ID);
    assert.equal(after.length, 1, "no duplicate row");
    assert.equal(after[0].displayName, "First Name", "the existing admin's data is not overwritten");
    assert.equal(after[0].addedAt.getTime(), before.addedAt.getTime());
    assert.equal(after[0].addedBy, before.addedBy);
    assert.equal(after[0].removedAt, null);
  });

  skip("a removed admin is re-added in place: one row, history rewritten, access restored, every step audited", async () => {
    const { isAdminUser } = await import("../../utils/auth.js");
    await registry.addAdmin({ actorId: String(OWNER), operationId: op("RE-1"), telegramId: NEW_ID, displayName: "Old Name" });
    await registry.removeAdmin({ actorId: String(OWNER), operationId: op("RE-2"), telegramId: NEW_ID });
    assert.equal(isAdminUser(NEW_ID), false, "removed admin has no access");
    const removed = (await rows(NEW_ID))[0];
    assert.ok(removed.removedAt instanceof Date);
    assert.equal(removed.removedBy, String(OWNER));

    const readded = await registry.addAdmin({ actorId: String(OWNER), operationId: op("RE-3"), telegramId: NEW_ID, displayName: "New Name" });
    assert.equal(readded.reactivated, true);
    assert.equal(readded.alreadyPresent, undefined);
    const stored = await rows(NEW_ID);
    assert.equal(stored.length, 1, "re-adding never creates a second row");
    assert.equal(stored[0].removedAt, null);
    assert.equal(stored[0].removedBy, null);
    assert.equal(stored[0].displayName, "New Name");
    assert.ok(stored[0].addedAt.getTime() >= removed.removedAt.getTime());
    assert.equal(isAdminUser(NEW_ID), true, "access restored immediately");
    assert.deepEqual((await AdminAuditLog.find({ targetId: NEW_ID }).sort({ createdAt: 1 }).lean()).map((audit) => audit.action), ["ADMIN_ADDED", "ADMIN_REMOVED", "ADMIN_ADDED"]);
  });

  skip("concurrent duplicate adds of a NEW admin produce exactly one active row: one creator, the rest 'already present', none rejected", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => registry.addAdmin({ actorId: String(OWNER), operationId: op(`CONC-${i}`), telegramId: NEW_ID })));
    assert.ok(results.every((entry) => entry.status === "fulfilled"), JSON.stringify(results.filter((entry) => entry.status === "rejected").map((entry) => String(entry.reason))));
    const created = results.filter((entry) => entry.value.alreadyPresent === undefined && !entry.value.reactivated);
    assert.equal(created.length, 1, "exactly one request created the admin");
    assert.equal(results.filter((entry) => entry.value.alreadyPresent === true).length, 7);
    assert.equal((await rows(NEW_ID)).length, 1);
    assert.equal((await active(NEW_ID)).length, 1);
  });

  skip("concurrent re-adds of a REMOVED admin re-activate it once and never duplicate it", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: op("CR-A"), telegramId: NEW_ID });
    await registry.removeAdmin({ actorId: String(OWNER), operationId: op("CR-R"), telegramId: NEW_ID });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => registry.addAdmin({ actorId: String(OWNER), operationId: op(`CR-${i}`), telegramId: NEW_ID })));
    assert.ok(results.every((entry) => entry.status === "fulfilled"));
    assert.equal(results.filter((entry) => entry.value.reactivated === true).length, 1);
    assert.equal(results.filter((entry) => entry.value.alreadyPresent === true).length, 7);
    assert.equal((await rows(NEW_ID)).length, 1);
    assert.equal((await active(NEW_ID)).length, 1);
  });

  skip("authorization is unchanged: non-owners and env admins cannot add, and nothing is written", async () => {
    for (const actor of [ENV_ADMIN, 424242, "not-a-number"]) {
      await assert.rejects(() => registry.addAdmin({ actorId: String(actor), operationId: op(`DENY-${actor}`), telegramId: NEW_ID }), (error) => error.code === "owner_only");
    }
    assert.equal((await rows(NEW_ID)).length, 0);
    assert.equal(await AdminAuditLog.countDocuments({ action: "ADMIN_ADDED" }), 0, "a refused request leaves no success audit");
  });
});
