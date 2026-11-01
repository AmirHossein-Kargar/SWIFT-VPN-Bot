/**
 * The admin directory over REAL HTTP against the real Express app, session, CSRF and origin middleware, with an in-memory
 * session store. Every case here is decided before a database is touched, so it needs no MongoDB.
 * tests/integration/adminDirectory.mongo.test.js covers the answers themselves.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";

const { setAdminSessionRedisForTests, createAdminSession, ADMIN_SESSION_COOKIE } = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const { resetAdminPresenceForTests, setAdminPresenceRedisForTests } = await import("../../services/admin/adminPresence.js");
const fakeRedis = makeFakeRedis();
const presenceRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);
const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const base = `http://127.0.0.1:${server.address().port}`;

const presenceKeys = () => [...presenceRedis.map.keys()].filter((key) => key.startsWith("admin:web:presence:"));
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

async function call(path, { cookie, method = "GET", headers = {}, body } = {}) {
  const sent = { ...headers };
  if (cookie) sent.cookie = cookie;
  if (body !== undefined) sent["content-type"] = "application/json";
  const response = await fetch(`${base}/api/admin${path}`, { method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
}

let cookie;
before(async () => {
  const session = await createAdminSession("424242", fakeRedis);
  cookie = `${ADMIN_SESSION_COOKIE}=${session.token}`;
});
beforeEach(() => {
  resetAdminRateLimitsForTests();
  resetAdminPresenceForTests();
  setAdminPresenceRedisForTests(presenceRedis);
  presenceRedis.map.clear();
});
after(async () => {
  resetAdminPresenceForTests();
  await new Promise((resolve) => server.close(resolve));
});

describe("who can read the directory", () => {
  test("no session is refused on both routes, and leaves no presence record", async () => {
    for (const path of ["/admins/directory", "/admins/directory/424242"]) {
      const response = await call(path);
      assert.equal(response.status, 401, path);
      assert.equal(response.data.error, "unauthorized");
    }
    await settle();
    assert.deepEqual(presenceKeys(), []);
  });

  test("an invalid session is refused", async () => {
    const response = await call("/admins/directory", { cookie: `${ADMIN_SESSION_COOKIE}=${"x".repeat(43)}` });
    assert.equal(response.status, 401);
    await settle();
    assert.deepEqual(presenceKeys(), []);
  });

  test("a cross-site browser request is refused before any session check", async () => {
    const response = await call("/admins/directory", { cookie, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(response.status, 403);
    assert.equal(response.data.error, "origin_not_allowed");
  });

  test("a malformed Telegram ID is refused before any lookup", async () => {
    const response = await call("/admins/directory/not-a-number", { cookie });
    assert.equal(response.status, 400);
    assert.equal(response.data.error, "invalid_user_id");
  });

  test("the directory has no write route", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await call("/admins/directory/424242", { cookie, method, body: {} });
      assert.ok([403, 404].includes(response.status), `${method} answered ${response.status}`);
    }
  });
});

describe("what an authenticated request does", () => {
  test("it leaves one presence record, without a session token in it", async () => {
    const first = await call("/admins/directory/not-a-number", { cookie });
    assert.equal(first.status, 400);
    await settle();
    assert.deepEqual(presenceKeys(), ["admin:web:presence:424242"]);
    const value = presenceRedis.map.get("admin:web:presence:424242");
    assert.match(value, /^\d{13}$/);
  });

  test("a broken presence store changes nothing about the answer", async () => {
    setAdminPresenceRedisForTests({ set: async () => { throw new Error("redis down"); }, mGet: async () => { throw new Error("redis down"); } });
    const response = await call("/admins/directory/not-a-number", { cookie });
    assert.equal(response.status, 400);
    assert.equal(response.data.error, "invalid_user_id");
  });

  test("the responses stay private", async () => {
    const response = await call("/admins/directory/not-a-number", { cookie });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});
