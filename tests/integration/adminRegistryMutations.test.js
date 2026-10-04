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
    const result = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-1", telegramId: String(EXTRA), displayName: "پشتیبان" });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPresent, undefined);

    assert.equal(registry.isRegisteredAdmin(String(EXTRA)), true);
    const { isAdminUser } = await import("../../utils/auth.js");
    assert.equal(isAdminUser(EXTRA), true, "database admin extends the allowlist");

    const audit = await AdminAuditLog.findOne({ operationId: "ADM-ADD-1" }).lean();
    assert.equal(audit.action, "ADMIN_ADDED");
    assert.equal(audit.actorTelegramId, String(OWNER));
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.targetType, "admin");
  });

  skip("non-owner (env secondary admin, or a database admin) can NEVER add admins", async () => {
    await assert.rejects(
      () => registry.addAdmin({ actorId: String(ENV_ADMIN), operationId: "ADM-ADD-2", telegramId: "910200" }),
      (error) => error.code === "owner_only" && /مالک اصلی/.test(error.message)
    );

    await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-2b", telegramId: String(EXTRA) });
    // A database-added admin tries to elevate someone else.
    await assert.rejects(
      () => registry.addAdmin({ actorId: String(EXTRA), operationId: "ADM-ADD-3", telegramId: "910300" }),
      (error) => error.code === "owner_only"
    );
    const count = await AdminAccount.countDocuments({ telegramId: "910300", removedAt: null });
    assert.equal(count, 0, "no self-propagation");
  });

  skip("adding the owner or an existing admin is a safe no-op conflict", async () => {
    await assert.rejects(
      () => registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-4", telegramId: String(OWNER) }),
      (error) => error.code === "admin_already_owner"
    );
    await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-5", telegramId: String(EXTRA) });
    const again = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-ADD-6", telegramId: String(EXTRA) });
    assert.equal(again.alreadyPresent, true);
    const active = await AdminAccount.countDocuments({ telegramId: String(EXTRA), removedAt: null });
    assert.equal(active, 1, "no duplicate rows");
  });

  skip("invalid telegram ids are rejected and never touch the database", async () => {
    for (const bad of ["", "abc", "-5", "0912", "123456789012345678901"]) {
      await assert.rejects(
        () => registry.addAdmin({ actorId: String(OWNER), operationId: `ADM-BAD-${bad.length}`, telegramId: bad }),
        (error) => error.code === "invalid_admin_id"
      );
    }
  });

  skip("the same operationId replays idempotently instead of double-adding", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-IDEM", telegramId: String(EXTRA) });
    const replay = await registry.addAdmin({ actorId: String(OWNER), operationId: "ADM-IDEM", telegramId: String(EXTRA) });
    assert.equal(replay.alreadyPresent, true);
    assert.equal(await AdminAccount.countDocuments({ telegramId: String(EXTRA), removedAt: null }), 1);
    assert.equal(await AdminAuditLog.countDocuments({ operationId: "ADM-IDEM" }), 1, "one audit record, not two");
  });
});

describe("removeAdmin (owner-only, protects owner and env admins)", () => {
  skip("owner removes a database admin; access drops immediately", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "RM-1-ADD", telegramId: String(EXTRA) });
    assert.equal((await import("../../utils/auth.js")).isAdminUser(EXTRA), true);

    const result = await registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-1", telegramId: String(EXTRA) });
    assert.equal(result.ok, true);

    registry.resetAdminRegistryForTests(null);
    await registry.refreshAdminCache();
    assert.equal((await import("../../utils/auth.js")).isAdminUser(EXTRA), false, "revoked admin loses access");
    const audit = await AdminAuditLog.findOne({ operationId: "RM-1" }).lean();
    assert.equal(audit.action, "ADMIN_REMOVED");
    assert.equal(audit.status, "succeeded");
  });

  skip("non-owners cannot remove anyone, not even themselves", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "RM-2-ADD", telegramId: String(EXTRA) });
    await assert.rejects(
      () => registry.removeAdmin({ actorId: String(EXTRA), operationId: "RM-2", telegramId: String(EXTRA) }),
      (error) => error.code === "owner_only"
    );
  });

  skip("the owner and env-configured admins are protected from removal", async () => {
    await assert.rejects(
      () => registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-3", telegramId: String(OWNER) }),
      (error) => error.code === "owner_protected" && /ADMINS/.test(error.message)
    );
    await assert.rejects(
      () => registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-4", telegramId: String(ENV_ADMIN) }),
      (error) => error.code === "admin_from_environment"
    );
  });

  skip("removing an unknown admin is an idempotent no-op", async () => {
    const result = await registry.removeAdmin({ actorId: String(OWNER), operationId: "RM-5", telegramId: "919999" });
    assert.equal(result.alreadyRemoved, true);
  });
});

describe("listAdmins (merged view)", () => {
  skip("environment admins, the owner flag and database rows are all reported", async () => {
    await registry.addAdmin({ actorId: String(OWNER), operationId: "LS-1-ADD", telegramId: String(EXTRA), displayName: "پشتیبان" });
    const list = await registry.listAdmins({ actorId: String(ENV_ADMIN) });
    const byId = new Map(list.map((admin) => [admin.telegramId, admin]));
    assert.equal(byId.get(String(OWNER)).role, "owner");
    assert.equal(byId.get(String(OWNER)).source, "environment");
    assert.equal(byId.get(String(ENV_ADMIN)).role, "admin");
    assert.equal(byId.get(String(EXTRA)).source, "database");
    assert.equal(byId.get(String(EXTRA)).displayName, "پشتیبان");
  });
});
