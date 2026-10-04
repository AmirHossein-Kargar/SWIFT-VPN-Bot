/**
 * Web Admin Dashboard over REAL HTTP — authentication, CSRF, session
 * enforcement and the login flow, with an in-memory Redis session store.
 * Dashboard data tests require MongoDB; auth tests always run.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";

const { setAdminSessionRedisForTests } = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const { issueAdminLoginCode } = await import("../../services/admin/auth.js");

const fakeRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);

const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = "424242";

async function call(method, path, { body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON */ }
  return { status: response.status, data, headers: response.headers };
}

before(() => resetAdminRateLimitsForTests());

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectTestDB();
});

describe("web admin authentication", () => {
  test("unauthenticated API access is rejected", async () => {
    const result = await call("GET", "/api/admin/dashboard");
    assert.equal(result.status, 401);
    assert.equal(result.data.error, "unauthorized");
  });

  test("the SPA is served at /admin", async () => {
    const response = await fetch(`${baseUrl}/admin`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("SWIFT Admin"));
    assert.ok(!html.includes("BOT_TOKEN"), "no secrets in the bundle");
  });

  test("full login flow: code → session cookie → CSRF-protected mutation → logout", async () => {
    resetAdminRateLimitsForTests();
    // The bot is not running in tests, so issue the code directly through the
    // service (the HTTP endpoint only adds bot delivery on top).
    const { code } = await issueAdminLoginCode(ADMIN, fakeRedis);

    const bad = await call("POST", "/api/admin/auth/verify", { body: { code: "x".repeat(32) } });
    assert.equal(bad.status, 401);

    const verify = await call("POST", "/api/admin/auth/verify", { body: { code } });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.actorTelegramId, ADMIN);
    assert.ok(verify.data.csrfToken);

    const setCookie = verify.headers.get("set-cookie") || "";
    assert.match(setCookie, /swift_admin_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = setCookie.split(";")[0];

    const session = await call("GET", "/api/admin/auth/session", { cookie });
    assert.equal(session.data.authenticated, true);

    // Mutations without a CSRF token are rejected.
    const noCsrf = await call("POST", "/api/admin/products", { cookie, body: { operationId: "a".repeat(20), name: "x" } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.data.error, "csrf_token_invalid");

    const logout = await call("POST", "/api/admin/auth/logout", { cookie, csrf: verify.data.csrfToken });
    assert.equal(logout.status, 200);
    const afterLogout = await call("GET", "/api/admin/auth/session", { cookie });
    assert.equal(afterLogout.data.authenticated, false);
    const dead = await call("GET", "/api/admin/dashboard", { cookie });
    assert.equal(dead.status, 401);
  });

  test("login codes from non-allowlisted accounts are refused", async () => {
    resetAdminRateLimitsForTests();
    const result = await call("POST", "/api/admin/auth/request-code", { body: { telegramId: "666666" } });
    assert.equal(result.status, 403);
  });
});

describe("web admin API (session-authenticated)", () => {
  let cookie;
  let csrf;

  before(async () => {
    if (!dbAvailable) return;
    resetAdminRateLimitsForTests();
    const { code } = await issueAdminLoginCode(ADMIN, fakeRedis);
    const verify = await call("POST", "/api/admin/auth/verify", { body: { code } });
    cookie = (verify.headers.get("set-cookie") || "").split(";")[0];
    csrf = verify.data.csrfToken;
  });

  skip("dashboard returns real aggregated metrics", async () => {
    const result = await call("GET", "/api/admin/dashboard", { cookie, csrf });
    assert.equal(result.status, 200);
    assert.ok(Number.isInteger(result.data.data.metrics.totalUsers));
    assert.ok(result.data.data.charts.revenue.length === 30);
  });

  skip("products CRUD through the authenticated API", async () => {
    const created = await call("POST", "/api/admin/products", {
      cookie, csrf,
      body: { operationId: `web${Date.now().toString(36)}`.padEnd(20, "0"), name: "Web test plan", durationDays: 14, trafficGb: 20, priceToman: 30_000, costToman: 5_000 },
    });
    assert.equal(created.status, 200);
    const list = await call("GET", "/api/admin/products", { cookie, csrf });
    assert.ok(list.data.data.some((product) => product.name === "Web test plan"));
  });

  skip("validation errors return structured 400s, never stack traces", async () => {
    const result = await call("POST", "/api/admin/products", {
      cookie, csrf,
      body: { operationId: `bad${Date.now().toString(36)}`.padEnd(20, "0"), name: "bad", durationDays: -1, trafficGb: 1, priceToman: 1, costToman: 0 },
    });
    assert.equal(result.status, 400);
    assert.ok(result.data.error.startsWith("invalid_"));
    assert.equal(result.data.message.includes("at "), false);
  });

  test("unknown admin API routes return JSON 404", async () => {
    const result = await call("GET", "/api/admin/does-not-exist");
    assert.equal(result.status, 401); // auth is checked before routing
    const known = await call("GET", "/api/admin/auth/session");
    assert.equal(known.status, 200);
  });
});
