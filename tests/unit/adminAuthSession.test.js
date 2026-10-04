/**
 * Web admin authentication — Telegram-allowlist login codes and Redis-backed
 * sessions, exercised against an in-memory Redis stub.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

const ORIGINAL_ADMINS = process.env.ADMINS;
process.env.ADMINS = "424242";

const {
  issueAdminLoginCode,
  consumeAdminLoginCode,
  createAdminSession,
  getAdminSession,
  deleteAdminSession,
  ADMIN_SESSION_COOKIE,
} = await import("../../services/admin/auth.js");

function restore() {
  process.env.ADMINS = ORIGINAL_ADMINS || "424242";
}

describe("admin login codes", () => {
  beforeEach(restore);
  afterEach(restore);

  test("rejects Telegram IDs that are not allowlisted", async () => {
    process.env.ADMINS = "424242";
    const redis = makeFakeRedis();
    await assert.rejects(
      () => issueAdminLoginCode("111111", redis),
      (error) => error.code === "FORBIDDEN" && error.status === 403
    );
  });

  test("rate-limits repeated code issuance for the same admin", async () => {
    const redis = makeFakeRedis();
    await issueAdminLoginCode("424242", redis);
    await assert.rejects(
      () => issueAdminLoginCode("424242", redis),
      (error) => error.code === "LOGIN_CODE_RATE_LIMITED" && error.status === 429
    );
  });

  test("a code can be consumed exactly once and only by an admin", async () => {
    const redis = makeFakeRedis();
    const { code } = await issueAdminLoginCode("424242", redis);
    const actor = await consumeAdminLoginCode(code, redis);
    assert.equal(actor, "424242");
    assert.equal(await consumeAdminLoginCode(code, redis), null, "second use must fail");
    assert.equal(await consumeAdminLoginCode("totally-invalid-code", redis), null);
  });
});

describe("admin sessions", () => {
  beforeEach(restore);
  afterEach(restore);

  test("create → get → delete lifecycle", async () => {
    const redis = makeFakeRedis();
    const { token, session } = await createAdminSession("424242", redis);
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token));
    assert.equal(session.actorTelegramId, "424242");
    assert.ok(session.csrfToken);

    const loaded = await getAdminSession(token, redis);
    assert.equal(loaded.actorTelegramId, "424242");

    assert.equal(await deleteAdminSession(token, redis), true);
    assert.equal(await getAdminSession(token, redis), null);
  });

  test("expired sessions are rejected and removed", async () => {
    const redis = makeFakeRedis();
    const { token, session } = await createAdminSession("424242", redis, { ttlSeconds: 900 });
    // Force an already-expired session document into the store.
    await redis.set(`admin:web:session:${token}`, JSON.stringify({ ...session, expiresAt: Date.now() - 1000 }), { EX: 60 });
    assert.equal(await getAdminSession(token, redis), null);
  });

  test("a session whose actor was removed from ADMINS is invalid", async () => {
    const redis = makeFakeRedis();
    const { token } = await createAdminSession("424242", redis);
    process.env.ADMINS = "888888";
    assert.equal(await getAdminSession(token, redis), null);
  });

  test("non-admins can never create a session", async () => {
    const redis = makeFakeRedis();
    await assert.rejects(
      () => createAdminSession("111111", redis),
      (error) => error.code === "FORBIDDEN"
    );
  });

  test("cookie name is stable", () => {
    assert.equal(ADMIN_SESSION_COOKIE, "swift_admin_session");
  });
});
