/**
 * The release-creation-lock admin API over REAL HTTP and a REAL MongoDB: session enforcement, CSRF, audit identity,
 * duplicate submission, mandatory reason, safe error messages and that nothing is credited. No provider is contacted:
 * the environment has no NOWPayments JWT credentials, so the server cannot look the order up and must demand the
 * explicit attestation. Needs the guarded test database (tests/helpers/db.js); skips otherwise.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
for (const name of ["NOWPAYMENTS_EMAIL", "NOWPAYMENTS_PASSWORD"]) delete process.env[name];

const { setAdminSessionRedisForTests, issueAdminLoginCode } = await import("../../services/admin/auth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const fakeRedis = makeFakeRedis();
setAdminSessionRedisForTests(fakeRedis);

const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

let User, Now, AuditLog;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: Now } = await import("../../models/NowPaymentsInvoice.js"));
  ({ default: AuditLog } = await import("../../models/AdminAuditLog.js"));
  await Promise.all([User, Now, AuditLog].map((model) => model.init()));
}

const ORDER = "NP-12121212-1212-4212-8212-121212121212";
const KEY = `nowpayments:${ORDER}`;
const OLD = new Date(Date.now() - 2 * 3_600_000);
let cookie;
let csrf;
let n = 0;
const op = () => `http-release-op-${String(++n).padStart(6, "0")}`;

async function call(method, path, { body, withCookie = true, withCsrf = true, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (withCookie && cookie) headers.cookie = cookie;
  if (withCsrf && csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON */ }
  return { status: response.status, data };
}
const release = (body, options) => call("POST", `/api/admin/payments/${encodeURIComponent(KEY)}/release-creation-lock`, { body, ...options });
const seed = async (fields = {}) => {
  await User.create({ telegramId: "9800", balance: 10 });
  await Now.create({
    orderId: ORDER, userId: 9800, amountToman: 50_000, priceAmountCents: 100, priceCurrency: "usd", payCurrency: "trx", tomanPerFiat: 50_000, rateSource: "test",
    invoiceId: "6500", status: "creation_unknown", openCreateKey: "user:9800", recoveryStatus: "required", recoveryReason: "provider_creation_outcome_unknown",
    createdAt: OLD, updatedAt: OLD, ...fields,
  });
};

before(async () => {
  if (!dbAvailable) return;
  resetAdminRateLimitsForTests();
  const { code } = await issueAdminLoginCode("424242", fakeRedis);
  const verify = await fetch(`${baseUrl}/api/admin/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  cookie = (verify.headers.get("set-cookie") || "").split(";")[0];
  csrf = (await verify.json()).csrfToken;
});
beforeEach(async () => { if (dbAvailable) await Promise.all([User.deleteMany({}), Now.deleteMany({}), AuditLog.deleteMany({})]); });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDB();
});

describe("POST /api/admin/payments/:key/release-creation-lock", () => {
  skip("requires a session, a CSRF token and a same-origin request; refused calls change nothing", async () => {
    await seed();
    const body = { operationId: op(), reason: "customer never received the link", acceptUnverified: true };
    assert.equal((await release(body, { withCookie: false, withCsrf: false })).status, 401);
    assert.equal((await release(body, { withCsrf: false })).status, 403);
    assert.equal((await call("POST", `/api/admin/payments/${encodeURIComponent(KEY)}/release-creation-lock`, { body, headers: { "x-csrf-token": "wrong" }, withCsrf: false })).status, 403);
    assert.equal((await release(body, { headers: { origin: "https://evil.example" } })).status, 403);
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.status, "creation_unknown");
    assert.equal(row.openCreateKey, "user:9800");
    assert.equal(await AuditLog.countDocuments({}), 0, "nothing was even audited: it never reached the service");
  });

  skip("without a provider lookup the first attempt is refused with a safe message and the attestation path then works", async () => {
    await seed();
    const first = await release({ operationId: op(), reason: "customer never received the link; checked the dashboard" });
    assert.equal(first.status, 409);
    assert.equal(first.data.error, "provider_lookup_required");
    assert.match(first.data.message, /[؀-ۿ]/, "Persian, human-readable");
    const text = JSON.stringify(first.data);
    for (const leak of ["stack", "MongoServerError", "at ", "jwt", "password", "api-key"]) assert.equal(text.includes(leak), false, leak);
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_unknown");

    const second = await release({ operationId: op(), reason: "customer never received the link; checked the dashboard", acceptUnverified: true });
    assert.equal(second.status, 200);
    assert.equal(second.data.data.released, true);
    assert.equal(second.data.data.verifiedWithProvider, false);
    const row = await Now.findOne({ orderId: ORDER }).lean();
    assert.equal(row.status, "creation_failed");
    assert.equal(row.openCreateKey, undefined);
    assert.equal(row.recoveryResolvedBy, "424242");
    assert.equal((await User.findOne({ telegramId: "9800" }).lean()).balance, 10, "no money moved");
  });

  skip("the audit trail carries the administrator's identity, the unverified attestation and the order reference", async () => {
    await seed();
    await release({ operationId: op(), reason: "customer never received the link; checked the dashboard", acceptUnverified: true });
    const audits = await AuditLog.find({ action: "NOWPAYMENTS_CREATION_LOCK_RELEASED" }).lean();
    const attempts = audits.map((a) => [a.status, a.metadata.acceptUnverified]);
    assert.deepEqual(attempts, [["succeeded", true]]);
    assert.equal(audits[0].actorTelegramId, "424242");
    assert.equal(audits[0].metadata.orderRef, ORDER.slice(-12));
    assert.match(audits[0].metadata.reason, /checked the dashboard/);
    assert.ok(audits[0].completedAt);
  });

  skip("a missing, short or oversized reason is rejected before anything happens", async () => {
    await seed();
    for (const reason of [undefined, "", "short", "x".repeat(401), 12345678901234]) {
      const response = await release({ operationId: op(), reason, acceptUnverified: true });
      assert.equal(response.status, 400, String(reason).slice(0, 20));
      assert.equal(response.data.error, "invalid_reason");
    }
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_unknown");
  });

  skip("acceptUnverified must be the boolean true: strings and numbers never count as the attestation", async () => {
    await seed();
    for (const value of ["true", 1, "yes", {}, [true], null]) {
      const response = await release({ operationId: op(), reason: "customer never received the link; checked", acceptUnverified: value });
      assert.equal(response.status, 409, JSON.stringify(value));
      assert.equal(response.data.error, "provider_lookup_required");
    }
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_unknown");
  });

  skip("duplicate submission: the same operation id twice, or two parallel requests, release once and audit once", async () => {
    await seed();
    const id = op();
    const body = { operationId: id, reason: "customer never received the link; checked", acceptUnverified: true };
    const [a, b, c] = await Promise.all([release(body), release(body), release(body)]);
    const statuses = [a, b, c].map((r) => r.status).sort();
    assert.ok(statuses.includes(200), "one request succeeds");
    for (const r of [a, b, c]) assert.ok([200, 409].includes(r.status), String(r.status));
    assert.equal(await AuditLog.countDocuments({ operationId: id }), 1, "a single audit record");
    const again = await release(body);
    assert.equal(again.status, 200, "a later replay is answered from the audit record");
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_failed");
  });

  skip("a different operation id after success is refused: the order is no longer creation_unknown", async () => {
    await seed();
    await release({ operationId: op(), reason: "customer never received the link; checked", acceptUnverified: true });
    const second = await release({ operationId: op(), reason: "customer never received the link; checked", acceptUnverified: true });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "not_creation_unknown");
  });

  skip("a bound payment, a credited order and an unknown order are refused with the right code", async () => {
    await seed({ paymentId: "7500" });
    assert.equal((await release({ operationId: op(), reason: "customer never received the link; checked", acceptUnverified: true })).data.error, "payment_bound");
    await Now.deleteMany({});
    assert.equal((await release({ operationId: op(), reason: "customer never received the link; checked", acceptUnverified: true })).data.error, "payment_not_found");
    await Promise.all([User.deleteMany({}), Now.deleteMany({})]);
    await seed({ updatedAt: new Date(), createdAt: new Date() });
    const fresh = await release({ operationId: op(), reason: "customer never received the link; checked", acceptUnverified: true });
    assert.equal(fresh.data.error, "too_recent");
  });

  skip("the generic resolve endpoint refuses these orders", async () => {
    await seed();
    const response = await call("POST", `/api/admin/payments/${encodeURIComponent(KEY)}/resolve`, { body: { operationId: op(), reason: "closing this out as handled" } });
    assert.equal(response.status, 409);
    assert.equal(response.data.error, "use_creation_lock_release");
    assert.equal((await Now.findOne({ orderId: ORDER }).lean()).status, "creation_unknown");
  });

  skip("the payment detail endpoint offers exactly the new actions", async () => {
    await seed();
    const detail = await call("GET", `/api/admin/payments/${encodeURIComponent(KEY)}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.actions.releaseCreationLock, true);
    assert.equal(detail.data.data.actions.checkProvider, true);
    assert.equal(detail.data.data.actions.manualResolve, false);
    assert.equal((await call("GET", `/api/admin/payments/${encodeURIComponent(KEY)}`, { withCookie: false })).status, 401);
  });
});
