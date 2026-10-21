import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { applyNextPanelHeaders, nextAdminMiddleware } = await import("../../web/nextAdminMiddleware.js");

describe("/panel-next response headers", () => {
  test("the Next.js admin UI cannot be framed or MIME-sniffed", () => {
    const headers = {};
    applyNextPanelHeaders({ setHeader: (name, value) => { headers[name.toLowerCase()] = value; } });
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["content-security-policy"], "frame-ancestors 'none'");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "same-origin");
  });

  test("the policy never restricts scripts (Next.js and next-themes need inline bootstrap scripts)", () => {
    const headers = {};
    applyNextPanelHeaders({ setHeader: (name, value) => { headers[name.toLowerCase()] = value; } });
    assert.doesNotMatch(headers["content-security-policy"], /script-src|default-src/);
  });

  test("the middleware applies them before handing the request to Next, and only for /panel-next", () => {
    const set = [];
    let passedThrough = false;
    nextAdminMiddleware({ path: "/api/store/catalog" }, { setHeader: (name) => set.push(name) }, () => { passedThrough = true; });
    assert.equal(passedThrough, true);
    assert.deepEqual(set, [], "unrelated paths get no panel headers from this middleware");
    const source = readFileSync(new URL("../../web/nextAdminMiddleware.js", import.meta.url), "utf8");
    assert.ok(source.indexOf("applyNextPanelHeaders(res);") < source.indexOf("getHandler().then"), "headers are set before Next handles the request");
  });
});
