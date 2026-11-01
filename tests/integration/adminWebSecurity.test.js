/**
 * CSRF, CORS and response headers over REAL HTTP against the actual Express app, with an in-memory Redis session store. It
 * needs no MongoDB: protected calls are decided before any database access, and the legitimate workflows stop at validation.
 * /panel is deliberately not requested here (it would start a Next dev server); its headers are unit-tested and exercised
 * in Chrome by tests/e2e/nextPanel.e2e.mjs.
 */
import { test, describe, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242,424243";
process.env.GROUP_ID = "";

const { setAdminSessionRedisForTests, issueAdminLoginCode } = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests, requireAdminSession, requireCsrfToken, requireSameOrigin } = await import("../../web/adminMiddleware.js");
const { default: adminRouter } = await import("../../web/adminRouter.js");
const { ADMIN_PERMISSIONS_POLICY, API_CSP, HSTS_HEADER, apiCors, resetHstsEvidenceForTests } = await import("../../web/webSecurity.js");
const { auditRouteCoverage, inspectAdminSecurity } = await import("../../web/securityPosture.js");

const fakeRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);

const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const TRUSTED = "https://ops.example.com";
const EVIL = "https://evil.example";
const SAVED_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED_NODE_ENV;
  for (const name of ["WEBHOOK_BASE_URL", "ADMIN_ALLOWED_ORIGINS", "RAILWAY_PUBLIC_DOMAIN"]) delete process.env[name];
}

function clearLoginRateKeys() {
  for (const key of [...fakeRedis.map.keys()]) if (key.startsWith("admin:web:login-rate:")) fakeRedis.map.delete(key);
}

async function call(method, path, { body, raw, cookie, csrf, headers: extra = {}, contentType } = {}) {
  const headers = { ...extra };
  if (contentType) headers["content-type"] = contentType;
  else if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: "manual" });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, data, text, headers: response.headers };
}

async function login(telegramId = "424242") {
  resetAdminRateLimitsForTests();
  clearLoginRateKeys();
  const { code } = await issueAdminLoginCode(telegramId, fakeRedis);
  const verify = await call("POST", "/api/admin/auth/verify", { body: { code } });
  assert.equal(verify.status, 200);
  return { cookie: (verify.headers.get("set-cookie") || "").split(";")[0], csrf: verify.data.csrfToken };
}

/** A body that passes CSRF and is refused by validation: a mutation that reached its route without touching a database. */
const BLOCK_PATH = "/api/admin/users/1/block";
const BLOCK_BODY = { operationId: "o".repeat(20), reason: "ab" };

beforeEach(() => { resetAdminRateLimitsForTests(); restoreEnv(); });
afterEach(restoreEnv);
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  setAdminSessionRedisForTests(null);
});

describe("CSRF", () => {
  test("missing, empty, wrong and foreign tokens are refused; the session's own token reaches the route", async () => {
    const { cookie, csrf } = await login();
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie })).data.error, "csrf_token_invalid");
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, headers: { "x-csrf-token": "" } })).status, 403);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf: "nope" })).status, 403);
    const other = await login("424243");
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf: other.csrf })).status, 403);
    resetAdminRateLimitsForTests();
    const accepted = await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf });
    assert.notEqual(accepted.status, 403, "a valid token is not refused");
    assert.equal(accepted.status, 400, "it reached validation");
  });

  test("the token is not sent as a cookie or accepted from a query string or body", async () => {
    const { cookie, csrf } = await login();
    assert.equal((await call("POST", `${BLOCK_PATH}?csrfToken=${csrf}`, { body: { ...BLOCK_BODY, csrfToken: csrf }, cookie })).status, 403);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie: `${cookie}; x-csrf-token=${csrf}` })).status, 403);
  });

  test("a verb that is not known to be safe still needs the token", () => {
    let passed = false;
    const res = { status(code) { res.code = code; return res; }, json() { return res; } };
    requireCsrfToken({ method: "PROPFIND", adminSession: { csrfToken: "t" }, get: () => undefined }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.code, 403);
  });

  test("sign-in issues a fresh token and an earlier session's token stops working", async () => {
    const first = await login();
    const second = await login();
    assert.notEqual(first.csrf, second.csrf);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie: second.cookie, csrf: first.csrf })).status, 403);
  });

  test("a sign-in that presents an existing session ends it", async () => {
    const before = await login();
    resetAdminRateLimitsForTests();
    clearLoginRateKeys();
    const { code } = await issueAdminLoginCode("424242", fakeRedis);
    assert.equal((await call("POST", "/api/admin/auth/verify", { body: { code }, cookie: before.cookie })).status, 200);
    assert.equal((await call("GET", "/api/admin/users", { cookie: before.cookie })).status, 401);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie: before.cookie, csrf: before.csrf })).status, 401);
  });

  test("sign-out of a live session needs its token, so a forged request leaves the session alone", async () => {
    const { cookie, csrf } = await login();
    const forged = await call("POST", "/api/admin/auth/logout", { body: {}, cookie });
    assert.equal(forged.status, 403);
    assert.equal(forged.data.error, "csrf_token_invalid");
    assert.equal(forged.headers.get("set-cookie"), null, "no cookie is cleared");
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie })).data.authenticated, true);

    assert.equal((await call("POST", "/api/admin/auth/logout", { body: {}, cookie, csrf })).status, 200);
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie })).data.authenticated, false);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf })).status, 401, "cookie and token died with the session");
  });

  test("sign-out with an expired or absent session still clears the cookies", async () => {
    const stale = await call("POST", "/api/admin/auth/logout", { body: {}, cookie: `swift_admin_session=${"Z".repeat(43)}` });
    assert.equal(stale.status, 200);
    assert.match(stale.headers.get("set-cookie") || "", /swift_admin_session=;/);
    assert.equal((await call("POST", "/api/admin/auth/logout", { body: {} })).status, 200);
  });

  test("sign-out cannot be forged while the session store is down either, and clearing cookies is all it can do", async () => {
    const { cookie } = await login();
    setAdminSessionRedisForTests({ async get() { throw new Error("redis down"); }, async set() { throw new Error("redis down"); }, async del() { throw new Error("redis down"); } });
    try {
      assert.equal((await call("POST", "/api/admin/auth/logout", { body: {}, cookie, headers: { origin: EVIL } })).status, 403);
      assert.equal((await call("POST", "/api/admin/auth/logout", { body: {}, cookie })).status, 200);
    } finally {
      setAdminSessionRedisForTests(fakeRedis);
    }
  });

  test("a form post is not a valid request, so it cannot avoid a preflight", async () => {
    const { cookie, csrf } = await login();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const result = await call("POST", BLOCK_PATH, { raw: "{}", contentType, cookie, csrf });
      assert.equal(result.status, 415, contentType);
      assert.equal(result.data.error, "unsupported_media_type");
    }
    assert.equal((await call("POST", "/api/admin/auth/verify", { raw: `{"code":"x"}`, contentType: "text/plain" })).status, 415);
    assert.equal((await call("POST", "/api/admin/auth/request-code", { raw: "telegramId=424242", contentType: "application/x-www-form-urlencoded" })).status, 415);
  });

  test("the same rules hold for the customer support API", async () => {
    assert.equal((await call("POST", "/api/support/tickets", { body: {}, headers: { origin: EVIL } })).status, 403);
    assert.equal((await call("POST", "/api/support/auth/verify", { raw: "{}", contentType: "text/plain" })).status, 415);
  });
});

describe("origin enforcement", () => {
  test("an untrusted origin is refused on every method, before the session is even read", async () => {
    const { cookie, csrf } = await login();
    for (const [method, path] of [["GET", "/api/admin/users"], ["GET", "/api/admin/auth/session"], ["POST", BLOCK_PATH], ["DELETE", "/api/admin/products/x1"], ["PATCH", "/api/admin/products/x1"]]) {
      const result = await call(method, path, { body: method === "GET" ? undefined : BLOCK_BODY, cookie, csrf, headers: { origin: EVIL } });
      assert.equal(result.status, 403, `${method} ${path}`);
      assert.equal(result.data.error, "origin_not_allowed");
      assert.equal(result.headers.get("access-control-allow-origin"), null);
    }
  });

  test("the session's CSRF token cannot be read by another origin", async () => {
    const { cookie, csrf } = await login();
    const result = await call("GET", "/api/admin/auth/session", { cookie, headers: { origin: EVIL } });
    assert.equal(result.status, 403);
    assert.equal(result.text.includes(csrf), false);
  });

  test("sign-in is refused from another origin, which rules out login CSRF", async () => {
    for (const path of ["/api/admin/auth/verify", "/api/admin/auth/request-code", "/api/admin/auth/logout"]) {
      assert.equal((await call("POST", path, { body: {}, headers: { origin: EVIL } })).status, 403, path);
    }
  });

  test("a scheme change, an opaque origin and a look-alike suffix are all refused", async () => {
    const { cookie, csrf } = await login();
    const secure = baseUrl.replace("http://", "https://");
    for (const origin of [secure, "null", `${baseUrl}.evil.example`, "not a url"]) {
      const result = await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf, headers: { origin } });
      assert.equal(result.status, 403, origin);
    }
  });

  test("Fetch Metadata stops a cross-site GET that carries no Origin: mark-read and the audited export", async () => {
    const { cookie } = await login();
    for (const path of ["/api/admin/tickets/507f1f77bcf86cd799439011/updates?markRead=1", "/api/admin/analytics/export.csv?range=7d"]) {
      for (const site of ["cross-site", "same-site"]) {
        const result = await call("GET", path, { cookie, headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate" } });
        assert.equal(result.status, 403, `${path} ${site}`);
        assert.equal(result.data.error, "origin_not_allowed");
      }
    }
    const typed = await call("GET", "/api/admin/analytics/report?range=decade", { cookie, headers: { "sec-fetch-site": "none" } });
    assert.equal(typed.status, 400, "a URL typed by the admin is not refused");
    const own = await call("GET", "/api/admin/analytics/report?range=decade", { cookie, headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(own.status, 400, "the panel's own requests are not refused");
  });

  test("production trusts WEBHOOK_BASE_URL, and a forged Host header earns nothing", async () => {
    const { cookie, csrf } = await login();
    process.env.NODE_ENV = "production";
    process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
    const accepted = await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf, headers: { origin: "https://shop.example.com" } });
    assert.equal(accepted.status, 400, "the public origin reaches validation");
    const own = await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf, headers: { origin: baseUrl } });
    assert.equal(own.status, 403, "the Host header is not evidence in production");
    assert.equal(own.data.error, "origin_not_allowed");
  });

  test("production without a trusted origin refuses browsers and still serves non-browser clients their session rules", async () => {
    const { cookie, csrf } = await login();
    process.env.NODE_ENV = "production";
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf, headers: { origin: baseUrl } })).status, 403);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie })).status, 403, "no Origin still needs the token");
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY })).status, 401, "no Origin still needs the session");
  });

  test("the payment webhooks and health checks are outside this policy", async () => {
    const hoosh = await call("POST", "/api/hooshpay/webhook", { body: {}, headers: { origin: EVIL } });
    assert.notEqual(hoosh.data?.error, "origin_not_allowed");
    const nowpayments = await call("POST", "/api/nowpayments/ipn", { body: {}, headers: { origin: EVIL } });
    assert.notEqual(nowpayments.data?.error, "origin_not_allowed");
    assert.equal((await call("GET", "/health", { headers: { origin: EVIL } })).status, 200);
  });
});

describe("CORS", () => {
  const preflight = (origin, method = "POST", requestHeaders = "content-type, x-csrf-token") => call("OPTIONS", BLOCK_PATH, {
    headers: { origin, "access-control-request-method": method, ...(requestHeaders ? { "access-control-request-headers": requestHeaders } : {}) },
  });

  test("a preflight from a configured origin is answered with that exact origin and credentials", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = TRUSTED;
    const result = await preflight(TRUSTED);
    assert.equal(result.status, 204);
    assert.equal(result.headers.get("access-control-allow-origin"), TRUSTED);
    assert.equal(result.headers.get("access-control-allow-credentials"), "true");
    assert.match(result.headers.get("access-control-allow-methods"), /POST/);
    assert.equal(result.headers.get("access-control-allow-headers"), "content-type, x-csrf-token");
    assert.ok(Number(result.headers.get("access-control-max-age")) > 0);
    assert.match(result.headers.get("vary"), /Origin/);
    assert.match(result.headers.get("vary"), /Access-Control-Request-Method/);
  });

  test("a preflight from anywhere else is refused with no CORS header at all", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = TRUSTED;
    for (const origin of [EVIL, "null", "https://ops.example.com.evil.example", "http://ops.example.com"]) {
      const result = await preflight(origin);
      assert.equal(result.status, 403, origin);
      for (const header of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods"]) {
        assert.equal(result.headers.get(header), null, `${origin} ${header}`);
      }
    }
  });

  test("a preflight is validated: an unlisted method or header is refused even for a trusted origin", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = TRUSTED;
    for (const [method, headers] of [["PUT", ""], ["TRACE", ""], ["POST", "x-admin-id"], ["POST", "content-type, authorization"]]) {
      const result = await preflight(TRUSTED, method, headers);
      assert.equal(result.status, 403, `${method} ${headers}`);
      assert.equal(result.data.error, "preflight_not_allowed");
      assert.equal(result.headers.get("access-control-allow-origin"), null);
    }
  });

  test("a wildcard in the configuration never becomes a wildcard answer", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = "*";
    const refused = await preflight(EVIL);
    assert.equal(refused.status, 403);
    process.env.ADMIN_ALLOWED_ORIGINS = `*,${TRUSTED}`;
    const accepted = await preflight(TRUSTED);
    assert.equal(accepted.headers.get("access-control-allow-origin"), TRUSTED);
    assert.notEqual(accepted.headers.get("access-control-allow-origin"), "*");
  });

  test("a credentialed request from a trusted origin is labelled, and a same-origin one needs no CORS header", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = TRUSTED;
    const { cookie } = await login();
    const cross = await call("GET", "/api/admin/auth/session", { cookie, headers: { origin: TRUSTED, "sec-fetch-site": "cross-site" } });
    assert.equal(cross.status, 200);
    assert.equal(cross.headers.get("access-control-allow-origin"), TRUSTED);
    assert.equal(cross.headers.get("access-control-allow-credentials"), "true");
    const same = await call("GET", "/api/admin/auth/session", { cookie });
    assert.equal(same.headers.get("access-control-allow-origin"), null);
    assert.match(same.headers.get("vary"), /Origin/, "caches never mix the two");
  });

  test("CORS is not authentication: a trusted origin still needs a session and a token", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = TRUSTED;
    const origin = { origin: TRUSTED };
    assert.equal((await call("GET", "/api/admin/users", { headers: origin })).status, 401);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, headers: origin })).status, 401);
    const { cookie, csrf } = await login();
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, headers: origin })).status, 403);
    resetAdminRateLimitsForTests();
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf, headers: origin })).status, 400);
  });

  test("an OPTIONS request that is not a preflight gets no permission from this middleware", async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = TRUSTED;
    const result = await call("OPTIONS", BLOCK_PATH, { headers: { origin: TRUSTED } });
    assert.equal(result.headers.get("access-control-allow-methods"), null);
    assert.notEqual(result.status, 204);
  });
});

describe("response headers", () => {
  function assertApiHeaders(result, label) {
    assert.match(result.headers.get("cache-control") || "", /no-store/, label);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff", label);
    assert.equal(result.headers.get("referrer-policy"), "no-referrer", label);
    assert.equal(result.headers.get("x-frame-options"), "DENY", label);
    assert.equal(result.headers.get("content-security-policy"), API_CSP, label);
    assert.equal(result.headers.get("permissions-policy"), ADMIN_PERMISSIONS_POLICY, label);
    assert.equal(result.headers.get("cross-origin-resource-policy"), "same-origin", label);
    assert.equal(result.headers.get("x-powered-by"), null, label);
  }

  test("every kind of API answer carries them, including refusals and parser errors", async () => {
    const { cookie, csrf } = await login();
    assertApiHeaders(await call("GET", "/api/admin/auth/session"), "public");
    assertApiHeaders(await call("GET", "/api/admin/users"), "401");
    assertApiHeaders(await call("POST", BLOCK_PATH, { body: {}, cookie }), "403 csrf");
    assertApiHeaders(await call("POST", BLOCK_PATH, { body: {}, headers: { origin: EVIL } }), "403 origin");
    assertApiHeaders(await call("OPTIONS", BLOCK_PATH, { headers: { origin: EVIL, "access-control-request-method": "POST" } }), "403 preflight");
    assertApiHeaders(await call("POST", BLOCK_PATH, { raw: "{broken", contentType: "application/json", cookie, csrf }), "400 parser");
    assertApiHeaders(await call("POST", BLOCK_PATH, { raw: JSON.stringify({ x: "y".repeat(200_000) }), contentType: "application/json", cookie, csrf }), "413 parser");
    assertApiHeaders(await call("GET", "/api/support/auth/session"), "support");
  });

  test("the legacy dashboard shell has the same page protections and keeps its strict CSP", async () => {
    const page = await call("GET", "/index.html");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("permissions-policy"), ADMIN_PERMISSIONS_POLICY);
    assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'; /);
  });

  test("HSTS is sent on HTTPS only, and never pins plain HTTP", async () => {
    const https = { "x-forwarded-proto": "https" };
    for (const path of ["/api/admin/auth/session", "/api/support/auth/session", "/index.html"]) {
      assert.equal((await call("GET", path, { headers: https })).headers.get("strict-transport-security"), HSTS_HEADER, path);
      assert.equal((await call("GET", path)).headers.get("strict-transport-security"), null, path);
    }
    assert.doesNotMatch(HSTS_HEADER, /includeSubDomains|preload/);
  });

  test("storefront headers are unchanged by the admin policy", async () => {
    const page = await call("GET", "/");
    assert.equal(page.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  });
});

describe("legitimate admin workflows", () => {
  test("sign-in, session read, a mutation and sign-out work from the panel's own origin", async () => {
    process.env.NODE_ENV = "production";
    process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
    const panel = { origin: "https://shop.example.com", "sec-fetch-site": "same-origin" };
    clearLoginRateKeys();
    assert.equal((await call("POST", "/api/admin/auth/request-code", { body: { telegramId: "424242" }, headers: panel })).status, 200);
    clearLoginRateKeys();
    const { code } = await issueAdminLoginCode("424242", fakeRedis);
    const verify = await call("POST", "/api/admin/auth/verify", { body: { code }, headers: panel });
    assert.equal(verify.status, 200);
    const cookie = (verify.headers.get("set-cookie") || "").split(";")[0];
    const csrf = verify.data.csrfToken;

    const session = await call("GET", "/api/admin/auth/session", { cookie, headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.csrfToken, csrf);
    assert.equal((await call("POST", BLOCK_PATH, { body: BLOCK_BODY, cookie, csrf, headers: panel })).status, 400, "reached validation");
    assert.equal((await call("POST", "/api/admin/auth/logout", { body: {}, cookie, csrf, headers: panel })).status, 200);
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie })).data.authenticated, false);
  });

  test("the panel's server-side read (no Origin, no Fetch Metadata) is unaffected", async () => {
    const { cookie } = await login();
    process.env.NODE_ENV = "production";
    process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie })).data.authenticated, true);
  });

  test("a body-less POST keeps working: only a declared non-JSON type is refused", async () => {
    const { cookie, csrf } = await login();
    assert.notEqual((await call("POST", "/api/admin/auth/logout", { cookie, csrf })).status, 415);
  });
});

describe("settings report what was measured, not a constant", () => {
  const stubRoute = (path) => ({ route: { path, methods: { post: true }, stack: [] } });

  test("the route reports a verified posture for the mounted router", async () => {
    process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
    process.env.NODE_ENV = "production";
    resetHstsEvidenceForTests();
    const { cookie } = await login();
    const result = await call("GET", "/api/admin/settings/overview", { cookie });
    assert.equal(result.status, 200);
    const { protection } = result.data.data.security;
    assert.equal(protection.csrf.status, "verified");
    assert.equal(protection.csrf.unprotectedRoutes.length, 0);
    assert.ok(protection.csrf.tokenRequiredRoutes > 40, `saw ${protection.csrf.tokenRequiredRoutes}`);
    assert.equal(protection.csrf.sessionBoundRoutes, 1, "sign-out");
    assert.equal(protection.csrf.preSessionRoutes, 2, "sign-in");
    assert.equal(protection.csrf.stateChangingRoutes, protection.csrf.tokenRequiredRoutes + 3);
    assert.equal(protection.origin.status, "verified");
    assert.equal(protection.origin.trustedOrigins, 1);
    assert.equal(protection.cors.status, "verified");
    assert.equal(protection.headers.status, "verified");
    assert.equal(result.text.includes("shop.example.com"), false, "origins are counted, never returned");
  });

  test("HSTS reads as unconfirmed until HTTPS traffic has really produced it", async () => {
    process.env.NODE_ENV = "production";
    resetHstsEvidenceForTests();
    assert.deepEqual(inspectAdminSecurity(adminRouter).hsts, { status: "attention", lastSentAt: null });
    await call("GET", "/api/admin/auth/session", { headers: { "x-forwarded-proto": "https" } });
    const { hsts } = inspectAdminSecurity(adminRouter);
    assert.equal(hsts.status, "verified");
    assert.ok(hsts.lastSentAt);
    process.env.NODE_ENV = "test";
    resetHstsEvidenceForTests();
    assert.equal(inspectAdminSecurity(adminRouter).hsts.status, "not_applicable");
  });

  test("a route added ahead of the guards is reported by name and fails the check", () => {
    const stack = [stubRoute("/added-too-early"), { handle: requireAdminSession }, { handle: requireCsrfToken }, stubRoute("/guarded")];
    const posture = inspectAdminSecurity({ stack });
    assert.equal(posture.csrf.status, "failed");
    assert.deepEqual(posture.csrf.unprotectedRoutes, ["POST /added-too-early"]);
    assert.equal(posture.csrf.tokenRequiredRoutes, 1);
  });

  test("a router with a guard removed fails, even if its routes look ordinary", () => {
    const withoutCsrf = inspectAdminSecurity({ stack: [{ handle: requireAdminSession }, stubRoute("/guarded")] });
    assert.equal(withoutCsrf.csrf.status, "failed");
    assert.deepEqual(withoutCsrf.csrf.unprotectedRoutes, ["POST /guarded"]);
    assert.equal(inspectAdminSecurity(null).csrf.status, "failed", "no router means nothing was proved");
  });

  test("routes in a router mounted below the guards count as covered, and above them as exposed", () => {
    const child = { handle: { stack: [stubRoute("/child")] } };
    assert.deepEqual(auditRouteCoverage({ stack: [{ handle: requireAdminSession }, { handle: requireCsrfToken }, child] }).unprotectedRoutes, []);
    assert.deepEqual(auditRouteCoverage({ stack: [child, { handle: requireAdminSession }, { handle: requireCsrfToken }] }).unprotectedRoutes, ["POST /child"]);
  });

  test("a CSRF check that lets requests through is caught by running it, not by trusting its name", () => {
    const posture = inspectAdminSecurity(adminRouter, { csrfMiddleware: (_req, _res, next) => next() });
    assert.equal(posture.csrf.status, "failed");
  });

  test("an origin check or CORS middleware that stopped refusing is caught", () => {
    assert.equal(inspectAdminSecurity(adminRouter, { originMiddleware: (_req, _res, next) => next() }).origin.status, "failed");
    const permissive = (_req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); };
    assert.equal(inspectAdminSecurity(adminRouter, { corsMiddleware: permissive }).cors.status, "failed");
  });

  test("a check that throws is a failed check, not a page error", () => {
    const boom = () => { throw new Error("broken"); };
    const posture = inspectAdminSecurity(adminRouter, { csrfMiddleware: boom, originMiddleware: boom, corsMiddleware: boom });
    assert.deepEqual([posture.csrf.status, posture.origin.status, posture.cors.status], ["failed", "failed", "failed"]);
  });

  test("production with nothing trusted reads as needing attention, and development says so", () => {
    process.env.NODE_ENV = "production";
    assert.equal(inspectAdminSecurity(adminRouter).origin.status, "attention");
    process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
    process.env.ADMIN_ALLOWED_ORIGINS = "*";
    const ignored = inspectAdminSecurity(adminRouter).origin;
    assert.equal(ignored.status, "attention");
    assert.equal(ignored.ignoredEntries, 1);
    process.env.NODE_ENV = "test";
    delete process.env.ADMIN_ALLOWED_ORIGINS;
    assert.equal(inspectAdminSecurity(adminRouter).origin.mode, "request-host");
  });

  test("the guards in use are the ones this file exercises", () => {
    assert.ok(adminRouter.stack.some((layer) => layer.handle === apiCors));
    assert.ok(adminRouter.stack.some((layer) => layer.handle === requireSameOrigin));
  });
});
