import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

process.env.ADMINS = "9001";
const mw = await import("../../web/nextAdminMiddleware.js");
const cookies = await import("../../web/adminMiddleware.js");
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("canonical /panel routing", () => {
  test("the panel lives at /panel and its cookie paths are narrow", () => {
    assert.equal(mw.ADMIN_PANEL_NEXT_BASE_PATH, "/panel");
    assert.equal(cookies.NEXT_PANEL_SESSION_COOKIE_PATH, "/panel");
    assert.equal(cookies.SESSION_COOKIE_PATH, "/api/admin");
    assert.equal(cookies.RETIRED_PANEL_COOKIE_PATH, "/next-panel");
    for (const path of [cookies.NEXT_PANEL_SESSION_COOKIE_PATH, cookies.SESSION_COOKIE_PATH]) assert.notEqual(path, "/");
  });

  test("earlier panel names map to /panel, keep their sub-path, and can never become off-site redirects", () => {
    const target = mw.previousPanelRedirectTarget;
    assert.equal(target("/next-panel"), "/panel");
    assert.equal(target("/panel-next"), "/panel");
    assert.equal(target("/next-panel/payments"), "/panel/payments");
    assert.equal(target("/panel-next/support/login"), "/panel/support/login");
    assert.equal(target("/next-panel//example.org"), "/panel/example.org");
    assert.equal(target("/next-panel///evil.example/x"), "/panel/evil.example/x");
    for (const other of ["/panel", "/panel/x", "/next-panelx", "/panel-nextx", "/x/next-panel", "/api/admin/next-panel", "/"]) assert.equal(target(other), null, other);
  });

  test("/admin pages redirect to /panel; the API, lookalikes and other routes do not", () => {
    const target = mw.legacyAdminRedirectTarget;
    for (const path of ["/admin", "/admin/", "/admin/users"]) assert.equal(target(path), "/panel", path);
    for (const path of ["/api/admin/users", "/api/admin", "/administrator", "/admins", "/panel", "/store", "/api/store/catalog", "/api/support/tickets", "/health", "/"]) assert.equal(target(path), null, path);
  });

  test("the middleware leaves every non-panel route alone (storefront, APIs, health) and sets no headers for them", () => {
    for (const path of ["/", "/store", "/store/store.js", "/api/admin/auth/session", "/api/support/tickets", "/api/store/catalog", "/health", "/ready", "/panelx", "/panel-x", "/pane", "/administrator", "/index.html"]) {
      const headers = [];
      let passed = false;
      mw.nextAdminMiddleware({ path, url: path }, { setHeader: (name) => headers.push(name), redirect() { throw new Error(`unexpected redirect for ${path}`); } }, () => { passed = true; });
      assert.equal(passed, true, `${path} passes through`);
      assert.deepEqual(headers, [], path);
    }
  });

  test("redirects are issued with the right status codes and never reach Next", () => {
    const seen = [];
    const res = { setHeader() { throw new Error("headers are only for the panel itself"); }, redirect: (status, location) => seen.push([status, location]) };
    mw.nextAdminMiddleware({ path: "/next-panel/payments", url: "/next-panel/payments?status=failed" }, res, () => assert.fail("must not pass through"));
    mw.nextAdminMiddleware({ path: "/admin", url: "/admin?x=1" }, res, () => assert.fail("must not pass through"));
    assert.deepEqual(seen, [[308, "/panel/payments?status=failed"], [307, "/panel"]]);
  });
});

describe("no stale references to the old path in code that builds links or paths", () => {
  test("the Next config and base-path helper agree on /panel", () => {
    assert.match(read("admin-panel/next.config.mjs"), /basePath: "\/panel"/);
    assert.match(read("admin-panel/lib/basePath.ts"), /BASE_PATH = "\/panel"/);
  });

  test("the bot's customer-support login link points at /panel/support/login", () => {
    const source = read("handlers/support/supportFlow.js");
    assert.match(source, /\$\{base\}\/panel\/support\/login#code=/);
    assert.doesNotMatch(source, /next-panel/);
  });

  test("the admin app source never hard-codes the old prefix", () => {
    for (const file of ["admin-panel/lib/basePath.ts", "admin-panel/components/layout/sidebar.tsx", "admin-panel/components/layout/topbar.tsx", "admin-panel/components/auth/sign-in-form.tsx"]) {
      assert.doesNotMatch(read(file), /next-panel|panel-next/, file);
    }
  });

  test("the legacy dashboard files are still on disk (the cutover is reversible)", () => {
    for (const file of ["web/public/index.html", "web/public/app.js", "web/public/styles.css", "web/spa.js"]) {
      assert.equal(existsSync(new URL(`../../${file}`, import.meta.url)), true, file);
    }
  });
});
