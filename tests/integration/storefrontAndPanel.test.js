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
import http from "node:http";
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
const { STATIC_OPTIONS } = await import("../../web/spa.js");

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

  test("/admin redirects to the Next.js panel at /panel; the legacy shell stays served as /index.html (no-store, noindex)", async () => {
    // /panel itself is the Next.js app now; requesting it here would boot Next (covered by nextPanelHeaders / e2e).
    const moved = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
    assert.equal(moved.status, 307);
    assert.equal(moved.headers.get("location"), "/panel");
    for (const path of ["/index.html"]) {
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

/** Raw request so the path reaches Express exactly as sent (fetch normalizes "//" and "..") */
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function assertNotFramable(headers, label) {
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
  assert.equal(get("x-frame-options"), "DENY", `${label}: X-Frame-Options`);
  assert.match(get("content-security-policy") || "", /frame-ancestors 'none'/, `${label}: CSP frame-ancestors`);
  assert.equal(get("x-content-type-options"), "nosniff", `${label}: nosniff`);
}

describe("HTML security headers (clickjacking and caching)", () => {
  test("the admin sign-in shell is never framable or publicly cached, by any URL", async () => {
    // /panel and /panel/* are the Next.js app since the cutover (its headers are covered by
    // nextPanelHeaders.test.js, and requesting it here would boot Next); /admin now redirects.
    // The legacy shell files stay on disk and remain reachable, with the same protections, as /index.html.
    for (const path of ["/index.html"]) {
      const page = await call("GET", path);
      assert.equal(page.status, 200, path);
      assert.match(page.text, /SWIFT Admin/, path);
      assertNotFramable(page.headers, path);
      assert.equal(page.headers.get("cache-control"), "no-store", `${path}: cache`);
      assert.match(page.headers.get("x-robots-tag") || "", /noindex/, path);
    }
  });

  test("path variants of /index.html cannot bypass the shell headers", async () => {
    for (const path of ["//index.html", "/x/../index.html", "/./index.html", "/INDEX.HTML", "/index.html."]) {
      const page = await rawGet(path);
      if (page.status !== 200) continue; // case/trailing-dot variants only resolve on case-insensitive file systems
      assert.match(page.text, /SWIFT Admin/, path);
      assertNotFramable(page.headers, path);
      assert.equal(page.headers["cache-control"], "no-store", `${path}: cache`);
    }
    const plain = await rawGet("//index.html");
    assert.equal(plain.status, 200, "//index.html resolves (and is protected)");
  });

  test("the storefront is not framable but stays cacheable, whether reached as / or /store.html", async () => {
    for (const path of ["/", "/store.html"]) {
      const page = await call("GET", path);
      assert.equal(page.status, 200, path);
      assert.match(page.text, /<html lang="fa" dir="rtl"/, path);
      assert.match(page.text, /rel="canonical"/, `${path}: canonical injected`);
      assertNotFramable(page.headers, path);
      assert.equal(page.headers.get("cache-control"), "public, max-age=300", path);
    }
  });

  test("the 404 page is not framable whether reached by an unknown path or by file name", async () => {
    for (const path of ["/nope", "/404.html"]) {
      const page = await call("GET", path);
      assert.equal(page.status, 404, path);
      assertNotFramable(page.headers, path);
      assert.equal(page.headers.get("cache-control"), "no-store", path);
    }
  });

  test("public static assets keep their long-lived public cache", async () => {
    for (const path of ["/app.js", "/styles.css", "/store/store.js", "/store/store.css", "/favicon.svg"]) {
      const asset = await call("GET", path);
      assert.equal(asset.status, 200, path);
      assert.equal(asset.headers.get("cache-control"), "public, max-age=3600", path);
    }
  });

  test("the storefront uses the official brand kit and no off-brand blue/purple palette", async () => {
    for (const path of ["/brand/logo-horizontal.svg", "/brand/logo-horizontal-on-dark.svg", "/brand/logo-stacked.svg", "/favicon.ico", "/apple-touch-icon.png", "/og-image.png", "/site.webmanifest"]) {
      assert.equal((await call("GET", path)).status, 200, path);
    }
    const page = await call("GET", "/");
    assert.match(page.text, /src="\/brand\/logo-horizontal\.svg"/);
    assert.match(page.text, /src="\/brand\/logo-horizontal-on-dark\.svg"/);
    assert.match(page.text, /property="og:image" content="\/og-image\.png"/);
    assert.match(page.text, /rel="manifest" href="\/site\.webmanifest"/);
    // Judge the stylesheet(s) the live page really links (hashed when the Next.js build is installed).
    const hrefs = [...page.text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/[^"]+\.css)"/g)].map((match) => match[1]);
    assert.ok(hrefs.length > 0, "the page links a local stylesheet");
    const css = (await Promise.all(hrefs.map((href) => call("GET", href)))).map((response) => response.text).join("\n");
    assert.doesNotMatch(css, /#3B82F6|#2563EB|#1E40AF|#60A5FA|#818CF8|#4F46E5|#1D4ED8/i, "legacy blue/indigo palette");
    assert.match(css, /#10B981|160 84% 39%/i, "brand Mint on dark");
  });

  test("any HTML file served by the static middleware gets the safety-net headers", () => {
    const headers = {};
    const res = { setHeader: (name, value) => { headers[name.toLowerCase()] = value; } };
    STATIC_OPTIONS.setHeaders(res, "/srv/web/public/new-page.html");
    assertNotFramable(headers, "static .html");
    assert.equal(headers["cache-control"], "no-store");
    const assetHeaders = {};
    STATIC_OPTIONS.setHeaders({ setHeader: (name, value) => { assetHeaders[name] = value; } }, "/srv/web/public/app.js");
    assert.deepEqual(assetHeaders, {}, "non-HTML assets are untouched");
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
  test("deep-link payloads resolve only currently sold plans", async () => {
    assert.equal(parseStartPayload("/start plan_s30_10"), "plan_s30_10");
    assert.equal(parseStartPayload("/start@Swift_servicebot plan_s30_10"), "plan_s30_10");
    assert.equal(parseStartPayload("/start"), null);
    assert.equal(parseStartPayload("/start plan_s30_10 extra"), null);
    assert.equal((await planFromStartPayload("plan_s30_10"))?.price, customerPlans.find((p) => p.id === "s30_10").price);
    assert.equal(await planFromStartPayload("plan_test"), null, "legacy plans are not sold through links");
    assert.equal(await planFromStartPayload("plan_../x"), null);
  });

  test("the mock-test button is offered only to admins in private chats", () => {
    const rows = (kb) => kb.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(rows(keyboardFor(ADMIN, "private")).includes(MOCK_TEST_BUTTON));
    assert.ok(!rows(keyboardFor("999", "private")).includes(MOCK_TEST_BUTTON));
    assert.ok(!rows(keyboardFor(ADMIN, "supergroup")).includes(MOCK_TEST_BUTTON));
  });
});

describe("admin session hardening", () => {
  test("the session is issued as two narrowly-scoped cookies (admin API + the Next.js panel), never the whole origin", async () => {
    const { verify } = await signIn();
    const setCookies = verify.headers.getSetCookie();
    // Plus a third Set-Cookie clearing any pre-hardening Path=/ leftover —
    // asserted separately below; here only the two issued session copies matter.
    const issued = setCookies.filter((entry) => /swift_admin_session=(?!;)[^;]+/.test(entry));
    assert.equal(issued.length, 2, "one issued cookie per consumer, not a single Path=/ cookie");
    const apiCookie = setCookies.find((entry) => /Path=\/api\/admin(;|$)/i.test(entry));
    const panelCookie = setCookies.find((entry) => /Path=\/panel(;|$)/i.test(entry));
    assert.ok(apiCookie, "a cookie scoped to /api/admin");
    assert.ok(panelCookie, "a cookie scoped to /panel");
    for (const entry of [apiCookie, panelCookie]) {
      assert.match(entry, /swift_admin_session=[^;]+/);
      assert.match(entry, /HttpOnly/i);
      assert.match(entry, /Secure/i);
      assert.match(entry, /SameSite=Lax/i);
    }
    assert.ok(setCookies.some((entry) => /swift_admin_session=;[^]*Path=\/next-panel(;|$)/i.test(entry)), "login expires the pre-cutover /next-panel cookie");
    // Same underlying session (and therefore the same revocation) either way.
    assert.equal(apiCookie.match(/swift_admin_session=([^;]+)/)[1], panelCookie.match(/swift_admin_session=([^;]+)/)[1]);
  });

  test("a request carrying only the /panel-scoped cookie is still recognized as authenticated", async () => {
    // This is exactly what the Next.js SSR layer does: it forwards whatever
    // cookie header the browser attached to a /panel/* page request to
    // a server-to-server loopback call against /api/admin/auth/session. A
    // browser visiting /panel only ever attaches the /panel cookie
    // (never the /api/admin one), so this is the real-world shape of that
    // forwarded header, not the combined pair a same-path request would see.
    const { verify } = await signIn();
    const panelCookie = verify.headers.getSetCookie().find((entry) => /Path=\/panel(;|$)/i.test(entry));
    const cookie = panelCookie.split(";")[0];
    const session = await call("GET", "/api/admin/auth/session", { cookie });
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.actorTelegramId, ADMIN);
  });

  test("logout clears the session everywhere: both current cookie paths and the pre-hardening legacy path", async () => {
    const { verify, cookie, csrf } = await signIn();
    const panelCookie = verify.headers.getSetCookie().find((entry) => /Path=\/panel(;|$)/i.test(entry)).split(";")[0];

    const logout = await call("POST", "/api/admin/auth/logout", { cookie, csrf });
    const cleared = logout.headers.getSetCookie();
    assert.ok(cleared.some((entry) => /Path=\/api\/admin(;|$)/i.test(entry)), "clears the /api/admin cookie");
    assert.ok(cleared.some((entry) => /Path=\/panel(;|$)/i.test(entry)), "clears the /panel cookie");
    assert.ok(cleared.some((entry) => /Path=\/(;|,|$)/.test(entry)), "clears the legacy root-path cookie");
    assert.ok(cleared.some((entry) => /Path=\/next-panel(;|$)/i.test(entry)), "also expires the retired /next-panel cookie");

    // The underlying session is gone, so neither cookie copy still works.
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie })).data.authenticated, false);
    assert.equal((await call("GET", "/api/admin/auth/session", { cookie: panelCookie })).data.authenticated, false);
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

describe("new admin endpoints: authorization", () => {
  test("individual message: unauthenticated, missing-CSRF and cross-origin requests are refused", async () => {
    const body = { operationId: "a".repeat(24), message: "hello" };
    assert.equal((await call("POST", "/api/admin/users/5001/message", { body })).status, 401);
    const { cookie, csrf } = await signIn();
    assert.equal((await call("POST", "/api/admin/users/5001/message", { cookie, body })).status, 403, "missing CSRF");
    assert.equal((await call("POST", "/api/admin/users/5001/message", { cookie, csrf, origin: "https://evil.example", body })).status, 403, "foreign origin");
    const invalid = await call("POST", "/api/admin/users/5001/message", { cookie, csrf, body: { operationId: "b".repeat(24), message: "" } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, "invalid_message");
  });

  test("settings overview: requires a session and never exposes secret values", async () => {
    assert.equal((await call("GET", "/api/admin/settings/overview")).status, 401);
    const { cookie } = await signIn();
    const result = await call("GET", "/api/admin/settings/overview", { cookie });
    assert.equal(result.status, 200);
    assert.equal(result.data.data.account.telegramId, ADMIN);
    assert.equal(typeof result.data.data.payments.hooshpay.apiKey, "boolean");
    assert.ok(!/BOT_TOKEN|mongodb:\/\/|password/i.test(result.text));
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
