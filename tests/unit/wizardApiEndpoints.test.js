/**
 * Contract tests against the provider document "WizardXray web service API v1":
 * base URL + method name, GET/POST per method, Bearer auth, form fields and
 * their documented minimums. A local recording server stands in for the panel.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  StatusApi, listClients, createVpnService, createTestService, findService,
  deleteService, changeLinkService, upgradeServiceTime, upgradeServiceSize, deactiveService, WizardApiError,
} from "../../api/wizardApi.js";

let server;
let calls = [];
let reply;
const KEY = "unit-wizard-key-not-real";
const saved = {};

before(async () => {
  for (const k of ["NODE_ENV", "WIZARD_API_URL", "VPN_API_KEY"]) saved[k] = process.env[k];
  process.env.NODE_ENV = "test";
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], form: Object.fromEntries(new URLSearchParams(body)) });
      const out = reply(req);
      res.writeHead(out.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.VPN_API_KEY = KEY;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { calls = []; reply = () => ({ body: { ok: true, error: "", result: {}, http_code: 200 } }); });

const last = () => calls.at(-1);

describe("documented methods", () => {
  test("status is GET /status with the Bearer key and no body", async () => {
    reply = () => ({ body: { ok: true, result: { per_gb: 1000, per_day: 100 }, http_code: 200 } });
    await StatusApi();
    assert.equal(last().method, "GET");
    assert.equal(last().url, "/status");
    assert.equal(last().auth, `Bearer ${KEY}`);
  });

  test("clients is GET /clients and takes an optional validated limit", async () => {
    reply = () => ({ body: { ok: true, result: [{ username: "a" }], http_code: 200 } });
    const all = await listClients();
    assert.equal(last().url, "/clients");
    assert.deepEqual(all.result, [{ username: "a" }]);
    await listClients(25);
    assert.equal(last().url, "/clients?limit=25");
    for (const bad of [0, -1, 1.5, "x", 100000, "1;drop"]) await assert.rejects(() => listClients(bad), TypeError, String(bad));
    assert.equal(calls.length, 2);
  });

  test("create sends gig/day/test; gig may be fractional (min 0.5) and day is a positive integer", async () => {
    reply = () => ({ body: { ok: true, result: { username: "svc_1", hash: "abc123", sub_link: "https://x.example/s" }, http_code: 200 } });
    await createVpnService(0.5, 1, 0);
    assert.equal(last().method, "POST");
    assert.equal(last().url, "/create");
    assert.match(last().type, /application\/x-www-form-urlencoded/);
    assert.deepEqual(last().form, { gig: "0.5", day: "1", test: "0" });
    await createVpnService(10, 30, 0);
    assert.equal(last().form.gig, "10");
    for (const [gig, day] of [[0.4, 1], [0, 1], [-1, 5], [1, 0], [1, 1.5], ["x", 1], [1, "y"], [1.234, 1]]) {
      await assert.rejects(() => createVpnService(gig, day, 0), TypeError, `${gig}/${day}`);
    }
  });

  test("a test service is create with test=1 only", async () => {
    reply = () => ({ body: { ok: true, result: { username: "t_1", hash: "h1" }, http_code: 200 } });
    await createTestService();
    assert.deepEqual(last().form, { test: "1" });
  });

  test("find, change_link, reverse_mode and delsv are POST with only the username", async () => {
    await findService("svc_1");
    assert.deepEqual([last().method, last().url, last().form], ["POST", "/find", { username: "svc_1" }]);
    await changeLinkService("svc_1");
    assert.deepEqual([last().method, last().url, last().form], ["POST", "/change_link", { username: "svc_1" }]);
    await deactiveService("svc_1");
    assert.deepEqual([last().method, last().url, last().form], ["POST", "/reverse_mode", { username: "svc_1" }]);
    await deleteService("svc_1");
    assert.deepEqual([last().method, last().url, last().form], ["POST", "/delsv", { username: "svc_1" }]);
  });

  test("the delete method is the documented `delsv` (not the old, wrong `delsvc`)", () => {
    assert.equal(calls.some((c) => c.url === "/delsvc"), false);
  });

  test("upg_time adds whole days (min 1)", async () => {
    await upgradeServiceTime("svc_1", 30);
    assert.deepEqual([last().method, last().url, last().form], ["POST", "/upg_time", { username: "svc_1", day: "30" }]);
    for (const bad of [0, -3, 1.5, "x", null, 100000]) await assert.rejects(() => upgradeServiceTime("svc_1", bad), TypeError, String(bad));
  });

  test("upg_size adds gigabytes (min 0.5)", async () => {
    await upgradeServiceSize("svc_1", 0.5);
    assert.deepEqual([last().method, last().url, last().form], ["POST", "/upg_size", { username: "svc_1", gig: "0.5" }]);
    await upgradeServiceSize("svc_1", 12.25);
    assert.equal(last().form.gig, "12.25");
    for (const bad of [0, 0.49, -1, "x", null, 1.005]) await assert.rejects(() => upgradeServiceSize("svc_1", bad), TypeError, String(bad));
  });

  test("usernames are validated before any request is made", async () => {
    const before = calls.length;
    for (const bad of ["", "a b", "../x", "x;y", "a".repeat(200), null, 5]) {
      await assert.rejects(() => upgradeServiceTime(bad, 5), TypeError);
      await assert.rejects(() => deleteService(bad), TypeError);
    }
    assert.equal(calls.length, before);
  });
});

describe("response handling", () => {
  test("ok:false from the panel is an error with a coarse code, never the raw text", async () => {
    reply = () => ({ body: { ok: false, error: "method not found! supplier cost 4242", result: [], http_code: 404 } });
    await assert.rejects(() => findService("svc_1"), (e) => e instanceof WizardApiError && !/4242|supplier/i.test(e.message));
  });

  test("mutations that time out or fail with 5xx are flagged ambiguous and never retried", async () => {
    reply = () => ({ status: 503, body: { ok: false } });
    await assert.rejects(() => upgradeServiceTime("svc_1", 5), (e) => e.ambiguous === true);
    assert.equal(calls.length, 1, "a mutation is sent exactly once");
    calls = [];
    await assert.rejects(() => upgradeServiceSize("svc_1", 1), (e) => e.ambiguous === true);
    assert.equal(calls.length, 1);
  });

  test("a rejection (ok:false) of a mutation is definitive, not ambiguous", async () => {
    reply = () => ({ body: { ok: false, error: "no", result: [], http_code: 400 } });
    await assert.rejects(() => upgradeServiceSize("svc_1", 1), (e) => e.ambiguous === false);
  });

  test("non-object responses are rejected", async () => {
    reply = () => ({ body: "oops" });
    await assert.rejects(() => listClients(), (e) => e.code === "invalid_response");
  });

  test("the API key never appears in errors", async () => {
    reply = () => ({ status: 500, body: { ok: false } });
    await assert.rejects(() => findService("svc_1"), (e) => !String(e.message + JSON.stringify(e)).includes(KEY));
  });
});
