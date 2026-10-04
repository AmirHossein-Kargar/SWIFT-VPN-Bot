/**
 * WizardXray live-status normalization and fallback
 * (services/wizardServiceStatus.js) — the read layer behind «سرویس‌های من».
 *
 * The panel is the source of truth for live state; the DB record is only a
 * fallback. These tests pin the defensive parsing so a hostile or partial
 * panel payload can never crash the user-facing view, and that a fallback is
 * clearly flagged as non-live.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

delete process.env.WIZARD_API_URL;
delete process.env.VPN_API_KEY;

const {
  parseSizeToGb,
  statusLabel,
  normalizeServiceResult,
  fallbackFromDbRecord,
  getServiceLiveStatus,
  resetWizardStatusCacheForTests,
} = await import("../../services/wizardServiceStatus.js");

beforeEach(() => {
  resetWizardStatusCacheForTests();
});

describe("parseSizeToGb", () => {
  test("parses plain numbers, GB/MB/TB/KB units and thousands separators", () => {
    assert.equal(parseSizeToGb(50), 50);
    assert.equal(parseSizeToGb("50"), 50);
    assert.equal(parseSizeToGb("1.5 GB"), 1.5);
    assert.equal(parseSizeToGb("700 MB"), 700 / 1024);
    assert.equal(parseSizeToGb("2 TB"), 2048);
    assert.equal(parseSizeToGb("1,024 MB"), 1);
  });

  test("returns null for garbage instead of NaN", () => {
    for (const bad of [null, undefined, "", "abc", "GB", {}, NaN, Infinity]) {
      const value = parseSizeToGb(bad);
      assert.ok(value == null || Number.isFinite(value), `must stay finite for ${JSON.stringify(bad)}`);
    }
  });
});

describe("statusLabel", () => {
  test("maps known panel statuses to Persian labels", () => {
    assert.match(statusLabel("active"), /فعال/);
    assert.match(statusLabel("Disabled"), /غیرفعال/);
    assert.match(statusLabel("limited"), /محدود/);
  });

  test("unknown or missing status → explicit «نامشخص» label, never a crash", () => {
    assert.match(statusLabel("weird-new-status"), /نامشخص/);
    assert.match(statusLabel(null), /نامشخص/);
    assert.match(statusLabel(""), /نامشخص/);
  });
});

describe("normalizeServiceResult", () => {
  const payload = {
    username: "swift_user",
    hash: "abc123",
    online_info: { status: "active", usage: "12.5" },
    latest_info: { gig: "50 GB", day: 21, expire_date: "2026-10-25", usage_converted: "12.5" },
  };

  test("normalizes a full panel payload into display-safe fields", () => {
    const view = normalizeServiceResult(payload);
    assert.equal(view.username, "swift_user");
    assert.equal(view.status, "active");
    assert.match(view.statusLabel, /فعال/);
    assert.equal(view.totalGbText, "50");
    assert.equal(view.usedGbText, "12.5");
    assert.equal(view.remainingGbText, "37.5");
    assert.equal(view.usagePercent, 25);
    assert.equal(view.daysLeft, 21);
    assert.equal(view.expireDate, "2026-10-25");
    assert.equal(view.smartLink, "https://iranisystem.com/bot/sub/?hash=abc123");
    assert.equal(view.live, true);
  });

  test("usage percent is clamped to 0–100; unparsable usage stays null", () => {
    const over = normalizeServiceResult({
      username: "u",
      online_info: { status: "active", usage: "80" },
      latest_info: { gig: "50 GB", day: 1 },
    });
    assert.equal(over.usagePercent, 100);
    // Negative usage cannot be parsed as a size — every derived field must
    // degrade to null rather than producing a nonsense number.
    const negative = normalizeServiceResult({
      username: "u",
      online_info: { status: "active", usage: "-5" },
      latest_info: { gig: "50 GB" },
    });
    assert.equal(negative.usagePercent, null);
    assert.equal(negative.remainingGbText, null);
    assert.equal(negative.usedGbText, null);
    assert.equal(negative.totalGbText, "50");
  });

  test("sub_link is used when the panel provides no hash", () => {
    const view = normalizeServiceResult({
      username: "u",
      sub_link: "https://panel.example.com/sub/xyz",
      online_info: { status: "active" },
      latest_info: { gig: "10" },
    });
    assert.equal(view.smartLink, "https://panel.example.com/sub/xyz");
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

  test("missing record → null; partial records stay display-safe", () => {
    assert.equal(fallbackFromDbRecord(null), null);
    const view = fallbackFromDbRecord({ username: "u" }, { reason: "timeout" });
    assert.equal(view.live, false);
    assert.equal(view.fallbackReason, "timeout");
    assert.equal(view.daysLeft, null);
    assert.equal(view.expireDate, null);
  });
});

describe("getServiceLiveStatus", () => {
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
