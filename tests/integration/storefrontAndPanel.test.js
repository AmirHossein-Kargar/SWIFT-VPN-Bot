/**
 * Storefront + admin entry points over REAL HTTP (no MongoDB needed):
 *   - "/" is the public storefront, "/panel" and "/admin" the admin app
 *   - the public catalog API exposes only customer-safe plan fields
 *   - mock-test API is session + CSRF protected and server-gated
 *   - login rotates sessions and scopes the cookie to the admin API
 *   - Telegram deep links and the admin-only reply keyboard
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.BOT_USERNAME = "Swift_servicebot";
process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
delete process.env.MOCK_TESTS_ENABLED;
// Without MongoDB, fail fast instead of buffering queries for 10 seconds.
mongoose.set("bufferCommands", false);

const auth = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const { customerPlans } = await import("../../services/plans.js");
const { parseStartPayload, planFromStartPayload } = await import("../../handlers/message/handleStartPayload.js");
const { keyboardFor, MOCK_TEST_BUTTON } = await import("../../keyboards/mainKeyboard.js");
const { resetMockRunnerForTests } = await import("../../services/mockTests/runner.js");

const fakeRedis = makeFakeRedis();
auth.setAdminSessionRedisForTests(fakeRedis);
const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const ADMIN = "424242";

async function call(method, path, { body, cookie, csrf, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (origin) headers.origin = origin;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, data, text, headers: response.headers };
}

async function signIn(existingCookie) {
  resetAdminRateLimitsForTests();
  // The per-ID issue limit (45 s) is covered elsewhere; reset it between sign-ins.
  await fakeRedis.del(`admin:web:login-rate:${ADMIN}`);
  const { code } = await auth.issueAdminLoginCode(ADMIN, fakeRedis);
  const verify = await call("POST", "/api/admin/auth/verify", { body: { code }, cookie: existingCookie });
  assert.equal(verify.status, 200);
  return { verify, cookie: (verify.headers.get("set-cookie") || "").split(";")[0], csrf: verify.data.csrfToken };
}

before(() => resetAdminRateLimitsForTests());
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  auth.setAdminSessionRedisForTests(null);
});

describe("routing", () => {
  test("/ serves the storefront with a strict CSP and canonical URL", async () => {
    const page = await call("GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /<html lang="fa" dir="rtl"/);
    assert.match(page.text, /<link rel="canonical" href="https:\/\/shop\.example\.com\/"/);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'(;|$)/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.ok(!page.text.includes("SWIFT Admin"), "the admin shell is not served at /");
  });

  test("/panel and /admin serve the admin app (no-store, noindex)", async () => {
    for (const path of ["/panel", "/panel/", "/admin"]) {
      const page = await call("GET", path);
      assert.equal(page.status, 200, path);
      assert.match(page.text, /SWIFT Admin/);
      assert.match(page.headers.get("cache-control"), /no-store/);
      assert.match(page.headers.get("x-robots-tag"), /noindex/);
    }
  });

  test("unknown paths are a 404 page, not the admin shell", async () => {
    const page = await call("GET", "/definitely-not-here");
    assert.equal(page.status, 404);
    assert.ok(!page.text.includes("SWIFT Admin"));
  });

  test("webhook and health routes are untouched", async () => {
    assert.equal((await call("GET", "/health")).status, 200);
    const webhook = await call("POST", "/api/hooshpay/webhook", { body: { invoice: "x", status: "paid" } });
    assert.notEqual(webhook.status, 404, "HooshPay webhook route still mounted");
    const ipn = await call("POST", "/api/nowpayments/ipn", { body: {} });
    assert.notEqual(ipn.status, 404, "NOWPayments IPN route still mounted");
  });
});

describe("public store API", () => {
  test("catalog mirrors the server-side customer plans and leaks no internal fields", async () => {
    const result = await call("GET", "/api/store/catalog");
    assert.equal(result.status, 200);
    const { plans, durations, checkout, currency } = result.data.data;
    assert.equal(currency.unit, "toman");
    assert.equal(plans.length, customerPlans.length);
    for (const plan of plans) {
      const source = customerPlans.find((entry) => entry.id === plan.id);
      assert.ok(source, plan.id);
      assert.equal(plan.price, source.price, "stored Toman price, unconverted");
      assert.equal(plan.gig, source.gig);
      assert.equal(plan.days, source.days);
    }
    assert.ok(!/purchaseCost|profit|apiKey|secret/i.test(result.text));
    assert.deepEqual(durations.map((d) => d.days), [30, 90, 180, 365]);
    assert.equal(checkout.botUrl, "https://t.me/Swift_servicebot");
  });

  test("plan validation returns a server-built Telegram checkout link", async () => {
    const plan = customerPlans[0];
    const ok = await call("GET", `/api/store/plans/${plan.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.data.plan.price, plan.price);
    assert.equal(ok.data.data.checkout.url, `https://t.me/Swift_servicebot?start=plan_${plan.id}`);
    for (const bad of ["test", "s30_999", "..%2f..", "S30_10"]) {
      assert.equal((await call("GET", `/api/store/plans/${bad}`)).status, 404, bad);
    }
  });

  test("the store API is read-only", async () => {
    assert.equal((await call("POST", "/api/store/catalog", { body: { price: 1 } })).status, 405);
  });
});

describe("Telegram integration", () => {
  test("deep-link payloads resolve only currently sold plans", () => {
    assert.equal(parseStartPayload("/start plan_s30_10"), "plan_s30_10");
    assert.equal(parseStartPayload("/start@Swift_servicebot plan_s30_10"), "plan_s30_10");
    assert.equal(parseStartPayload("/start"), null);
    assert.equal(parseStartPayload("/start plan_s30_10 extra"), null);
    assert.equal(planFromStartPayload("plan_s30_10")?.price, customerPlans.find((p) => p.id === "s30_10").price);
    assert.equal(planFromStartPayload("plan_test"), null, "legacy plans are not sold through links");
    assert.equal(planFromStartPayload("plan_../x"), null);
  });

  test("the mock-test button is offered only to admins in private chats", () => {
    const rows = (kb) => kb.reply_markup.keyboard.flat();
    assert.ok(rows(keyboardFor(ADMIN, "private")).includes(MOCK_TEST_BUTTON));
    assert.ok(!rows(keyboardFor("999", "private")).includes(MOCK_TEST_BUTTON));
    assert.ok(!rows(keyboardFor(ADMIN, "supergroup")).includes(MOCK_TEST_BUTTON));
  });
});

describe("admin session hardening", () => {
  test("the session cookie is scoped to the admin API and logout clears both paths", async () => {
    const { verify, cookie, csrf } = await signIn();
    const setCookie = verify.headers.get("set-cookie");
    assert.match(setCookie, /swift_admin_session=[^;]+;[^,]*Path=\/api\/admin/i);
    assert.match(setCookie, /HttpOnly/i);
    const logout = await call("POST", "/api/admin/auth/logout", { cookie, csrf });
    const cleared = logout.headers.get("set-cookie") || "";
    assert.match(cleared, /Path=\/api\/admin/);
    assert.match(cleared, /Path=\/(;|,|$)/);
  });

  test("signing in rotates the session: a pre-existing session token is invalidated", async () => {
    const first = await signIn();
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie: first.cookie })).data.authenticated, true);
    const second = await signIn(first.cookie);
    assert.notEqual(second.cookie, first.cookie);
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie: first.cookie })).data.authenticated, false);
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie: second.cookie })).data.authenticated, true);
  });

  test("a stale broader-path cookie cannot shadow the current session", async () => {
    const current = await signIn();
    const combined = `${current.cookie}; swift_admin_session=${"x".repeat(43)}`;
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie: combined })).data.authenticated, true);
  });
});

describe("mock-test API", () => {
  test("requires an admin session and CSRF; cross-origin posts are refused", async () => {
    assert.equal((await call("GET", "/api/admin/mock-tests")).status, 401);
    const { cookie, csrf } = await signIn();
    assert.equal((await call("POST", "/api/admin/mock-tests/run", { cookie, body: {} })).status, 403, "missing CSRF");
    assert.equal((await call("POST", "/api/admin/mock-tests/run", { cookie, csrf, origin: "https://evil.example", body: {} })).status, 403, "foreign origin");
  });

  test("runs are refused unless the server enables them, regardless of request fields", async () => {
    resetMockRunnerForTests();
    const { cookie, csrf } = await signIn();
    const listed = await call("GET", "/api/admin/mock-tests", { cookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.data.enabled, false);
    const run = await call("POST", "/api/admin/mock-tests/run", { cookie, csrf, body: { scenarios: "all", enabled: true, MOCK_TESTS_ENABLED: "true", mock: true } });
    assert.equal(run.status, 200);
    assert.equal(run.data.data.enabled, false);
    assert.ok(run.data.data.scenarios.every((scenario) => scenario.status === "NOT RUN"));
    const bad = await call("POST", "/api/admin/mock-tests/run", { cookie, csrf, body: { scenarios: ["purchase", "$where"] } });
    assert.equal(bad.status, 400);
    assert.equal((await call("GET", "/api/admin/mock-tests/not-a-run-id", { cookie })).status, 400);
  });
});
