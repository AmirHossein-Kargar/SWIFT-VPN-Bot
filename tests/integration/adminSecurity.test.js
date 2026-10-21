/**
 * Web admin security suite over REAL HTTP against the actual Express app, with
 * an in-memory Redis session store. It needs no MongoDB: every case is decided
 * (rejected) before any database access. Nothing here touches live services.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242,424243";
process.env.GROUP_ID = "";

const authModule = await import("../../services/admin/auth.js");
const { setAdminSessionRedisForTests, issueAdminLoginCode, createAdminSession, ADMIN_SESSION_COOKIE, ADMIN_SESSION_PREFIX } = authModule;
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const { default: adminRouter } = await import("../../web/adminRouter.js");
const { ADMIN_CSP } = await import("../../web/spa.js");
const { buildUserSearchQuery } = await import("../../services/admin/users.js");
const { requireTelegramId, requireServiceUsername } = await import("../../services/admin/validation.js");

const fakeRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);

const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { body, cookie, csrf, headers: extra = {}, raw } = {}) {
  const headers = { ...extra };
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, data, text, headers: response.headers };
}

function clearLoginRateKeys() {
  for (const key of [...fakeRedis.map.keys()]) if (key.startsWith("admin:web:login-rate:")) fakeRedis.map.delete(key);
}

async function login(telegramId = "424242") {
  resetAdminRateLimitsForTests();
  clearLoginRateKeys();
  const { code } = await issueAdminLoginCode(telegramId, fakeRedis);
  const verify = await call("POST", "/api/admin/auth/verify", { body: { code } });
  assert.equal(verify.status, 200);
  const setCookie = verify.headers.get("set-cookie") || "";
  return { cookie: setCookie.split(";")[0], csrf: verify.data.csrfToken, setCookie, body: verify };
}

before(() => resetAdminRateLimitsForTests());
beforeEach(() => resetAdminRateLimitsForTests());
after(async () => { await new Promise((resolve) => server.close(resolve)); setAdminSessionRedisForTests(null); });

// Every route actually registered on the admin router, discovered - not listed by hand.
const routes = adminRouter.stack
  .filter((layer) => layer.route)
  .flatMap((layer) => Object.keys(layer.route.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route.path })));
const concrete = (path) => path.replace(/:[A-Za-z]+/g, "x1");
const PUBLIC_ROUTES = new Set(["POST /auth/request-code", "POST /auth/verify", "POST /auth/logout", "GET /auth/session"]);
const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(`${r.method} ${r.path}`));
const mutating = protectedRoutes.filter((r) => r.method !== "GET");

describe("authentication on every route", () => {
  test("the route inventory is non-trivial (guards against an empty enumeration)", () => {
    assert.ok(routes.length > 40, `found ${routes.length} routes`);
    assert.ok(mutating.length > 20);
  });

  test("no session cookie: every protected route answers 401 and reveals nothing", async () => {
    for (const route of protectedRoutes) {
      const result = await call(route.method, `/api/admin${concrete(route.path)}`, route.method === "GET" ? {} : { body: {} });
      assert.equal(result.status, 401, `${route.method} ${route.path}`);
      assert.deepEqual(result.data, { ok: false, error: "unauthorized" });
    }
  });

  test("a forged, malformed or random session cookie is treated as no session", async () => {
    const forged = [
      `${ADMIN_SESSION_COOKIE}=${"A".repeat(43)}`,
      `${ADMIN_SESSION_COOKIE}=not-a-token`,
      `${ADMIN_SESSION_COOKIE}=`,
      `${ADMIN_SESSION_COOKIE}=${"%00".repeat(10)}`,
      `${ADMIN_SESSION_COOKIE}=424242`,
      "swift_admin=424242; role=admin",
    ];
    for (const cookie of forged) {
      const result = await call("GET", "/api/admin/users", { cookie });
      assert.equal(result.status, 401, cookie);
    }
  });

  test("client-supplied identity or role is ignored", async () => {
    const result = await call("GET", "/api/admin/users", {
      headers: { "x-admin-id": "424242", "x-forwarded-user": "424242", "x-role": "owner", authorization: "Bearer 424242" },
    });
    assert.equal(result.status, 401);
    const withBody = await call("POST", "/api/admin/users/1/block", { body: { actorId: "424242", actorTelegramId: "424242", isAdmin: true, reason: "forged" } });
    assert.equal(withBody.status, 401);
  });

  test("an expired session is rejected and removed", async () => {
    const { token } = await createAdminSession("424242", fakeRedis);
    const key = `${ADMIN_SESSION_PREFIX}${token}`;
    const session = JSON.parse(await fakeRedis.get(key));
    await fakeRedis.set(key, JSON.stringify({ ...session, expiresAt: Date.now() - 1000 }));
    const result = await call("GET", "/api/admin/users", { cookie: `${ADMIN_SESSION_COOKIE}=${token}` });
    assert.equal(result.status, 401);
    assert.equal(await fakeRedis.get(key), null);
  });

  test("a session of an account removed from the allowlist stops working immediately", async () => {
    const { cookie } = await login("424243");
    assert.notEqual((await call("GET", "/api/admin/auth/session", { cookie })).data.authenticated, false);
    process.env.ADMINS = "424242";
    try {
      const result = await call("GET", "/api/admin/users", { cookie });
      assert.equal(result.status, 401);
    } finally {
      process.env.ADMINS = "424242,424243";
    }
  });

  test("session fixation: a pre-set cookie is never adopted, login issues a new token", async () => {
    const planted = `${ADMIN_SESSION_COOKIE}=${"B".repeat(43)}`;
    resetAdminRateLimitsForTests();
    clearLoginRateKeys();
    const { code } = await issueAdminLoginCode("424242", fakeRedis);
    const verify = await call("POST", "/api/admin/auth/verify", { body: { code }, cookie: planted });
    assert.equal(verify.status, 200);
    const issued = (verify.headers.get("set-cookie") || "").split(";")[0];
    assert.notEqual(issued, planted);
    const withPlanted = await call("GET", "/api/admin/users", { cookie: planted });
    assert.equal(withPlanted.status, 401);
  });

  test("login codes are single-use and tied to the issuing account", async () => {
    resetAdminRateLimitsForTests();
    clearLoginRateKeys();
    const { code } = await issueAdminLoginCode("424242", fakeRedis);
    const first = await call("POST", "/api/admin/auth/verify", { body: { code } });
    assert.equal(first.status, 200);
    assert.equal(first.data.actorTelegramId, "424242");
    const replay = await call("POST", "/api/admin/auth/verify", { body: { code } });
    assert.equal(replay.status, 401);
    for (const bad of ["", "short", "x".repeat(32), { $ne: "" }, ["a"], null]) {
      const result = await call("POST", "/api/admin/auth/verify", { body: { code: bad } });
      assert.equal(result.status, 401, JSON.stringify(bad));
    }
  });

  test("the session cookie is HttpOnly, Secure, SameSite and the token never appears in a body", async () => {
    const { setCookie, body } = await login();
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    const token = setCookie.split(";")[0].split("=")[1];
    assert.equal(body.text.includes(token), false);
  });

  test("two admins get separate sessions and CSRF tokens (no cross-admin reuse)", async () => {
    const a = await login("424242");
    const b = await login("424243");
    assert.notEqual(a.cookie, b.cookie);
    assert.notEqual(a.csrf, b.csrf);
    const crossed = await call("POST", "/api/admin/users/1/block", { body: { operationId: "x".repeat(20), reason: "cross admin" }, cookie: a.cookie, csrf: b.csrf });
    assert.equal(crossed.status, 403);
    assert.equal(crossed.data.error, "csrf_token_invalid");
  });

  test("an unavailable session store fails closed (503), never open", async () => {
    const { cookie } = await login();
    setAdminSessionRedisForTests({ async get() { throw new Error("redis down"); }, async set() { throw new Error("redis down"); } });
    try {
      const result = await call("GET", "/api/admin/users", { cookie });
      assert.equal(result.status, 503);
      assert.equal(result.data.error, "session_store_unavailable");
    } finally {
      setAdminSessionRedisForTests(fakeRedis);
    }
  });
});

describe("login endpoint", () => {
  test("it does not reveal which Telegram IDs are admins", async () => {
    const admin = await call("POST", "/api/admin/auth/request-code", { body: { telegramId: "424243" } });
    resetAdminRateLimitsForTests();
    const stranger = await call("POST", "/api/admin/auth/request-code", { body: { telegramId: "999999" } });
    assert.equal(admin.status, 200);
    assert.equal(stranger.status, 200);
    assert.deepEqual(Object.keys(admin.data).sort(), Object.keys(stranger.data).sort());
    // Requesting again immediately (rate-limited for an admin) looks identical too.
    resetAdminRateLimitsForTests();
    const again = await call("POST", "/api/admin/auth/request-code", { body: { telegramId: "424243" } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.data, stranger.data);
  });

  test("brute-force protection: code requests and verifications are rate limited per client", async () => {
    resetAdminRateLimitsForTests();
    const statuses = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await call("POST", "/api/admin/auth/request-code", { body: { telegramId: "999999" } })).status);
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(statuses.slice(5).every((s) => s === 429));
    resetAdminRateLimitsForTests();
    const verifies = [];
    for (let i = 0; i < 13; i += 1) verifies.push((await call("POST", "/api/admin/auth/verify", { body: { code: "y".repeat(32) } })).status);
    assert.ok(verifies.slice(0, 10).every((s) => s === 401));
    assert.ok(verifies.slice(10).every((s) => s === 429));
  });

  test("invalid Telegram IDs are rejected before any lookup", async () => {
    for (const telegramId of ["", "abc", "0", "-1", "1e5", "9".repeat(40), { $ne: 1 }, [1]]) {
      resetAdminRateLimitsForTests();
      const result = await call("POST", "/api/admin/auth/request-code", { body: { telegramId } });
      assert.equal(result.status, 400, JSON.stringify(telegramId));
    }
  });

  test("without any configured admin nobody can obtain a session (fail closed)", async () => {
    const saved = process.env.ADMINS;
    process.env.ADMINS = "";
    try {
      await assert.rejects(() => createAdminSession("424242", fakeRedis), (e) => e.status === 403);
      await assert.rejects(() => issueAdminLoginCode("424242", fakeRedis), (e) => e.status === 403);
      process.env.ADMINS = "not-a-number, -5, 0";
      await assert.rejects(() => createAdminSession("424242", fakeRedis), (e) => e.status === 403);
    } finally {
      process.env.ADMINS = saved;
    }
  });
});

describe("CSRF, origin and mutation limits", () => {
  test("every mutating route rejects a valid session without a CSRF token (403)", async () => {
    const { cookie } = await login();
    for (const route of mutating) {
      resetAdminRateLimitsForTests();
      const result = await call(route.method, `/api/admin${concrete(route.path)}`, { body: {}, cookie });
      assert.equal(result.status, 403, `${route.method} ${route.path}`);
      assert.equal(result.data.error, "csrf_token_invalid");
    }
  });

  test("a wrong or truncated CSRF token is rejected", async () => {
    const { cookie, csrf } = await login();
    for (const bad of ["wrong", csrf.slice(1), `${csrf}x`, csrf.toUpperCase().replace(/[^A-Z]/g, "")]) {
      const result = await call("POST", "/api/admin/users/1/block", { body: {}, cookie, csrf: bad });
      assert.equal(result.status, 403, bad);
    }
  });

  test("a cross-site Origin is refused even with a valid session and CSRF token", async () => {
    const { cookie, csrf } = await login();
    for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null", "not a url"]) {
      const result = await call("POST", "/api/admin/users/1/block", { body: {}, cookie, csrf, headers: { origin } });
      assert.equal(result.status, 403, origin);
      assert.equal(result.data.error, "origin_not_allowed");
    }
    const same = await call("POST", "/api/admin/users/1/block", { body: {}, cookie, csrf, headers: { origin: baseUrl } });
    assert.notEqual(same.status, 403, "same-origin requests continue to normal validation");
  });

  test("mutations are limited per admin regardless of the id in the URL", async () => {
    const { cookie, csrf } = await login();
    let limited = 0;
    for (let i = 0; i < 70; i += 1) {
      const result = await call("POST", `/api/admin/users/${i + 1}/block`, { body: { operationId: "o".repeat(20), reason: "ab" }, cookie, csrf });
      if (result.status === 429) limited += 1;
      else assert.equal(result.status, 400, "rejected by validation before any database access");
    }
    assert.ok(limited >= 9, `expected throttling, saw ${limited}`);
  });
});

describe("input handling, errors and headers", () => {
  test("ids and usernames must match strict patterns; operators and traversal are rejected", () => {
    for (const bad of ["1}", '{"$ne":1}', "../etc/passwd", "1 OR 1=1", "", "0", "٣", "1\n2"]) {
      assert.throws(() => requireTelegramId(bad), (e) => e.code === "invalid_user_id", bad);
    }
    for (const bad of ["a b", "a/b", "../x", "x;y", "$ne", "a".repeat(200)]) {
      assert.throws(() => requireServiceUsername(bad), (e) => e.code === "invalid_service_id", bad);
    }
  });

  test("search input is escaped and operator objects cannot become query operators", () => {
    const hostile = buildUserSearchQuery({ search: { $ne: "x" } });
    assert.equal(JSON.stringify(hostile).includes("$ne"), false);
    const regexy = buildUserSearchQuery({ search: ".*(a+)+$" });
    const pattern = regexy.$or[0].username;
    assert.equal(pattern.test("anything"), false, "metacharacters are literal");
    assert.ok(pattern.test(".*(a+)+$ tail"));
    assert.deepEqual(buildUserSearchQuery({ search: "424242" }), { telegramId: "424242" });
  });

  test("malformed bodies produce structured 400s without stack traces or paths", async () => {
    const { cookie, csrf } = await login();
    const broken = await call("POST", "/api/admin/users/1/block", { raw: "{not json", cookie, csrf });
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.data, { ok: false, error: "invalid_json" });
    const huge = await call("POST", "/api/admin/users/1/block", { raw: JSON.stringify({ reason: "x".repeat(200_000) }), cookie, csrf });
    assert.equal(huge.status, 413);
    for (const result of [broken, huge]) {
      assert.equal(/\bat\s.+\(|node_modules|\.js:\d+|C:\\\\|\/home\//.test(result.text), false);
    }
  });

  test("unknown admin routes return JSON 404, not an HTML page or stack", async () => {
    const result = await call("GET", "/api/admin/definitely-not-a-route");
    assert.ok([401, 404].includes(result.status));
    assert.ok(result.data && result.data.ok === false);
  });

  test("API responses are private: no-store, nosniff, no framework banner", async () => {
    const result = await call("GET", "/api/admin/auth/session");
    assert.match(result.headers.get("cache-control"), /no-store/);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.equal(result.headers.get("x-powered-by"), null);
  });

  test("the admin app shell ships a strict CSP and clickjacking protection", async () => {
    // /admin now redirects to the Next.js panel at /panel (its headers are covered by nextPanelHeaders.test.js);
    // the legacy shell is still on disk and is served, with the same CSP, as /index.html.
    const page = await fetch(`${baseUrl}/index.html`);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy");
    assert.equal(csp, ADMIN_CSP);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp.split(";").find((d) => d.trim().startsWith("script-src")), /unsafe-inline|unsafe-eval|\*/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("cache-control"), /no-store/);
  });

  test("static path traversal cannot read files outside the web root", async () => {
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/.env", "/../server.js", "/admin/..%5c..%5cpackage.json"]) {
      // redirect: "manual" because /admin/... now answers with a redirect to /panel; the attempt is still sent
      // and the response body must still never contain files from outside the web root.
      const result = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      const text = await result.text();
      assert.equal(/"name":\s*"swift-vpn-bot"|WEBHOOK_BASE_URL|express/.test(text), false, path);
    }
  });

  test("the front end has no inline scripts or inline event handlers (CSP-compatible)", () => {
    const html = readFileSync(new URL("../../web/public/index.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../web/public/app.js", import.meta.url), "utf8");
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, "inline <script>");
    assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false);
    assert.equal(/\son(click|change|input|submit|load|error)=["']/i.test(app), false);
    assert.equal(/javascript:/i.test(app + html), false);
  });
});

describe("analytics endpoints and export", () => {
  test("report and CSV export require an admin session", async () => {
    for (const path of ["/api/admin/analytics/report?range=7d", "/api/admin/analytics/export.csv?range=7d", "/api/admin/analytics"]) {
      const result = await call("GET", path);
      assert.equal(result.status, 401, path);
      assert.equal(result.text.includes("kpi"), false);
    }
  });

  test("a cross-site page cannot trigger an export", async () => {
    const { cookie } = await login();
    const result = await call("GET", "/api/admin/analytics/export.csv?range=7d", { cookie, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(result.status, 403);
  });

  test("invalid ranges are rejected with structured 400s before any query", async () => {
    const { cookie } = await login();
    for (const query of ["range=decade", "range=custom&from=2026-02-30&to=2026-03-01", "range=custom&from=a&to=b", "range=custom"]) {
      const result = await call("GET", `/api/admin/analytics/report?${query}`, { cookie });
      assert.equal(result.status, 400, query);
      assert.equal(result.data.ok, false);
    }
  });

  test("the export is rate limited per admin", async () => {
    const { cookie } = await login();
    const statuses = [];
    for (let i = 0; i < 13; i += 1) statuses.push((await call("GET", "/api/admin/analytics/export.csv?range=decade", { cookie })).status);
    assert.ok(statuses.slice(0, 10).every((s) => s === 400));
    assert.ok(statuses.slice(10).every((s) => s === 429));
  });
});
