/**
 * WizardXray response classification against a REAL HTTP exchange.
 *
 * A throwaway loopback server (127.0.0.1, random port) plays the panel; the real api/wizardApi.js client (real axios),
 * the real customer purchase service (in-memory wallet models) and the real admin API-purchase handler (in-memory
 * audit ledger, session store and Telegram bot) run against it. Nothing contacts a real provider, Telegram, MongoDB or
 * Redis.
 *
 * Contract used (evidence in the repo: api/wizardApi.js header, docs/payments.md "Definitive failures",
 * tests/unit/wizardApi*.test.js): the panel refuses a request with a JSON object {ok:false, error, http_code}. A
 * mutation is treated as "nothing happened" ONLY for such an explicit, self-consistent refusal. Everything else is
 * ambiguous: a customer purchase keeps its reservation for manual review and an admin purchase stays blocked until an
 * admin reconciles it. Failures that occur before any request (input validation) remain safely retryable.
 */
import http from "node:http";
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";
import { makeAuditModel } from "../helpers/fakeAuditModel.js";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";

const { createVpnService, StatusApi, WizardApiError, WIZARD_REJECTION_CODES } = await import("../../api/wizardApi.js");
const { purchasePlan } = await import("../../services/buyService/purchaseService.js");
const { getCustomerPlans } = await import("../../services/plans.js");
const { setSessionClientForTests, clearSessionClientForTests, setSession } = await import("../../config/sessionStore.js");
const apiPurchase = await import("../../handlers/admin/apiServicePurchase.js");
const ledger = await import("../../services/admin/apiPurchaseLedger.js");

const VALID = { username: "real_svc", hash: "realHash_1", sub_link: "https://panel.example.test/sub/realHash_1", tak_links: ["vless://x@example.test:443"] };
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const redirectTo = (status, location) => (res) => json(res, status, "", { Location: location });

/** name -> [handler, expectation]; expectation: "success" | "definite" | { ambiguous: true } */
const SUCCESS = (res) => json(res, 200, { ok: true, http_code: 200, result: VALID });
const CASES = {
  // ── success ──────────────────────────────────────────────────────────────
  "200 ok:true with a valid provisioning result": [SUCCESS, "success"],
  // ── explicit, self-consistent refusals: definite ─────────────────────────
  "200 ok:false, body http_code 400": [(res) => json(res, 200, { ok: false, error: "bad request", http_code: 400 }), "definite"],
  "200 ok:false, body http_code 404": [(res) => json(res, 200, { ok: false, error: "method not found", http_code: 404 }), "definite"],
  "200 ok:false, body http_code as numeric string": [(res) => json(res, 200, { ok: false, error: "no", http_code: "400" }), "definite"],
  "200 ok:false, no body http_code (insufficient balance)": [(res) => json(res, 200, { ok: false, error: "insufficient balance" }), "definite"],
  "400 ok:false with http_code 400": [(res) => json(res, 400, { ok: false, error: "bad", http_code: 400 }), "definite"],
  "402 ok:false insufficient balance": [(res) => json(res, 402, { ok: false, error: "insufficient balance", http_code: 402 }), "definite"],
  "422 ok:false": [(res) => json(res, 422, { ok: false, error: "invalid", http_code: 422 }), "definite"],
  "429 ok:false": [(res) => json(res, 429, { ok: false, error: "slow down", http_code: 429 }), "definite"],
  // ── 4xx that do NOT establish a refusal: ambiguous ───────────────────────
  "400 with an empty JSON object": [(res) => json(res, 400, {}), { ambiguous: true }],
  "404 gateway HTML": [(res) => json(res, 404, "<html>not found</html>", { "Content-Type": "text/html" }), { ambiguous: true }],
  "422 with ok:true": [(res) => json(res, 422, { ok: true, result: VALID }), { ambiguous: true }],
  "429 with no body": [(res) => json(res, 429, ""), { ambiguous: true }],
  "400 ok:false but body http_code 500": [(res) => json(res, 400, { ok: false, http_code: 500 }), { ambiguous: true }],
  "truncated 400 body": [(res) => { res.writeHead(400, { "Content-Type": "application/json", "Content-Length": "200" }); res.write('{"ok":false,"err'); setTimeout(() => res.socket.destroy(), 20); }, { ambiguous: true }],
  // ── ok:false that the body itself contradicts: ambiguous ─────────────────
  "200 ok:false, body http_code 500": [(res) => json(res, 200, { ok: false, error: "internal error", http_code: 500 }), { ambiguous: true }],
  "200 ok:false, body http_code 503": [(res) => json(res, 200, { ok: false, error: "unavailable", http_code: 503 }), { ambiguous: true }],
  "200 ok:false, body http_code 408": [(res) => json(res, 200, { ok: false, http_code: 408 }), { ambiguous: true }],
  "200 ok:false, body http_code 200 (contradictory)": [(res) => json(res, 200, { ok: false, http_code: 200 }), { ambiguous: true }],
  "200 ok:false, malformed body http_code": [(res) => json(res, 200, { ok: false, error: "x", http_code: "banana" }), { ambiguous: true }],
  "200 ok:false, body http_code is an object": [(res) => json(res, 200, { ok: false, error: "x", http_code: { code: 400 } }), { ambiguous: true }],
  "200 with ok:\"false\" (a string)": [(res) => json(res, 200, { ok: "false", error: "x" }), { ambiguous: true }],
  "200 with an empty JSON object": [(res) => json(res, 200, {}), { ambiguous: true }],
  // ── transport statuses that never prove a refusal: ambiguous ─────────────
  "408 request timeout (even with an ok:false body)": [(res) => json(res, 408, { ok: false, http_code: 408 }), { ambiguous: true }],
  "500": [(res) => json(res, 500, { ok: false, error: "boom", http_code: 500 }), { ambiguous: true }],
  "502 HTML": [(res) => json(res, 502, "<html>bad gateway</html>", { "Content-Type": "text/html" }), { ambiguous: true }],
  "503": [(res) => json(res, 503, { ok: false, http_code: 503 }), { ambiguous: true }],
  "504 empty": [(res) => json(res, 504, ""), { ambiguous: true }],
  // ── redirects are never followed ─────────────────────────────────────────
  "300": [(res) => json(res, 300, { ok: false }), { ambiguous: true }],
  "302 without Location": [(res) => json(res, 302, { ok: false }), { ambiguous: true }],
  "302 with Location to a URL that would succeed": [redirectTo(302, "/follow-ok"), { ambiguous: true, noFollow: true }],
  "301 with Location to a URL that would succeed": [redirectTo(301, "/follow-ok"), { ambiguous: true, noFollow: true }],
  "303 with Location to a URL that would succeed": [redirectTo(303, "/follow-ok"), { ambiguous: true, noFollow: true }],
  "307 with Location (would re-send the POST)": [redirectTo(307, "/follow-ok"), { ambiguous: true, noFollow: true }],
  "308 with Location (would re-send the POST)": [redirectTo(308, "/follow-ok"), { ambiguous: true, noFollow: true }],
  "302 to a URL that would reject": [redirectTo(302, "/follow-reject"), { ambiguous: true, noFollow: true }],
  "301 redirect loop": [redirectTo(301, "/create"), { ambiguous: true }],
  "304": [(res) => { res.writeHead(304); res.end(); }, { ambiguous: true }],
  // ── incomplete or malformed responses: ambiguous ─────────────────────────
  "200 headers, then the connection drops mid-body": [(res) => { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "500" }); res.write('{"ok":true,"result":{"username":"real'); setTimeout(() => res.socket.destroy(), 20); }, { ambiguous: true }],
  "200 invalid JSON": [(res) => json(res, 200, "{not json"), { ambiguous: true }],
  "200 HTML": [(res) => json(res, 200, "<html>ok</html>", { "Content-Type": "text/html" }), { ambiguous: true }],
  "200 empty body": [(res) => json(res, 200, ""), { ambiguous: true }],
  "200 JSON array": [(res) => json(res, 200, "[]"), { ambiguous: true }],
  "200 JSON null": [(res) => json(res, 200, "null"), { ambiguous: true }],
  "200 ok:true without a result": [(res) => json(res, 200, { ok: true }), { ambiguous: true }],
  "200 ok:true with a malformed username": [(res) => json(res, 200, { ok: true, result: { username: "bad name!", hash: "h" } }), { ambiguous: true }],
  "200 ok:true with neither hash nor link": [(res) => json(res, 200, { ok: true, result: { username: "svc_nohash" } }), { ambiguous: true }],
  "200 body over the size limit": [(res) => json(res, 200, JSON.stringify({ ok: true, result: VALID, pad: "x".repeat(1_200_000) })), { ambiguous: true }],
  // ── network failures: ambiguous ──────────────────────────────────────────
  "connection reset before any response": [(res) => res.socket.destroy(), { ambiguous: true }],
};

let server;
let mode = "";
const seen = [];
const sockets = new Set();
let previousEnv;
const originalConsole = {};

before(async () => {
  previousEnv = { NODE_ENV: process.env.NODE_ENV, WIZARD_API_URL: process.env.WIZARD_API_URL, VPN_API_KEY: process.env.VPN_API_KEY };
  process.env.NODE_ENV = "test";
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/follow-ok") return json(res, 200, { ok: true, result: VALID });
    if (req.url === "/follow-reject") return json(res, 200, { ok: false, error: "rejected", http_code: 400 });
    if (mode === "hang") return; // never answers: the client's own 15 s timeout fires
    const entry = CASES[mode];
    return entry ? entry[0](res) : json(res, 500, "unknown mode");
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.VPN_API_KEY = "fake-unit-key-not-a-real-credential";
  for (const level of ["log", "warn", "error"]) { originalConsole[level] = console[level]; console[level] = () => {}; }
});

after(async () => {
  for (const [level, fn] of Object.entries(originalConsole)) console[level] = fn;
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => { seen.length = 0; });

const creates = () => seen.filter((entry) => entry === "POST /create").length;
const isRejection = (error) => error instanceof WizardApiError && error.ambiguous === false && WIZARD_REJECTION_CODES.includes(error.code);

describe("client classification over a real HTTP exchange", () => {
  for (const [name, [, expected]] of Object.entries(CASES)) {
    test(`${name} -> ${expected === "success" ? "success" : expected === "definite" ? "definite refusal" : "ambiguous"}`, async () => {
      mode = name;
      let outcome;
      try { outcome = { value: await createVpnService(5, 30, 0) }; } catch (error) { outcome = { error }; }

      if (expected === "success") {
        assert.equal(outcome.value?.result?.username, "real_svc");
        assert.equal(creates(), 1);
        return;
      }
      assert.ok(outcome.error instanceof WizardApiError, `expected a WizardApiError, got ${outcome.value ? "success" : outcome.error}`);
      if (expected === "definite") {
        assert.equal(outcome.error.ambiguous, false, "an explicit refusal is definite");
        assert.ok(isRejection(outcome.error), `carries a rejection code (${outcome.error.code})`);
      } else {
        assert.equal(outcome.error.ambiguous, true, `must stay ambiguous (status ${outcome.error.status}, code ${outcome.error.code})`);
        assert.ok(!WIZARD_REJECTION_CODES.includes(outcome.error.code), "an ambiguous error never carries a rejection code");
      }
      if (expected.noFollow) {
        assert.deepEqual(seen, ["POST /create"], "the redirect must not be followed (no GET, no second POST)");
      }
      assert.ok(creates() >= 1 && seen.every((entry) => entry.endsWith(" /create")), `only the original request was sent: ${seen.join(", ")}`);
    });
  }

  test("input validation fails before any request and stays a plain TypeError", async () => {
    await assert.rejects(() => createVpnService(0, 30, 0), (error) => error instanceof TypeError && !(error instanceof WizardApiError));
    await assert.rejects(() => createVpnService(5, 0, 0), TypeError);
    await assert.rejects(() => createVpnService(5, 30, 7), TypeError);
    assert.deepEqual(seen, []);
  });

  test("a redirect on a read is an error too and is not followed", async () => {
    mode = "302 with Location to a URL that would succeed";
    await assert.rejects(() => StatusApi(), (error) => error instanceof WizardApiError && error.status === 302);
    assert.ok(!seen.includes("GET /follow-ok"));
  });

  test("a request that gets no answer times out as ambiguous (15 s client timeout), for the client, a customer and an admin purchase", async () => {
    mode = "hang";
    const plan = getCustomerPlans()[0];
    const models = makeFakeWalletModels([{ telegramId: "8801", balance: 500_000 }]);
    const admin = adminHarness();
    await admin.arm("c0ffee00c0ffee00c0ff");

    const [client, customer] = await Promise.all([
      createVpnService(5, 30, 0).then(() => null, (error) => error),
      purchasePlan("8801", plan.id, { userModel: models.userModel, purchaseModel: models.purchaseModel, purchaseId: "timeout-customer" }),
      admin.tap("c0ffee00c0ffee00c0ff"),
    ]);

    assert.ok(client instanceof WizardApiError && client.ambiguous === true && client.code === "ECONNABORTED");
    assert.equal(customer.status, "manual_review");
    assert.equal(models.users.get("8801").balance, 500_000 - plan.price, "the reservation is kept");
    assert.equal(models.users.get("8801").refundedPurchaseIds.length, 0);
    assert.equal(await admin.blocked(), true);
    assert.equal(admin.row().errorCode, ledger.API_PURCHASE_UNKNOWN_CODE);
  });
});

function adminHarness() {
  const sessions = makeSessionClient();
  const audit = makeAuditModel();
  const bot = makeFakeBot();
  const chat = { id: -100777, type: "supergroup" };
  const confirmation = (purchaseId) => ({ step: "waiting_for_api_confirmation", gig: 5, days: 30, messageId: 10, adminUserId: "9001", purchaseId });
  return {
    audit,
    bot,
    async arm(purchaseId, extra = {}) {
      setSessionClientForTests(sessions);
      apiPurchase.resetApiPurchaseLocksForTests();
      apiPurchase.setApiPurchaseDepsForTests({ auditModel: audit });
      await setSession(-100777, { ...confirmation(purchaseId), ...extra });
    },
    async tap(purchaseId, extra = {}) {
      return apiPurchase.createApiService(bot, { id: `q${Math.random()}`, from: { id: 9001 }, message: { message_id: 10, chat } }, { ...confirmation(purchaseId), ...extra });
    },
    row: () => audit.byAction(ledger.API_PURCHASE_ACTION)[0],
    rows: () => audit.byAction(ledger.API_PURCHASE_ACTION),
    unresolved: async () => (await ledger.findUnresolvedApiPurchases({ auditModel: audit })).map((entry) => entry.purchaseId),
    blocked: async () => (await ledger.findUnresolvedApiPurchases({ auditModel: audit })).length > 0,
    done: () => clearSessionClientForTests(),
  };
}

describe("downstream consequences of each classification", () => {
  const plan = getCustomerPlans()[0];
  let counter = 0;

  for (const [name, [, expected]] of Object.entries(CASES)) {
    const label = expected === "success" ? "success" : expected === "definite" ? "definite refusal" : "ambiguous";
    test(`${name}: customer purchase and admin purchase (${label})`, async () => {
      mode = name;
      counter += 1;
      const telegramId = String(8000 + counter);
      const purchaseId = `resp-${counter}`;
      const models = makeFakeWalletModels([{ telegramId, balance: 500_000 }]);

      // ── customer wallet purchase (real client, real purchase service) ──
      seen.length = 0;
      const first = await purchasePlan(telegramId, plan.id, { userModel: models.userModel, purchaseModel: models.purchaseModel, purchaseId });
      const wallet = models.users.get(telegramId);
      if (expected === "success") {
        assert.equal(first.status, "completed");
        assert.equal(wallet.balance, 500_000 - plan.price);
      } else if (expected === "definite" && /insufficient balance/.test(name)) {
        assert.equal(first.status, "awaiting_provider", "a proven provider shortage reserves the order for an admin");
        assert.equal(first.failure, "awaiting_provider_funds");
        assert.equal(wallet.balance, 500_000 - plan.price, "the debit is retained as the reservation");
        assert.deepEqual(wallet.refundedPurchaseIds, [], "a temporary provider shortage is never refunded automatically");
      } else if (expected === "definite") {
        assert.equal(first.status, "refunded", "a proven refusal refunds exactly once");
        assert.equal(first.failure, "provider_rejected_refunded");
        assert.equal(wallet.balance, 500_000);
        assert.deepEqual(wallet.refundedPurchaseIds, [purchaseId]);
      } else {
        assert.equal(first.status, "manual_review", `ambiguous results keep the reservation for manual review (got ${first.status})`);
        assert.equal(first.failure, "provider_outcome_unknown");
        assert.equal(wallet.balance, 500_000 - plan.price, "the debit is retained");
        assert.deepEqual(wallet.refundedPurchaseIds, [], "no automatic refund");
        assert.notEqual(models.purchases.get(purchaseId).refundStatus, "completed");
      }
      const requestsForFirst = creates();
      assert.ok(requestsForFirst >= 1);
      assert.ok(!seen.some((entry) => entry === "GET /follow-ok"), "the customer path never follows a redirect");
      // Replaying the same order never reaches the provider again, whatever the outcome.
      const replay = await purchasePlan(telegramId, plan.id, { userModel: models.userModel, purchaseModel: models.purchaseModel, purchaseId });
      assert.equal(replay.replayed, true);
      assert.equal(creates(), requestsForFirst);
      assert.equal(models.users.get(telegramId).balance, wallet.balance);

      // ── admin API purchase (real client, real handler, in-memory ledger) ──
      const admin = adminHarness();
      const id1 = String(counter).padStart(20, "1");
      const id2 = String(counter).padStart(20, "2");
      await admin.arm(id1);
      seen.length = 0;
      await admin.tap(id1);
      const adminRequests = creates();
      assert.equal(adminRequests, 1);

      if (expected === "success") {
        assert.equal(admin.row().status, "succeeded");
        assert.equal(await admin.blocked(), false);
      } else if (expected === "definite") {
        assert.equal(admin.row().errorCode, ledger.API_PURCHASE_REJECTED_CODE);
        assert.equal(await admin.blocked(), false, "a proven refusal is safely retryable");
        const retryButton = admin.bot.of("editMessageText").some((call) => JSON.stringify(call.args[1]?.reply_markup || {}).includes("admin_api_service_purchase"));
        assert.equal(retryButton, true);
      } else {
        assert.equal(admin.row().status, "failed");
        assert.equal(admin.row().errorCode, ledger.API_PURCHASE_UNKNOWN_CODE);
        assert.deepEqual(await admin.unresolved(), [id1], "ambiguous admin purchases stay blocked pending reconciliation");
        const retryButton = admin.bot.of("editMessageText").some((call) => JSON.stringify(call.args[1]?.reply_markup || {}).includes("admin_api_service_purchase"));
        assert.equal(retryButton, false, "no one-tap retry is offered");
      }

      // A second confirmation reaches the provider only if the first outcome was settled.
      await admin.arm(id2);
      seen.length = 0;
      await admin.tap(id2);
      assert.equal(creates(), expected === "ambiguous" || (typeof expected === "object") ? 0 : 1, "blocked purchases never reach the provider again");
      admin.done();
    });
  }

  test("input validation failure before any request is a settled, safely retryable admin outcome", async () => {
    mode = "200 ok:true with a valid provisioning result";
    const admin = adminHarness();
    const id1 = "abababababababababab";
    await admin.arm(id1, { gig: 0.1 });
    seen.length = 0;
    await admin.tap(id1, { gig: 0.1 });
    assert.deepEqual(seen, [], "nothing was sent to the provider");
    assert.equal(admin.row().errorCode, ledger.API_PURCHASE_REJECTED_CODE);
    assert.equal(await admin.blocked(), false);
    await admin.arm("cdcdcdcdcdcdcdcdcdcd");
    await admin.tap("cdcdcdcdcdcdcdcdcdcd");
    assert.equal(creates(), 1, "the next purchase proceeds");
    admin.done();
  });

  test("a configuration error before any request does not touch the wallet of a customer and is not a provider outcome", async () => {
    // Environment problems are raised before the request is built; nothing reaches the server.
    const saved = process.env.VPN_API_KEY;
    delete process.env.VPN_API_KEY;
    try {
      await assert.rejects(() => createVpnService(5, 30, 0), (error) => !(error instanceof WizardApiError) && /not configured/.test(error.message));
      assert.deepEqual(seen, []);
    } finally { process.env.VPN_API_KEY = saved; }
  });
});
