/**
 * WizardXray live-status normalization and fallback (services/wizardServiceStatus.js), the read layer behind «سرویس‌های من».
 *
 * The panel is the source of truth for live state; the DB record is only a fallback. These tests pin the defensive parsing so a
 * hostile or partial panel payload can never crash the user-facing view, and that anything old is flagged as not live.
 */
import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

delete process.env.WIZARD_API_URL;
delete process.env.VPN_API_KEY;

const {
  statusLabel,
  normalizeServiceResult,
  fallbackFromDbRecord,
  getServiceLiveStatus,
  invalidateServiceStatus,
  resetWizardStatusCacheForTests,
} = await import("../../services/wizardServiceStatus.js");

beforeEach(() => {
  resetWizardStatusCacheForTests();
});

/** The document's own example of `info`: a 20 GB service with 5 GB used. */
const INFO = {
  username: "9I517RL2K",
  status: "active",
  source: "panel",
  test: false,
  unlimited: false,
  sub_link: "https://sub.example.com/sub/88a7dabc5c6c41e7a33ed372dd1a15c6",
  links: ["vless://x@de.example.com:443#Germany"],
  expire: 1795532266,
  expire_jalali: "1405/9/3 18:27",
  days_left: 30,
  data_limit: 21474836480,
  used_traffic: 5368709120,
  remaining_traffic: 16106127360,
  data_limit_gb: 20,
  used_traffic_gb: 5,
  remaining_traffic_gb: 15,
};
const UNLIMITED = { ...INFO, username: "F3O1KH6ZP", unlimited: true, data_limit: 0, remaining_traffic: null, data_limit_gb: 0, remaining_traffic_gb: 0, used_traffic: 5368709120, used_traffic_gb: 5, days_left: 9.5 };

describe("statusLabel", () => {
  test("maps every documented status to a Persian label", () => {
    assert.match(statusLabel("active"), /فعال/);
    assert.match(statusLabel("Disabled"), /غیرفعال/);
    assert.match(statusLabel("limited"), /حجم تمام شده/);
    assert.match(statusLabel("expired"), /منقضی/);
    assert.match(statusLabel("on_hold"), /اولین اتصال/);
  });

  test("unknown or missing status → explicit «نامشخص» label, never a crash", () => {
    assert.match(statusLabel("weird-new-status"), /نامشخص/);
    assert.match(statusLabel(null), /نامشخص/);
    assert.match(statusLabel(""), /نامشخص/);
  });
});

describe("normalizeServiceResult", () => {
  test("reads the documented service object, not derived guesses", () => {
    const view = normalizeServiceResult(INFO);
    assert.equal(view.username, "9I517RL2K");
    assert.equal(view.status, "active");
    assert.equal(view.totalGbText, "20");
    assert.equal(view.usedGbText, "5");
    assert.equal(view.remainingGbText, "15");
    assert.equal(view.usagePercent, 25);
    assert.equal(view.daysLeft, 30);
    assert.equal(view.expireDate, "1405/9/3 18:27");
    assert.equal(view.smartLink, INFO.sub_link);
    assert.equal(view.live, true);
  });

  test("300 MB used reads as 0.29 GB, not 300 GB", () => {
    // `find` reports usage as Persian text ("300 مگابایت"), which used to be parsed as gigabytes and read as an exhausted plan.
    const view = normalizeServiceResult({ ...INFO, used_traffic: 322122547, used_traffic_gb: 0.3, remaining_traffic_gb: 19.7 });
    assert.equal(view.usedGbText, "0.3");
    assert.equal(view.remainingGbText, "19.7");
    assert.equal(view.usagePercent, 2);
  });

  test("days left is what remains, not what was bought", () => {
    assert.equal(normalizeServiceResult({ ...INFO, days_left: 3.25 }).daysLeft, 3.25);
  });

  test("usage percent is clamped to 0–100", () => {
    assert.equal(normalizeServiceResult({ ...INFO, used_traffic_gb: 80 }).usagePercent, 100);
  });

  test("an unlimited service has no total, no remainder and no percentage, and still has an expiry", () => {
    const view = normalizeServiceResult(UNLIMITED);
    assert.equal(view.unlimited, true);
    assert.equal(view.totalGbText, null);
    assert.equal(view.remainingGbText, null);
    assert.equal(view.usagePercent, null);
    assert.equal(view.usedGbText, "5");
    assert.equal(view.expireDate, "1405/9/3 18:27");
    assert.equal(view.daysLeft, 9.5);
  });

  test("`data_limit: 0` alone means unlimited, for rows that predate the flag", () => {
    const { unlimited: _ignored, ...legacy } = UNLIMITED;
    assert.equal(normalizeServiceResult(legacy).unlimited, true);
  });

  test("the panel's stored copy is not live", () => {
    assert.equal(normalizeServiceResult({ ...INFO, source: "cache", links: [] }).live, false);
    assert.equal(normalizeServiceResult({ ...INFO, source: undefined }).live, false);
  });

  test("null/non-object payloads → null (never a crash)", () => {
    assert.equal(normalizeServiceResult(null), null);
    assert.equal(normalizeServiceResult(undefined), null);
    assert.equal(normalizeServiceResult("text"), null);
    assert.equal(normalizeServiceResult({}), null); // no username → not a service
    assert.equal(normalizeServiceResult({ username: "   " }), null); // blank username
  });
});

describe("fallbackFromDbRecord", () => {
  test("builds a clearly non-live view from the stored record", () => {
    const inThirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const view = fallbackFromDbRecord({ username: "stored_user", trafficGb: 100, expiresAt: new Date(inThirtyDays), sub_link: "https://s.example/x" });
    assert.equal(view.username, "stored_user");
    assert.equal(view.live, false);
    assert.equal(view.fallbackReason, "panel_unreachable");
    assert.equal(view.totalGbText, "100");
    assert.equal(view.smartLink, "https://s.example/x");
    assert.ok(view.daysLeft >= 29 && view.daysLeft <= 31, `daysLeft≈30, got ${view.daysLeft}`);
    assert.ok(typeof view.expireDate === "string" && view.expireDate.includes("/"), `fa-IR locale date, got ${view.expireDate}`);
  });

  test("a stored volume of 0 is unlimited; a record with no volume is not", () => {
    assert.equal(fallbackFromDbRecord({ username: "u", trafficGb: 0 }).unlimited, true);
    assert.equal(fallbackFromDbRecord({ username: "u", trafficGb: 0 }).totalGbText, null);
    assert.equal(fallbackFromDbRecord({ username: "u", trafficGb: null }).unlimited, false);
    assert.equal(fallbackFromDbRecord({ username: "u" }).unlimited, false);
  });

  test("missing record → null; partial records stay display-safe", () => {
    assert.equal(fallbackFromDbRecord(null), null);
    const view = fallbackFromDbRecord({ username: "u" }, { reason: "timeout" });
    assert.equal(view.live, false);
    assert.equal(view.fallbackReason, "timeout");
    assert.equal(view.daysLeft, null);
    assert.equal(view.expireDate, null);
  });
});

describe("getServiceLiveStatus without a panel", () => {
  test("invalid usernames are rejected before any panel call", async () => {
    for (const bad of ["", "has space", "x".repeat(200), "../etc/passwd", null, 42]) {
      const result = await getServiceLiveStatus(bad);
      assert.equal(result.ok, false);
      assert.equal(result.live, false);
      assert.equal(result.errorCode, "invalid_username");
    }
  });

  test("panel unavailability degrades to a non-live result instead of throwing", async () => {
    // WIZARD_API_URL is deleted above, so the panel client refuses to run.
    const result = await getServiceLiveStatus("swift_user");
    assert.equal(result.ok, false);
    assert.equal(result.live, false);
    assert.equal(result.data, null);
    assert.equal(typeof result.errorCode, "string");
  });
});

describe("getServiceLiveStatus against a panel", () => {
  let server;
  let reply;
  let requests = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      requests += 1;
      const { status = 200, body } = reply(req);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}/`;
    process.env.VPN_API_KEY = "unit-key-not-real";
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.WIZARD_API_URL;
    delete process.env.VPN_API_KEY;
  });
  beforeEach(() => { requests = 0; reply = () => ({ body: { ok: true, error: "", result: INFO, http_code: 200 } }); });

  test("a live answer is cached, and a change forgets it", async () => {
    await getServiceLiveStatus("9I517RL2K");
    assert.equal((await getServiceLiveStatus("9I517RL2K")).cached, true);
    assert.equal(requests, 1);
    reply = () => ({ body: { ok: true, error: "", result: { ...INFO, sub_link: "https://sub.example.com/sub/new" }, http_code: 200 } });
    invalidateServiceStatus("9I517RL2K");
    assert.equal((await getServiceLiveStatus("9I517RL2K")).data.smartLink, "https://sub.example.com/sub/new");
  });

  test("a lookup already on its way cannot refill the cache after a change", async () => {
    const pending = getServiceLiveStatus("9I517RL2K");
    invalidateServiceStatus("9I517RL2K");
    await pending;
    reply = () => ({ body: { ok: true, error: "", result: { ...INFO, status: "disabled" }, http_code: 200 } });
    assert.equal((await getServiceLiveStatus("9I517RL2K")).data.status, "disabled");
  });

  test("the panel's stored copy is shown but never cached, so the next look tries again", async () => {
    reply = () => ({ body: { ok: true, error: "", result: { ...INFO, source: "cache", links: [] }, http_code: 200 } });
    const first = await getServiceLiveStatus("9I517RL2K");
    assert.deepEqual([first.ok, first.live], [true, false]);
    await getServiceLiveStatus("9I517RL2K");
    assert.equal(requests, 2);
  });

  test("a service the panel does not have is reported as missing, not as an outage", async () => {
    reply = () => ({ status: 404, body: { ok: false, error: "service not found!", result: [], http_code: 404 } });
    assert.equal((await getServiceLiveStatus("9I517RL2K")).errorCode, "service_not_found_on_panel");
  });

  test("fresh skips the cache: a switch must act on the real state", async () => {
    await getServiceLiveStatus("9I517RL2K");
    await getServiceLiveStatus("9I517RL2K", { fresh: true });
    assert.equal(requests, 2);
  });
});
