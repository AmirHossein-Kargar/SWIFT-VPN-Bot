import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const { applyNextPanelHeaders, nextAdminMiddleware } = await import("../../web/nextAdminMiddleware.js");

function applied(req = {}) {
  const headers = {};
  const request = { secure: false, headers: {}, ...req };
  applyNextPanelHeaders(request, { setHeader: (name, value) => { headers[name.toLowerCase()] = value; } });
  return { headers, request };
}

describe("/panel response headers", () => {
  test("the Next.js admin UI cannot be framed or MIME-sniffed", () => {
    const { headers } = applied();
    assert.equal(headers["x-frame-options"], "DENY");
    assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "same-origin");
    assert.equal(headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(headers["cross-origin-resource-policy"], "same-origin");
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) assert.match(headers["permissions-policy"], new RegExp(`${feature}=\\(\\)`));
  });

  test("scripts are restricted by a per-response nonce, never by 'unsafe-inline'", () => {
    const { headers } = applied();
    const scripts = headers["content-security-policy"].split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src "));
    assert.match(scripts, /'nonce-[A-Za-z0-9+/=]{20,}'/);
    assert.doesNotMatch(scripts, /unsafe-inline/);
  });

  test("each response gets a different nonce", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => applied().request.headers["x-nonce"]));
    assert.equal(nonces.size, 50);
  });

  test("Next receives the nonce on the request, and a client cannot choose it", () => {
    const { headers, request } = applied({ headers: { "x-nonce": "attacker", "content-security-policy": "script-src 'nonce-attacker'" } });
    assert.notEqual(request.headers["x-nonce"], "attacker");
    assert.equal(request.headers["content-security-policy"], headers["content-security-policy"]);
    assert.ok(request.headers["content-security-policy"].includes(`'nonce-${request.headers["x-nonce"]}'`));
    assert.doesNotMatch(request.headers["content-security-policy"], /attacker/);
  });

  test("HSTS is added only for a request that arrived over HTTPS", () => {
    assert.equal(applied().headers["strict-transport-security"], undefined);
    assert.equal(applied({ secure: true }).headers["strict-transport-security"], "max-age=15552000");
  });

  test("every page renders per request, because the root layout reads the nonce and hands it to the theme script", () => {
    const layout = readFileSync(new URL("../../admin-panel/app/layout.tsx", import.meta.url), "utf8");
    assert.match(layout, /headers\(\)\)\.get\("x-nonce"\)/);
    assert.match(layout, /<ThemeProvider nonce=\{nonce\}>/);
    assert.match(readFileSync(new URL("../../admin-panel/components/theme-provider.tsx", import.meta.url), "utf8"), /nonce=\{nonce\}/);
  });

  test("a Next proxy or middleware file would run ahead of this and is not used", () => {
    for (const name of ["middleware.ts", "proxy.ts"]) assert.equal(existsSync(new URL(`../../admin-panel/${name}`, import.meta.url)), false, name);
  });

  test("the middleware applies them before handing the request to Next, and only for /next-panel", () => {
    const set = [];
    let passedThrough = false;
    nextAdminMiddleware({ path: "/api/store/catalog" }, { setHeader: (name) => set.push(name) }, () => { passedThrough = true; });
    assert.equal(passedThrough, true);
    assert.deepEqual(set, [], "unrelated paths get no panel headers from this middleware");
    const source = readFileSync(new URL("../../web/nextAdminMiddleware.js", import.meta.url), "utf8");
    assert.ok(source.indexOf("applyNextPanelHeaders(req, res);") < source.indexOf("getHandler().then"), "headers are set before Next handles the request");
  });
});
