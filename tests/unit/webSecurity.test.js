/** The origin allow-list and the panel's Content-Security-Policy, as pure functions. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { buildPanelCsp, isTrustedOrigin, normalizeOrigin, readTrustedOrigins } = await import("../../web/webSecurity.js");

const request = (host = "shop.example.com", protocol = "https") => ({ protocol, get: (name) => (name === "host" ? host : undefined) });
const PRODUCTION = { NODE_ENV: "production", WEBHOOK_BASE_URL: "https://shop.example.com" };

describe("normalizeOrigin", () => {
  test("accepts an exact origin and drops only the bare trailing slash", () => {
    assert.equal(normalizeOrigin("https://Admin.Example.com"), "https://admin.example.com");
    assert.equal(normalizeOrigin("https://admin.example.com/"), "https://admin.example.com");
    assert.equal(normalizeOrigin(" https://admin.example.com:8443 "), "https://admin.example.com:8443");
  });

  test("refuses anything that could widen trust instead of repairing it", () => {
    for (const value of ["*", "https://*", "https://*.example.com", "null", "", "   ", "admin.example.com", "ftp://a.example", "file:///etc", "javascript:alert(1)",
      "https://a.example/path", "https://a.example?x=1", "https://a.example#x", "https://user:pass@a.example", null, undefined, 7, {}]) {
      assert.equal(normalizeOrigin(value), null, String(value));
    }
  });
});

describe("readTrustedOrigins", () => {
  test("combines the public origin, the platform domain and the explicit list", () => {
    const { origins, ignored } = readTrustedOrigins({
      ...PRODUCTION,
      RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      ADMIN_ALLOWED_ORIGINS: "https://ops.example.com, https://ops2.example.com/",
    });
    assert.deepEqual([...origins].sort(), ["https://app.up.railway.app", "https://ops.example.com", "https://ops2.example.com", "https://shop.example.com"]);
    assert.equal(ignored, 0);
  });

  test("invalid or wildcard entries are ignored and counted, never trusted", () => {
    const { origins, ignored } = readTrustedOrigins({ ...PRODUCTION, ADMIN_ALLOWED_ORIGINS: "*,https://*.example.com,https://a.example/path,not a url" });
    assert.deepEqual([...origins], ["https://shop.example.com"]);
    assert.equal(ignored, 4);
  });

  test("production refuses plain HTTP except on loopback", () => {
    const { origins, ignored } = readTrustedOrigins({ NODE_ENV: "production", ADMIN_ALLOWED_ORIGINS: "http://ops.example.com,http://127.0.0.1:3000" });
    assert.deepEqual([...origins], ["http://127.0.0.1:3000"]);
    assert.equal(ignored, 1);
  });

  test("a misconfigured base URL trusts nothing rather than failing open", () => {
    const { origins, ignored } = readTrustedOrigins({ NODE_ENV: "production", WEBHOOK_BASE_URL: "not a url" });
    assert.equal(origins.size, 0);
    assert.equal(ignored, 1);
  });
});

describe("isTrustedOrigin", () => {
  test("production trusts configuration only: a spoofed Host header earns nothing", () => {
    assert.equal(isTrustedOrigin(request(), "https://shop.example.com", PRODUCTION), true);
    assert.equal(isTrustedOrigin(request("evil.example"), "https://evil.example", PRODUCTION), false);
    assert.equal(isTrustedOrigin(request("evil.example"), "https://evil.example", { NODE_ENV: "production" }), false);
  });

  test("the scheme is part of the match, and look-alikes do not match", () => {
    for (const origin of ["http://shop.example.com", "https://shop.example.com.evil.example", "https://evil-shop.example.com", "https://SHOP.EXAMPLE.COM", "https://shop.example.com/", "null", ""]) {
      assert.equal(isTrustedOrigin(request(), origin, PRODUCTION), false, origin);
    }
  });

  test("outside production the address in use is trusted, and only that exact origin", () => {
    assert.equal(isTrustedOrigin(request("127.0.0.1:3000", "http"), "http://127.0.0.1:3000", {}), true);
    assert.equal(isTrustedOrigin(request("127.0.0.1:3000", "http"), "https://127.0.0.1:3000", {}), false);
    assert.equal(isTrustedOrigin(request("127.0.0.1:3000", "http"), "http://127.0.0.1:3001", {}), false);
  });
});

describe("panel Content-Security-Policy", () => {
  const directives = (csp) => Object.fromEntries(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

  test("production scripts need this response's nonce or this origin, nothing looser", () => {
    const parsed = directives(buildPanelCsp("abc123"));
    assert.deepEqual(parsed["script-src"], ["'self'", "'nonce-abc123'"]);
    assert.deepEqual(parsed["connect-src"], ["'self'"]);
    assert.deepEqual(parsed["object-src"], ["'none'"]);
    assert.deepEqual(parsed["base-uri"], ["'none'"]);
    assert.deepEqual(parsed["frame-ancestors"], ["'none'"]);
    assert.deepEqual(parsed["default-src"], ["'self'"]);
    assert.equal(buildPanelCsp("abc123").includes("*"), false);
  });

  test("a nonce stays out of style-src, where it would switch 'unsafe-inline' off and break React style attributes", () => {
    assert.deepEqual(directives(buildPanelCsp("abc123"))["style-src"], ["'self'", "'unsafe-inline'"]);
  });

  test("eval and websockets exist only for the dev server", () => {
    const production = buildPanelCsp("abc123");
    assert.doesNotMatch(production, /unsafe-eval|ws:/);
    assert.match(buildPanelCsp("abc123", { dev: true }), /script-src 'self' 'nonce-abc123' 'unsafe-eval'/);
    assert.match(buildPanelCsp("abc123", { dev: true }), /connect-src 'self' ws: wss:/);
  });
});
