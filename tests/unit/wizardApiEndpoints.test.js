/**
 * Contract tests against the provider's web service document: base URL + method name, GET/POST per method, Bearer auth, form
 * fields, documented limits and each method's real response shape. A local recording server stands in for the panel, so this
 * proves the client matches the document. It does not prove the live provider does.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  StatusApi, listClients, createVpnService, createTestService, getServiceInfo, getAccount, getHosts, quotePrice, renewService, normalizeService, panelPingMs,
  deleteService, changeLinkService, upgradeServiceTime, upgradeServiceSize, setServiceStatus, WizardApiError, GIB, UNLIMITED_GIG,
} from "../../api/wizardApi.js";

let server;
let calls = [];
let reply;
const KEY = "unit-wizard-key-not-real";
const saved = {};

const SERVICE = {
  username: "9I517RL2K", status: "active", source: "panel", test: false, unlimited: false,
  sub_link: "https://sub.example.com/sub/88a7", links: ["vless://a@de.example.com:443#Germany"],
  expire: 1795532266, expire_jalali: "1405/9/3 18:27", days_left: 30,
  data_limit: 20 * GIB, used_traffic: 5 * GIB, remaining_traffic: 15 * GIB, data_limit_gb: 20, used_traffic_gb: 5, remaining_traffic_gb: 15,
  online_at: 1792940146, online_at_jalali: "1405/8/3 18:25", last_client: "v2rayNG/1.8.19", created_at: 1792940266, created_at_jalali: "1405/8/3 18:27",
};
const CREATED = { username: "9I517RL2K", hash: "88a7", uid: "5c46", sub_link: "https://sub.example.com/sub/88a7", tak_links: ["vless://a@de.example.com:443#Germany"], gig: 20, day: 30, gig_byte: 20 * GIB, expiryTime: 1795532266, price: 45000, charged: 45000, created_at: 1792940266, test: 0, unlimited: false, service: SERVICE };
const ok = (result, extra = {}) => ({ body: { ok: true, error: "", result, http_code: 200, ...extra } });

before(async () => {
  for (const k of ["NODE_ENV", "WIZARD_API_URL", "VPN_API_KEY"]) saved[k] = process.env[k];
  process.env.NODE_ENV = "test";
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const [path, query = ""] = req.url.split("?");
      calls.push({ method: req.method, url: req.url, path, query: Object.fromEntries(new URLSearchParams(query)), auth: req.headers.authorization, type: req.headers["content-type"], form: Object.fromEntries(new URLSearchParams(body)) });
      const out = reply(req);
      res.writeHead(out.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The document: {API_URL} always ends in /api/v1/, and the method name is appended to it.
  process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}/api/v1/`;
  process.env.VPN_API_KEY = KEY;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { calls = []; reply = () => ok({}); });

const last = () => calls.at(-1);

describe("account and pricing", () => {
  const ME = { user_id: 900131, balance: 1000000, currency: "toman", prices: { per_gb: 1500, per_day: 500, unlimited_per_day: 0, test: 1500, activation: 300000, custom: false }, limits: { min_gig: 0.5, max_gig: 10000, min_day: 1, max_day: 3650, min_add_gig: 1, min_add_day: 1, unlimited_enabled: false, test_enabled: true, test_gig: 0.3, test_day: 1, max_tests: 100000, tests_used: 0 }, services: { total: 0, active: 0 } };

  test("me is GET /me with the Bearer key, under the configured path", async () => {
    reply = () => ok(ME);
    const account = await getAccount();
    assert.deepEqual([last().method, last().path, last().auth], ["GET", "/api/v1/me", `Bearer ${KEY}`]);
    assert.equal(account.balance, 1000000);
    assert.deepEqual(account.prices, { perGb: 1500, perDay: 500, unlimitedPerDay: 0, test: 1500, custom: false });
    assert.equal(account.limits.minAddGig, 1);
    assert.equal(account.limits.unlimitedEnabled, false);
  });

  test("unlimited needs the flag AND a price: unlimited_per_day 0 means off", async () => {
    reply = () => ok({ ...ME, limits: { ...ME.limits, unlimited_enabled: true } });
    assert.equal((await getAccount()).limits.unlimitedEnabled, false);
    reply = () => ok({ ...ME, prices: { ...ME.prices, unlimited_per_day: 3000 } });
    assert.equal((await getAccount()).limits.unlimitedEnabled, false);
    reply = () => ok({ ...ME, prices: { ...ME.prices, unlimited_per_day: 3000 }, limits: { ...ME.limits, unlimited_enabled: true } });
    assert.equal((await getAccount()).limits.unlimitedEnabled, true);
  });

  test("a me answer with no usable prices is an error, not zeros", async () => {
    reply = () => ok({ balance: 1 });
    await assert.rejects(() => getAccount(), (e) => e.code === "invalid_price_response");
  });

  test("status is GET /status; its ping is in seconds", async () => {
    reply = () => ok({ per_gb: 1500, per_day: 500, system: "connected", ping: 0.01 });
    const status = await StatusApi();
    assert.deepEqual([last().method, last().path], ["GET", "/api/v1/status"]);
    assert.equal(panelPingMs(status.result), 10);
    assert.equal(panelPingMs({}), null);
  });

  test("price is GET /price with gig and day, and gig 0 asks for unlimited", async () => {
    reply = () => ok({ gig: 20, day: 30, unlimited: false, price: 45000, balance: 1000000, enough: true });
    assert.deepEqual(await quotePrice(20, 30), { gig: 20, day: 30, unlimited: false, price: 45000, balance: 1000000, enough: true });
    assert.deepEqual(last().query, { gig: "20", day: "30" });
    reply = () => ok({ gig: 0, day: 10, unlimited: true, price: 30000, balance: 1, enough: false });
    assert.equal((await quotePrice(UNLIMITED_GIG, 10)).unlimited, true);
    assert.equal(last().query.gig, "0");
  });

  test("get_hosts keeps location names and drops node addresses", async () => {
    reply = () => ok({ "VLESS TCP REALITY": [{ id: 1, remark: "Germany", address: "de.example.com", port: 443, inbound_tag: "VLESS TCP REALITY", priority: 0, is_disabled: false }], "Trojan WS TLS": [{ id: 3, remark: "Finland", address: "fi.example.com", port: 2053, is_disabled: true }] });
    const hosts = await getHosts();
    assert.deepEqual(hosts, [{ inbound: "VLESS TCP REALITY", remark: "Germany", disabled: false }, { inbound: "Trojan WS TLS", remark: "Finland", disabled: true }]);
    assert.equal(JSON.stringify(hosts).includes("example.com"), false);
  });
});

describe("create", () => {
  test("sends test, gig and day as a form; gig may be fractional (min 0.5)", async () => {
    reply = () => ok({ ...CREATED, gig: 0.5, day: 1, service: undefined });
    await createVpnService(0.5, 1, 0);
    assert.equal(last().method, "POST");
    assert.equal(last().path, "/api/v1/create");
    assert.match(last().type, /application\/x-www-form-urlencoded/);
    assert.deepEqual(last().form, { gig: "0.5", day: "1", test: "0" });
  });

  test("gig 0 is sent as unlimited, and only a literal zero means that", async () => {
    reply = () => ok({ ...CREATED, gig: 0, gig_byte: 0, day: 10, unlimited: true, service: { ...SERVICE, unlimited: true, data_limit: 0, remaining_traffic: null } });
    const created = await createVpnService(UNLIMITED_GIG, 10, 0);
    assert.equal(last().form.gig, "0");
    assert.equal(created.service.unlimited, true);
    const before = calls.length;
    for (const blank of ["", " ", null, undefined, false, "0", [], {}]) await assert.rejects(() => createVpnService(blank, 10, 0), TypeError, JSON.stringify(blank));
    assert.equal(calls.length, before, "a blank volume never reaches the provider");
  });

  test("limits come from the document", async () => {
    for (const [gig, day] of [[0.4, 1], [10_001, 1], [-1, 5], [1, 0], [1, 3651], [1, 1.5], ["x", 1], [1, "y"], [1.234, 1]]) {
      await assert.rejects(() => createVpnService(gig, day, 0), TypeError, `${gig}/${day}`);
    }
  });

  test("a test service is create with test=1 only", async () => {
    reply = () => ok({ username: "PRG701YN2", hash: "h1", gig: 0.3, day: 1, price: 0, charged: 1500, test: 1 });
    await createTestService();
    assert.deepEqual(last().form, { test: "1" });
  });

  test("the answer carries the service object alongside its legacy fields", async () => {
    reply = () => ok(CREATED);
    const created = await createVpnService(20, 30, 0);
    assert.equal(created.result.username, "9I517RL2K");
    assert.equal(created.service.subLink, SERVICE.sub_link);
    assert.equal(created.service.expiresAt.getTime(), 1795532266_000);
  });

  test("a service created with other terms than asked is ambiguous: it exists and was charged", async () => {
    reply = () => ok({ ...CREATED, gig: 10 });
    await assert.rejects(() => createVpnService(20, 30, 0), (e) => e.code === "provisioning_terms_mismatch" && e.ambiguous === true);
    reply = () => ok({ ...CREATED, day: 1 });
    await assert.rejects(() => createVpnService(20, 30, 0), (e) => e.code === "provisioning_terms_mismatch");
    reply = () => ok({ ...CREATED, gig: 0, unlimited: true, service: { ...SERVICE, unlimited: true } });
    await assert.rejects(() => createVpnService(20, 30, 0), (e) => e.code === "provisioning_terms_mismatch", "bought volume, got unlimited");
    reply = () => ok({ ...CREATED, gig: 0, unlimited: false });
    await assert.rejects(() => createVpnService(UNLIMITED_GIG, 30, 0), (e) => e.code === "provisioning_terms_mismatch", "bought unlimited, got volume");
  });
});

describe("info and clients", () => {
  test("info is a GET with the username, and returns the service object directly in result", async () => {
    reply = () => ok(SERVICE);
    const service = await getServiceInfo("9I517RL2K");
    assert.deepEqual([last().method, last().path, last().query], ["GET", "/api/v1/info", { username: "9I517RL2K" }]);
    assert.equal(service.remainingBytes, 15 * GIB);
    assert.equal(service.live, true);
    assert.equal(service.lastClient, "v2rayNG/1.8.19");
  });

  test("an answer from the bot's stored copy is ok but not live", async () => {
    reply = () => ok({ ...SERVICE, source: "cache", links: [] });
    const service = await getServiceInfo("9I517RL2K");
    assert.deepEqual([service.live, service.source, service.links], [false, "cache", []]);
  });

  test("an info answer that is not a service is an error", async () => {
    reply = () => ok([]);
    await assert.rejects(() => getServiceInfo("9I517RL2K"), (e) => e.code === "invalid_response");
  });

  test("clients reads result.list, with total, limit and offset", async () => {
    reply = () => ok({ count: 2, total: 4, list: [{ username: "a" }, { username: "b" }] });
    const page = await listClients({ limit: 2, offset: 2 });
    assert.deepEqual(page, { count: 2, total: 4, items: [{ username: "a" }, { username: "b" }] });
    assert.equal(last().url, "/api/v1/clients?limit=2&offset=2");
    await listClients();
    assert.equal(last().url, "/api/v1/clients");
  });

  test("clients validates its paging before sending anything", async () => {
    const before = calls.length;
    for (const limit of [0, -1, 1.5, "x", 100000, "1;drop"]) await assert.rejects(() => listClients({ limit }), TypeError, String(limit));
    for (const offset of [-1, 1.5, "x"]) await assert.rejects(() => listClients({ limit: 5, offset }), TypeError, String(offset));
    assert.equal(calls.length, before);
  });

  test("a clients answer without a list is an error, not an empty account", async () => {
    reply = () => ok({ count: 0 });
    await assert.rejects(() => listClients(), (e) => e.code === "invalid_response");
  });
});

describe("normalizeService", () => {
  test("unlimited traffic has no remainder, and its zeros never read as empty", () => {
    const service = normalizeService({ ...SERVICE, unlimited: true, data_limit: 0, remaining_traffic: null, data_limit_gb: 0, remaining_traffic_gb: 0 });
    assert.deepEqual([service.unlimited, service.dataLimitBytes, service.remainingBytes, service.remainingGb], [true, 0, null, null]);
    assert.ok(service.expiresAt, "unlimited traffic still expires");
  });

  test("expire 0 means no date, not 1970", () => {
    assert.equal(normalizeService({ ...SERVICE, expire: 0 }).expiresAt, null);
  });

  test("an http link is not a subscription link", () => {
    assert.equal(normalizeService({ ...SERVICE, sub_link: "http://sub.example.com/x" }).subLink, null);
  });
});

describe("management", () => {
  test("renew sends username, gig and day, and gig 0 renews as unlimited", async () => {
    reply = () => ok({ username: "9I517RL2K", new_datalimit: 25 * GIB, new_exp: 1796396266, new_usage: 0, left_data: 15 * GIB, price: 20000, unlimited: false, service: SERVICE });
    const renewed = await renewService("9I517RL2K", 10, 10);
    assert.deepEqual([last().method, last().path, last().form], ["POST", "/api/v1/renew", { username: "9I517RL2K", gig: "10", day: "10" }]);
    assert.equal(renewed.service.username, "9I517RL2K");
    await renewService("9I517RL2K", UNLIMITED_GIG, 10);
    assert.equal(last().form.gig, "0");
    await assert.rejects(() => renewService("9I517RL2K", "", 10), TypeError);
  });

  test("upg_time adds whole days (min 1)", async () => {
    await upgradeServiceTime("svc_1", 30);
    assert.deepEqual([last().method, last().path, last().form], ["POST", "/api/v1/upg_time", { username: "svc_1", day: "30" }]);
    for (const bad of [0, -3, 1.5, "x", null, 100000]) await assert.rejects(() => upgradeServiceTime("svc_1", bad), TypeError, String(bad));
  });

  test("upg_size adds gigabytes, minimum 1 as documented", async () => {
    await upgradeServiceSize("svc_1", 1);
    assert.deepEqual([last().method, last().path, last().form], ["POST", "/api/v1/upg_size", { username: "svc_1", gig: "1" }]);
    await upgradeServiceSize("svc_1", 12.25);
    assert.equal(last().form.gig, "12.25");
    for (const bad of [0, 0.5, 0.99, -1, "x", null, 1.005, 10_001]) await assert.rejects(() => upgradeServiceSize("svc_1", bad), TypeError, String(bad));
  });

  test("reverse_mode always names the state, so a repeat cannot flip it back", async () => {
    reply = () => ok({ new_mode: "disabled", service: { ...SERVICE, status: "disabled" } });
    const answer = await setServiceStatus("svc_1", "disabled");
    assert.deepEqual([last().method, last().path, last().form], ["POST", "/api/v1/reverse_mode", { username: "svc_1", status: "disabled" }]);
    assert.equal(answer.service.status, "disabled");
    for (const bad of [undefined, "", "limited", "toggle"]) await assert.rejects(() => setServiceStatus("svc_1", bad), TypeError);
  });

  test("a reverse_mode answer naming another state is not a success", async () => {
    reply = () => ok({ new_mode: "active" });
    await assert.rejects(() => setServiceStatus("svc_1", "disabled"), (e) => e.ambiguous === true);
  });

  test("change_link is POST with the username and needs a usable new link", async () => {
    reply = () => ok({ new_sub_link: "https://sub.example.com/sub/5807", new_hash: "5807", new_uid: "3151", service: SERVICE });
    const answer = await changeLinkService("svc_1");
    assert.deepEqual([last().method, last().path, last().form], ["POST", "/api/v1/change_link", { username: "svc_1" }]);
    assert.equal(answer.result.new_sub_link, "https://sub.example.com/sub/5807");
    reply = () => ok({ new_hash: "5807" });
    await assert.rejects(() => changeLinkService("svc_1"), (e) => e.ambiguous === true, "the old link is already dead");
  });

  test("delsv reads return_price from the root of the answer", async () => {
    reply = () => ok(["successfully deleted"], { return_price: 1250, left_time_day: 1, left_data_gig: 0.5 });
    const answer = await deleteService("svc_1");
    assert.deepEqual([last().method, last().path, last().form], ["POST", "/api/v1/delsv", { username: "svc_1" }]);
    assert.deepEqual([answer.returnPrice, answer.alreadyGone], [1250, false]);
  });

  test("usernames are validated before any request is made", async () => {
    const before = calls.length;
    for (const bad of ["", "a b", "../x", "x;y", "a".repeat(200), null, 5]) {
      await assert.rejects(() => upgradeServiceTime(bad, 5), TypeError);
      await assert.rejects(() => deleteService(bad), TypeError);
      await assert.rejects(() => getServiceInfo(bad), TypeError);
    }
    assert.equal(calls.length, before);
  });
});

describe("response handling", () => {
  test("ok:false from the panel is an error with a coarse code, never the raw text", async () => {
    reply = () => ({ body: { ok: false, error: "method not found! supplier cost 4242", result: [], http_code: 404 } });
    await assert.rejects(() => getServiceInfo("svc_1"), (e) => e instanceof WizardApiError && !/4242|supplier/i.test(e.message));
  });

  test("mutations that fail with an undocumented 5xx are flagged ambiguous and never retried", async () => {
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
    await assert.rejects(() => getServiceInfo("svc_1"), (e) => !String(e.message + JSON.stringify(e)).includes(KEY));
  });
});

describe("timeouts", () => {
  test("the document asks for at least 60 seconds on calls that change a service", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("../../api/wizardApi.js", import.meta.url), "utf8");
    assert.match(source, /MUTATION_TIMEOUT_MS = 60_000/);
  });
});
