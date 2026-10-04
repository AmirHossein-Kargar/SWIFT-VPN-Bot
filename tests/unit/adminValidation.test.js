/**
 * Admin validation helpers — input hardening for every admin API route.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  parsePositiveInteger,
  requireTelegramId,
  requireServiceUsername,
  requireReason,
  escapeRegex,
  parsePagination,
} = await import("../../services/admin/validation.js");

describe("parsePositiveInteger", () => {
  test("accepts safe integers within bounds", () => {
    assert.equal(parsePositiveInteger("42"), 42);
    assert.equal(parsePositiveInteger(1000, { min: 1, max: 2000 }), 1000);
  });
  test("rejects non-numeric, fractional and out-of-range values", () => {
    for (const bad of ["abc", "", "1.5", "-3", "9999999999999999999", "12,000", null, undefined]) {
      assert.throws(() => parsePositiveInteger(bad), /whole number/, `should reject ${JSON.stringify(bad)}`);
    }
    assert.throws(() => parsePositiveInteger("5", { max: 4 }), /whole number/);
  });

  test("scientific notation resolves to its integer value when in range", () => {
    assert.equal(parsePositiveInteger("1e3"), 1000);
    assert.throws(() => parsePositiveInteger("1e18", { max: 1_000_000 }), /whole number/);
  });
});

describe("requireTelegramId", () => {
  test("accepts real-shaped Telegram IDs", () => {
    assert.equal(requireTelegramId("424242"), "424242");
    assert.equal(requireTelegramId(123456789), "123456789");
  });
  test("rejects malformed IDs", () => {
    for (const bad of ["0123", "-5", "abc", "", "12 34", "99999999999999999999"]) {
      assert.throws(() => requireTelegramId(bad), /valid Telegram user ID/, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("requireServiceUsername", () => {
  test("accepts WizardXray-safe usernames only", () => {
    assert.equal(requireServiceUsername("user_01.vless-2"), "user_01.vless-2");
    assert.throws(() => requireServiceUsername("has space"), /valid VPN service ID/);
    assert.throws(() => requireServiceUsername("x".repeat(200)), /valid VPN service ID/);
  });
});

describe("requireReason", () => {
  test("enforces length bounds and strips control characters", () => {
    assert.equal(requireReason("maintenance window"), "maintenance window");
    assert.equal(requireReason("a\u0000b", { min: 1 }), "a b");
    assert.throws(() => requireReason("short", { min: 6 }), /between 6 and/);
    assert.throws(() => requireReason("x".repeat(300)), /between 5 and 240/);
  });
});

describe("escapeRegex", () => {
  test("escapes regex metacharacters", () => {
    const escaped = escapeRegex("a.b*c(d)e");
    assert.equal(new RegExp(`^${escaped}$`).test("a.b*c(d)e"), true);
    assert.equal(new RegExp(`^${escaped}$`).test("axbycde"), false);
  });
});

describe("parsePagination", () => {
  test("clamps hostile pagination input", () => {
    assert.deepEqual(parsePagination({ page: "-3", pageSize: "9999" }), { page: 1, pageSize: 100 });
    assert.deepEqual(parsePagination({ page: "2", pageSize: "25" }), { page: 2, pageSize: 25 });
    assert.deepEqual(parsePagination({}), { page: 1, pageSize: 25 });
    assert.deepEqual(parsePagination({ page: NaN, pageSize: NaN }), { page: 1, pageSize: 25 });
  });
});
