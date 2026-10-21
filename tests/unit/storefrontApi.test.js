/**
 * storefront/lib/api.ts — the only network code the public page has. It talks
 * to the public, read-only /api/store endpoints and must never send
 * credentials; retries must bypass the browser's 60 s HTTP cache.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const { getStoreJson, StoreApiError } = await import("../../storefront/lib/api.ts");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return calls;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("getStoreJson", () => {
  test("sends a credential-less, cacheable GET by default and unwraps `data`", async () => {
    const calls = stubFetch(() => json(200, { ok: true, data: { plans: [] } }));
    assert.deepEqual(await getStoreJson("/api/store/catalog"), { plans: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/store/catalog");
    assert.equal(calls[0].init.credentials, "omit", "the public API never receives cookies");
    assert.equal(calls[0].init.cache, "default", "the first load consumes the preload / HTTP cache");
    assert.equal(calls[0].init.headers.accept, "application/json");
    assert.equal(calls[0].init.method, undefined, "GET only");
  });

  test("`fresh` bypasses the HTTP cache (retries and the post-404 background refresh)", async () => {
    const calls = stubFetch(() => json(200, { ok: true, data: 1 }));
    await getStoreJson("/api/store/catalog", undefined, { fresh: true });
    assert.equal(calls[0].init.cache, "reload");
    assert.equal(calls[0].init.credentials, "omit");
  });

  test("HTTP errors carry the status so the dialog can tell 'retired plan' (404) from 'try again'", async () => {
    stubFetch(() => json(404, { ok: false, error: "plan_not_available" }));
    await assert.rejects(() => getStoreJson("/api/store/plans/x"), (error) => error instanceof StoreApiError && error.status === 404 && error.message === "plan_not_available");
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await assert.rejects(() => getStoreJson("/api/store/catalog"), (error) => error instanceof StoreApiError && error.status === 502 && error.message === "request_failed");
  });

  test("a 200 that is not the documented envelope is an error, never data", async () => {
    for (const body of [{ ok: false, error: "x" }, { data: { a: 1 } }, null, "plain"]) {
      stubFetch(() => json(200, body));
      await assert.rejects(() => getStoreJson("/api/store/catalog"), StoreApiError, JSON.stringify(body));
    }
  });

  test("an aborted caller signal rejects the request", async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const controller = new AbortController();
    const pending = getStoreJson("/api/store/catalog", controller.signal);
    controller.abort();
    await assert.rejects(() => pending, (error) => error.name === "AbortError");
  });

  test("network failures propagate (no status), which the UI treats as retryable", async () => {
    stubFetch(() => { throw new TypeError("Failed to fetch"); });
    await assert.rejects(() => getStoreJson("/api/store/catalog"), (error) => !(error instanceof StoreApiError) && error.name === "TypeError");
  });
});
