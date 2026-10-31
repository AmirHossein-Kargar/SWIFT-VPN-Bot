/**
 * The Sentinel API over REAL HTTP against the real Express app and real session, CSRF and origin middleware. Every case
 * here is decided before any database access, so it needs no MongoDB. tests/integration/adminSecurity.test.js also
 * enumerates these routes with all the others for session and CSRF; this file covers what is particular to them.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";

const { setAdminSessionRedisForTests, createAdminSession, ADMIN_SESSION_COOKIE } = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const fakeRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);
const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const base = `http://127.0.0.1:${server.address().port}`;

let admin;
async function call(method, path, { body, session = admin, headers = {}, csrf = session?.session?.csrfToken } = {}) {
  const sent = { ...headers };
  if (body !== undefined) sent["content-type"] = "application/json";
  if (session) sent.cookie = `${ADMIN_SESSION_COOKIE}=${session.token}`;
  if (session && csrf && method !== "GET") sent["x-csrf-token"] = csrf;
  const response = await fetch(`${base}/api/admin${path}`, { method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
}

const OP = "op_sentinel_test_0000000001";
const FINDING = "0123456789abcdef01234567";

before(async () => { admin = await createAdminSession("424242"); });
beforeEach(() => resetAdminRateLimitsForTests());
after(async () => { await new Promise((resolve) => server.close(resolve)); setAdminSessionRedisForTests(null); });

const READS = ["/sentinel/overview", "/sentinel/sync", "/sentinel/flow", "/sentinel/live", "/sentinel/transactions", `/sentinel/transactions/${encodeURIComponent("hooshpay:x")}`, "/sentinel/findings", `/sentinel/findings/${FINDING}`];

describe("access", () => {
  for (const path of READS) {
    test(`GET ${path} needs a session`, async () => {
      const result = await call("GET", path, { session: null });
      assert.equal(result.status, 401);
    });
  }

  test("a session whose admin was removed is refused", async () => {
    const former = await createAdminSession("424242");
    const previous = process.env.ADMINS;
    process.env.ADMINS = "999999";
    try {
      const result = await call("GET", "/sentinel/findings", { session: former });
      assert.ok([401, 403].includes(result.status), String(result.status));
    } finally {
      process.env.ADMINS = previous;
    }
  });

  test("responses are never cached", async () => {
    const result = await call("GET", "/sentinel/overview?range=nonsense");
    assert.equal(result.headers.get("cache-control"), "no-store");
  });

  for (const path of [`/sentinel/findings/${FINDING}/review`, "/sentinel/reconcile"]) {
    test(`POST ${path} needs a session, a CSRF token and the same origin`, async () => {
      assert.equal((await call("POST", path, { session: null, body: { operationId: OP } })).status, 401);
      assert.equal((await call("POST", path, { csrf: "wrong", body: { operationId: OP } })).status, 403);
      const crossSite = await call("POST", path, { body: { operationId: OP }, headers: { origin: "https://evil.example" } });
      assert.equal(crossSite.status, 403);
      assert.equal(crossSite.data.error, "origin_not_allowed");
    });

    test(`POST ${path} needs an operation id`, async () => {
      const result = await call("POST", path, { body: {} });
      assert.equal(result.status, 400);
      assert.equal(result.data.error, "invalid_operation_id");
    });
  }

  test("the manual check is rate limited", async () => {
    let last;
    for (let index = 0; index < 8; index += 1) last = await call("POST", "/sentinel/reconcile", { body: {} });
    assert.equal(last.status, 429);
  });
});

describe("input never reaches a query unchecked", () => {
  const INVALID = [
    ["/sentinel/overview?range=forever", "invalid_range"],
    ["/sentinel/overview?range=7d&range=30d", "invalid_range"],
    ["/sentinel/flow?provider=mongo", "invalid_provider"],
    ["/sentinel/live?since=yesterday", "invalid_since"],
    ["/sentinel/live?stage=everything", "invalid_stage"],
    ["/sentinel/live?minAmount=-1", "invalid_min_amount"],
    ["/sentinel/live?minAmount=1.5", "invalid_min_amount"],
    ["/sentinel/live?minAmount=10&maxAmount=5", "invalid_amount_range"],
    ["/sentinel/transactions?before=notanid", "invalid_cursor"],
    ["/sentinel/transactions?reference=a%20b", "invalid_reference"],
    ["/sentinel/transactions?state=whatever", "invalid_state"],
    ["/sentinel/transactions?payCurrency=TRX$", "invalid_pay_currency"],
    ["/sentinel/transactions?severity=apocalyptic", "invalid_severity"],
    ["/sentinel/transactions?userId=abc", "invalid_user_id"],
    ["/sentinel/findings?classification=fraud", "invalid_classification"],
    ["/sentinel/findings?code=NOT_A_CODE", "invalid_code"],
    ["/sentinel/findings?state=deleted", "invalid_state"],
    ["/sentinel/findings/notanobjectid", "invalid_finding_id"],
    [`/sentinel/transactions/${encodeURIComponent("evil:x")}`, "invalid_transaction_key"],
    [`/sentinel/transactions/${encodeURIComponent("hooshpay:$ne")}`, "invalid_transaction_key"],
  ];
  for (const [path, code] of INVALID) {
    test(`${decodeURIComponent(path)} is refused`, async () => {
      const result = await call("GET", path);
      assert.equal(result.status, 400);
      assert.equal(result.data.error, code);
    });
  }

  test("an object where a value belongs is refused, whichever query parser produced it", async () => {
    const { listSentinelFindings, listSentinelTransactions, getSentinelLive } = await import("../../services/admin/sentinel.js");
    const actorId = "424242";
    await assert.rejects(listSentinelFindings({ actorId, query: { userId: { $ne: "1" } } }), (error) => error.status === 400);
    await assert.rejects(listSentinelFindings({ actorId, query: { severity: { $gt: "" } } }), (error) => error.status === 400);
    await assert.rejects(listSentinelTransactions({ actorId, query: { reference: { $regex: ".*" } } }), (error) => error.status === 400);
    await assert.rejects(getSentinelLive({ actorId, query: { minAmount: ["1", "2"] } }), (error) => error.status === 400);
  });

  test("a review cannot be sent to the new state, or with a short reason, and a body cannot add fields", async () => {
    const path = `/sentinel/findings/${FINDING}/review`;
    assert.equal((await call("POST", path, { body: { operationId: OP, review: "new", reason: "Long enough reason" } })).data.error, "invalid_review");
    assert.equal((await call("POST", path, { body: { operationId: OP, review: { $ne: 1 }, reason: "Long enough reason" } })).data.error, "invalid_review");
    assert.equal((await call("POST", path, { body: { operationId: OP, review: "resolved", reason: "short" } })).status, 400);
  });

  test("an unknown id leaks nothing about why", async () => {
    const result = await call("GET", "/sentinel/findings/zz");
    assert.equal(result.data.message, "Finding not found.");
  });
});
