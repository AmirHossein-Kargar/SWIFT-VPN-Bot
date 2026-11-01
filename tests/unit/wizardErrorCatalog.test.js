/**
 * Every error the provider document lists, replayed over real HTTP against the real client.
 *
 * DOCUMENTED below is copied from the document (section 10 and each method's own list), independently of the table in
 * api/wizardErrors.js, so a row edited in that table cannot quietly change what this test expects. Each row gives: the HTTP code,
 * the exact text, a method that can return it, the client's verdict and what the document says happened to the money.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const api = await import("../../api/wizardApi.js");
const { WIZARD_ERROR_CATALOG, UNGUARANTEED_ERRORS, findDocumentedError } = await import("../../api/wizardErrors.js");
const { WizardApiError, WIZARD_REJECTION_CODES } = api;

const USER = "9I517RL2K";
const CALL = {
  me: () => api.getAccount(),
  status: () => api.StatusApi(),
  price: () => api.quotePrice(20, 30),
  get_hosts: () => api.getHosts(),
  create: () => api.createVpnService(20, 30, 0),
  info: () => api.getServiceInfo(USER),
  clients: () => api.listClients({ limit: 5 }),
  renew: () => api.renewService(USER, 10, 10),
  upg_time: () => api.upgradeServiceTime(USER, 5),
  upg_size: () => api.upgradeServiceSize(USER, 5),
  change_link: () => api.changeLinkService(USER),
  reverse_mode: () => api.setServiceStatus(USER, "disabled"),
  delsv: () => api.deleteService(USER),
};

/** [http, error, method, code, reason, retry] */
const DOCUMENTED = [
  [400, "invalid JSON body ( Syntax error )", "create", "panel_rejected_request", "invalid_json", false],
  [402, "You don't have enough fund!", "create", "provider_insufficient_balance", "provider_insufficient_balance", false],
  [402, "You don't have enough fund!", "renew", "provider_insufficient_balance", "provider_insufficient_balance", false],
  [402, "You don't have enough fund!", "upg_time", "provider_insufficient_balance", "provider_insufficient_balance", false],
  [402, "You don't have enough fund!", "upg_size", "provider_insufficient_balance", "provider_insufficient_balance", false],
  [403, "method is invalid", "me", "panel_rejected_request", "method_invalid", false],
  [403, "not authorized", "me", "panel_rejected_request", "auth_missing", false],
  [403, "apikey is invalid", "me", "panel_rejected_request", "auth_invalid", false],
  [404, "apikey is invalid or not found!", "create", "panel_rejected_request", "auth_invalid", false],
  [403, "API is not available", "create", "panel_rejected_request", "api_disabled", true],
  [404, 'method "xyz" not found!', "info", "panel_rejected_request", "method_not_found", false],
  [403, "username format is incorrect!", "info", "panel_rejected_request", "invalid_username", false],
  [404, "service not found!", "renew", "panel_rejected_request", "service_not_found", false],
  [409, "service is busy, try again", "renew", "provider_busy", "provider_busy", true],
  [409, "service is busy, try again", "upg_time", "provider_busy", "provider_busy", true],
  [409, "service is busy, try again", "upg_size", "provider_busy", "provider_busy", true],
  [409, "service is busy, try again", "delsv", "provider_busy", "provider_busy", true],
  [409, "service is busy, try again", "change_link", "provider_busy", "provider_busy", true],
  [409, "service is busy, try again", "reverse_mode", "provider_busy", "provider_busy", true],
  [409, "service is busy, try again", "create", "provider_busy", "provider_busy", true],
  [403, "gig & day is required!", "create", "panel_rejected_request", "terms_missing", false],
  [403, "Minimum gig: 0.5 Minimum day: 1", "price", "panel_rejected_request", "terms_below_minimum", false],
  [403, "Maximum gig: 10000 Maximum day: 3650", "renew", "panel_rejected_request", "terms_above_maximum", false],
  [403, "Minimum day: 1 Maximum day: 3650", "create", "panel_rejected_request", "unlimited_days_out_of_range", false],
  [403, "unlimited is not enabled", "create", "panel_rejected_request", "unlimited_disabled", false],
  [403, "unlimited is not enabled", "renew", "panel_rejected_request", "unlimited_disabled", false],
  [403, "unlimited is not enabled", "price", "panel_rejected_request", "unlimited_disabled", false],
  [403, "unlimited is not enabled", "upg_time", "panel_rejected_request", "unlimited_disabled", false],
  [404, "test paramter is required!", "create", "panel_rejected_request", "test_param_missing", false],
  [403, "test must be 0 or 1", "create", "panel_rejected_request", "test_param_invalid", false],
  [403, "Maximum test is 100", "create", "panel_rejected_request", "test_unavailable", false],
  [403, "day is required!", "upg_time", "panel_rejected_request", "day_missing", false],
  [404, "Minimum day: 1", "upg_time", "panel_rejected_request", "add_day_below_minimum", false],
  [403, "Maximum day: 3650", "upg_time", "panel_rejected_request", "add_day_above_maximum", false],
  [403, "gig is required!", "upg_size", "panel_rejected_request", "gig_missing", false],
  [404, "Minimum gig: 1", "upg_size", "panel_rejected_request", "add_gig_below_minimum", false],
  [403, "Maximum gig: 10000", "upg_size", "panel_rejected_request", "add_gig_above_maximum", false],
  [403, "service is unlimited", "upg_size", "panel_rejected_request", "service_is_unlimited", false],
  [403, "status must be active or disabled", "reverse_mode", "panel_rejected_request", "status_invalid", false],
  [403, "", "get_hosts", "panel_rejected_request", "hosts_unavailable", false],
  [500, "cant create service", "create", "panel_operation_failed", "create_failed", false],
  [500, "cant get info", "renew", "panel_operation_failed", "panel_read_failed", true],
  [500, "cant get info", "delsv", "panel_operation_failed", "panel_read_failed", true],
  [500, "cant get service info", "upg_time", "panel_operation_failed", "panel_read_failed", true],
  [500, "cant get service info", "upg_size", "panel_operation_failed", "panel_read_failed", true],
  [500, "cant get service info", "reverse_mode", "panel_operation_failed", "panel_read_failed", true],
  [500, "cant reset usage", "renew", "panel_operation_failed", "update_failed", false],
  [500, "cant update service", "renew", "panel_operation_failed", "update_failed", false],
  [500, "cant update service", "upg_time", "panel_operation_failed", "update_failed", false],
  [500, "cant update service", "upg_size", "panel_operation_failed", "update_failed", false],
  [500, "cant update service", "change_link", "panel_operation_failed", "update_failed", false],
  [500, "cant update service", "reverse_mode", "panel_operation_failed", "update_failed", false],
  [500, "cant delete service", "delsv", "panel_operation_failed", "delete_failed", false],
];

let server;
let reply;
let seen = [];
const saved = {};

before(async () => {
  for (const key of ["NODE_ENV", "WIZARD_API_URL", "VPN_API_KEY"]) saved[key] = process.env[key];
  process.env.NODE_ENV = "test";
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(`${req.method} ${req.url.split("?")[0]}`);
      const { status, body } = reply();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}/api/v1/`;
  process.env.VPN_API_KEY = "unit-key-not-real";
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => { seen = []; });

const refuse = (http_code, error, result = []) => { reply = () => ({ status: http_code, body: { ok: false, error, result, http_code } }); };

describe("every documented error", () => {
  for (const [httpCode, text, method, code, reason, retry] of DOCUMENTED) {
    test(`${method}: ${httpCode} "${text}" -> ${reason}`, async () => {
      refuse(httpCode, text);
      const error = await CALL[method]().then(() => null, (failure) => failure);
      assert.ok(error instanceof WizardApiError, `expected a refusal, got ${error}`);
      assert.equal(error.code, code);
      assert.equal(error.reason, reason);
      assert.equal(error.ambiguous, false, "the document states the outcome, so it is definite");
      assert.equal(error.retry, retry);
      assert.ok(WIZARD_REJECTION_CODES.includes(error.code), "callers treat it as settled");
      assert.equal(seen.length, 1, "one request, never retried by the client");
      assert.equal(String(error.message).includes(text) && text !== "", false, "provider text does not reach the caller");
    });
  }

  test("every row of the table is exercised by the list above", () => {
    const covered = new Set(DOCUMENTED.map(([httpCode, text, method]) => findDocumentedError(method, httpCode, text)));
    const missing = WIZARD_ERROR_CATALOG.filter((row) => !covered.has(row) && row.reason !== "no_services");
    assert.deepEqual(missing.map((row) => `${row.http} ${row.error}`), []);
  });
});

describe("the same words outside their contract are not trusted", () => {
  test("`internal error` promises nothing, so a mutation stays ambiguous", async () => {
    assert.deepEqual(UNGUARANTEED_ERRORS, ["internal error"]);
    refuse(500, "internal error");
    for (const method of ["create", "renew", "upg_time", "upg_size", "delsv", "change_link", "reverse_mode"]) {
      const error = await CALL[method]().then(() => null, (failure) => failure);
      assert.equal(error.ambiguous, true, method);
      assert.ok(!WIZARD_REJECTION_CODES.includes(error.code), method);
    }
  });

  test("a guarantee given for one method does not carry to another", async () => {
    refuse(500, "cant create service");
    assert.equal((await CALL.renew().catch((error) => error)).ambiguous, true);
    refuse(500, "cant update service");
    assert.equal((await CALL.create().catch((error) => error)).ambiguous, true);
  });

  test("the text with the wrong status, or a body that contradicts itself, proves nothing", async () => {
    reply = () => ({ status: 503, body: { ok: false, error: "cant create service", result: [], http_code: 503 } });
    assert.equal((await CALL.create().catch((error) => error)).ambiguous, true);
    reply = () => ({ status: 500, body: { ok: false, error: "cant create service", result: [], http_code: 200 } });
    assert.equal((await CALL.create().catch((error) => error)).ambiguous, true);
    reply = () => ({ status: 500, body: { ok: true, error: "cant create service", result: [], http_code: 500 } });
    assert.equal((await CALL.create().catch((error) => error)).ambiguous, true);
  });

  test("an unlisted refusal is still a refusal, with no specific reason", async () => {
    refuse(403, "some future refusal");
    const error = await CALL.create().catch((failure) => failure);
    assert.deepEqual([error.ambiguous, error.code, error.reason], [false, "panel_rejected_request", null]);
  });
});

describe("what the monitor is told", () => {
  test("an outage and a refusal are different things", async () => {
    refuse(403, "apikey is invalid");
    assert.equal((await CALL.me().catch((error) => error)).outage, true);
    refuse(404, "service not found!");
    assert.equal((await CALL.renew().catch((error) => error)).outage, false);
    refuse(402, "You don't have enough fund!");
    assert.equal((await CALL.create().catch((error) => error)).outage, false);
    refuse(500, "cant create service");
    assert.equal((await CALL.create().catch((error) => error)).outage, true);
  });
});

describe("answers the client treats as results, not errors", () => {
  test("`clients` 404 `no service` is an empty list", async () => {
    refuse(404, "no service");
    assert.deepEqual(await CALL.clients(), { count: 0, total: 0, items: [] });
  });

  test("past the end of the list the total is unknown, not zero", async () => {
    refuse(404, "no service");
    assert.equal((await api.listClients({ limit: 5, offset: 100 })).total, null);
  });

  test("`delsv` of a service that is already gone is ok, without a refund", async () => {
    reply = () => ({ status: 200, body: { ok: true, error: "", result: ["successfully deleted"], http_code: 200 } });
    const answer = await CALL.delsv();
    assert.deepEqual([answer.alreadyGone, answer.returnPrice], [true, null]);
  });
});
