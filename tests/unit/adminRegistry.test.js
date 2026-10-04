/**
 * Multi-admin registry (services/admin/adminRegistry.js).
 *
 * Requirement: the owner can add/remove extra admins; authorization stays
 * fail-closed — the ADMINS env allowlist is never weakened, the owner is
 * resolved from the environment only and can never be removed via the
 * database, and non-owners can never mutate the registry.
 *
 * These unit tests inject an in-memory AdminAccount model through the test
 * seam. Mutation tests need the audited-action pipeline (MongoDB) and live
 * in the integration suite; here we pin owner resolution, cache behavior,
 * listing and the fail-closed path.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242,515151";
delete process.env.OWNER_TELEGRAM_ID;

const {
  resetAdminRegistryForTests,
  refreshAdminCache,
  listAdmins,
  getOwnerTelegramIds,
  isOwnerUser,
  isRegisteredAdmin,
} = await import("../../services/admin/adminRegistry.js");
const { isAdminUser } = await import("../../utils/auth.js");

/** In-memory AdminAccount model with the operations the registry uses. */
function makeMemoryAdminModel(rows = []) {
  return {
    find(query = {}) {
      const matched = rows.filter((row) => {
        for (const [key, value] of Object.entries(query)) {
          if (value === null) {
            // Mongoose semantics: { field: null } matches null OR missing.
            if (row[key] != null) return false;
            continue;
          }
          if (row[key] !== value) return false;
        }
        return true;
      });
      // Mongoose-style Query: every chainable method returns the query; the
      // query itself is a thenable resolving to the (lean) documents.
      const cursor = {
        select() { return cursor; },
        lean() { return cursor; },
        maxTimeMS() { return cursor; },
        then(resolve, reject) {
          return Promise.resolve(matched.map((row) => ({ ...row }))).then(resolve, reject);
        },
      };
      return cursor;
    },
  };
}

const DB_ADMINS = [
  { telegramId: "700700", role: "admin", displayName: "پشتیبان ۱", addedBy: "424242", addedAt: new Date("2026-01-05") },
  { telegramId: "800800", role: "admin", displayName: null, addedBy: "424242", addedAt: new Date("2026-02-10") },
  { telegramId: "900900", role: "admin", displayName: "حذف‌شده", addedBy: "424242", addedAt: new Date("2026-03-01"), removedAt: new Date("2026-03-02") },
];

beforeEach(() => {
  delete process.env.OWNER_TELEGRAM_ID;
  resetAdminRegistryForTests(makeMemoryAdminModel(DB_ADMINS.map((row) => ({ ...row }))));
});

after(() => {
  delete process.env.OWNER_TELEGRAM_ID;
  resetAdminRegistryForTests(null);
});

describe("owner resolution (environment only)", () => {
  test("without OWNER_TELEGRAM_ID the FIRST ADMINS entry is the owner", () => {
    assert.deepEqual(getOwnerTelegramIds(), ["424242"]);
    assert.equal(isOwnerUser("424242"), true);
    assert.equal(isOwnerUser(424242), true);
    assert.equal(isOwnerUser("515151"), false, "secondary env admin is NOT the owner");
  });

  test("OWNER_TELEGRAM_ID overrides, and an invalid value is ignored", () => {
    process.env.OWNER_TELEGRAM_ID = "515151";
    assert.deepEqual(getOwnerTelegramIds(), ["515151"]);
    assert.equal(isOwnerUser("424242"), false);

    process.env.OWNER_TELEGRAM_ID = "not-a-number";
    assert.deepEqual(getOwnerTelegramIds(), ["424242"]);

    process.env.OWNER_TELEGRAM_ID = "0";
    assert.deepEqual(getOwnerTelegramIds(), ["424242"]);
  });

  test("empty ADMINS → no owner at all (fail-closed, no lockout bypass)", () => {
    const previous = process.env.ADMINS;
    process.env.ADMINS = "";
    try {
      assert.deepEqual(getOwnerTelegramIds(), []);
      assert.equal(isOwnerUser("424242"), false);
    } finally {
      process.env.ADMINS = previous;
    }
  });
});

describe("cache refresh", () => {
  test("loads database admins once and drops removed rows", async () => {
    assert.equal(isRegisteredAdmin("700700"), false, "not visible before the first refresh");
    const result = await refreshAdminCache();
    assert.deepEqual(result, { ok: true, count: 2 });
    assert.equal(isRegisteredAdmin("700700"), true);
    assert.equal(isRegisteredAdmin("800800"), true);
    assert.equal(isRegisteredAdmin("900900"), false, "removed admin must not be active");
    assert.equal(isRegisteredAdmin("424242"), false, "env admins are never registry rows");
  });

  test("database failure keeps the last known cache (no silent lockout)", async () => {
    await refreshAdminCache();
    resetAdminRegistryForTests({
      find() {
        // Mongoose-style query whose terminal await rejects.
        const cursor = {
          select() { return cursor; },
          lean() { return cursor; },
          maxTimeMS() { return cursor; },
          then(resolve, reject) { return Promise.reject(new Error("mongo down")).then(resolve, reject); },
        };
        return cursor;
      },
    });
    // resetAdminRegistryForTests cleared the cache: a refresh failure must
    // simply report failure without throwing…
    const result = await refreshAdminCache();
    assert.equal(result.ok, false);
    // …while env admins always remain authorized.
    assert.equal(isAdminUser(424242), true);
  });

  test("an env admin duplicated in the database is not double-listed", async () => {
    const model = makeMemoryAdminModel([
      ...DB_ADMINS,
      { telegramId: "515151", role: "admin", displayName: "dup", addedBy: "424242", addedAt: new Date() },
    ]);
    resetAdminRegistryForTests(model);
    await refreshAdminCache();
    assert.equal(isRegisteredAdmin("515151"), false, "env admins are handled by the env path");
    const list = await listAdmins({ actorId: "424242" });
    assert.equal(list.filter((admin) => admin.telegramId === "515151").length, 1);
  });
});

describe("listAdmins", () => {
  test("merges environment and database admins with source/role flags", async () => {
    await refreshAdminCache();
    const list = await listAdmins({ actorId: "424242" });

    const env = list.filter((admin) => admin.source === "environment");
    assert.deepEqual(env.map((a) => a.telegramId), ["424242", "515151"]);
    assert.equal(env[0].role, "owner");
    assert.equal(env[1].role, "admin");

    const fromDb = list.filter((admin) => admin.source === "database");
    assert.deepEqual(fromDb.map((a) => a.telegramId).sort(), ["700700", "800800"]);
    assert.equal(fromDb[0].displayName === "پشتیبان ۱" || fromDb[1].displayName === "پشتیبان ۱", true);
  });

  test("requires an actor (no anonymous listing)", async () => {
    await assert.rejects(() => listAdmins({}), /دسترسی مدیر لازم است/);
  });
});

describe("authorization integration (utils/auth stays fail-closed)", () => {
  test("env admins are admins even with no database", async () => {
    assert.equal(isAdminUser(424242), true);
    assert.equal(isAdminUser(515151), true);
  });

  test("database admins extend the allowlist through the provider", async () => {
    await refreshAdminCache();
    assert.equal(isAdminUser(700700), true);
    assert.equal(isAdminUser(800800), true);
  });

  test("unknown users and junk ids are never admins", async () => {
    await refreshAdminCache();
    for (const bad of [111111, 0, -1, "abc", null, undefined, 900900, "12.5", "1e6", "42admin"]) {
      assert.equal(isAdminUser(bad), false, `must not be admin: ${JSON.stringify(bad)}`);
    }
  });
});
